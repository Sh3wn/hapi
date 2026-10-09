import { Hono } from 'hono'
import { isWildcardSearch, matchesSearchQuery, toSearchGlob } from '@hapi/protocol'
import { z } from 'zod'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

const fileSearchSchema = z.object({
    query: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional()
})

const directorySchema = z.object({
    path: z.string().optional()
})

const filePathSchema = z.object({
    path: z.string().min(1)
})

const generatedImageSchema = z.object({
    imageId: z.string().min(1)
})

function normalizeFileSearchPath(path: string): string {
    return path.replaceAll('\\', '/')
}

function isWindowsSessionPath(path: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

function parseBooleanParam(value: string | undefined): boolean | undefined {
    if (value === 'true') return true
    if (value === 'false') return false
    return undefined
}

async function runRpc<T>(fn: () => Promise<T>): Promise<T | { success: false; error: string }> {
    try {
        return await fn()
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
}

// ---------------------------------------------------------- submodules --
//
// A submodule is a directory in the work tree but is tracked as a single
// gitlink commit, so git in the session root reports one row for it and prints
// nothing for the files inside it. Clients that read `git-status` /
// `git-diff-numstat` / `git-diff-file` (web, native) therefore cannot see what
// changed inside a submodule, and neither the hosted web frontend nor an
// installed app can be changed to ask for the submodule root itself. Answer as
// if the submodule's own repository were part of the session: rebase its
// records onto the session root and run per-file diffs with the submodule as
// the working directory.

/** Submodule work-tree roots declared by the session repo's `.gitmodules`. */
async function readSubmoduleRoots(engine: SyncEngine, sessionId: string, sessionPath: string): Promise<string[]> {
    const result = await runRpc(() => engine.readSessionFile(sessionId, '.gitmodules'))
    if ('success' in result && result.success === false) {
        return []
    }
    if (!result.success || !result.content) {
        return []
    }
    const text = Buffer.from(result.content, 'base64').toString('utf8')
    const roots: string[] = []
    for (const line of text.split('\n')) {
        const match = /^\s*path\s*=\s*(.+?)\s*$/.exec(line)
        if (match?.[1]) {
            roots.push(match[1].replaceAll('\\', '/'))
        }
    }
    return roots
}

function joinSessionPath(sessionPath: string, relative: string): string {
    const separator = isWindowsSessionPath(sessionPath) ? '\\' : '/'
    return `${sessionPath.replace(/[\\/]+$/, '')}${separator}${relative.replaceAll('/', separator)}`
}

/**
 * Deepest declared submodule root that contains `filePath`, or null when the
 * path is the gitlink itself (or outside every submodule).
 */
function submoduleForPath(filePath: string, roots: string[]): { root: string; relative: string } | null {
    const normalized = filePath.replaceAll('\\', '/')
    let best: { root: string; relative: string } | null = null
    for (const root of roots) {
        const prefix = `${root}/`
        if (!normalized.startsWith(prefix)) continue
        if (!best || root.length > best.root.length) {
            best = { root, relative: normalized.slice(prefix.length) }
        }
    }
    return best
}

/** Rebase one porcelain-v2 record (excluding `#` headers) onto the session root. */
function prefixPorcelainRecord(line: string, root: string): string | null {
    const kind = line[0]
    const fieldCount = kind === '1' ? 8 : kind === '2' ? 9 : kind === 'u' ? 10 : kind === '?' || kind === '!' ? 1 : 0
    if (fieldCount === 0) {
        return null
    }
    const parts = line.split(' ')
    if (parts.length < fieldCount + 1) {
        return null
    }
    const head = parts.slice(0, fieldCount).join(' ')
    const payload = line.slice(head.length + 1)
    const fields = payload.split('\t')
    return `${head} ${fields.map((field) => `${root}/${field}`).join('\t')}`
}

/** Rebase one `git diff --numstat` line onto the session root. */
function prefixNumstatLine(line: string, root: string): string | null {
    const match = /^(\S+)\t(\S+)\t(.+)$/.exec(line)
    return match ? `${match[1]}\t${match[2]}\t${root}/${match[3]}` : null
}

type GitCommandResponse = { success?: boolean; stdout?: string; stderr?: string; exitCode?: number; error?: string }

/**
 * Collect each submodule's own records, rebased onto the session root, so the
 * session's change list shows what changed inside the submodule. Clean
 * submodules contribute nothing, and an uninitialized one is skipped.
 */
async function collectSubmoduleLines(
    engine: SyncEngine,
    sessionId: string,
    sessionPath: string,
    command: 'status' | 'numstat',
    staged: boolean | undefined,
    rebase: (line: string, root: string) => string | null
): Promise<string[]> {
    const roots = await readSubmoduleRoots(engine, sessionId, sessionPath)
    const lines: string[] = []
    for (const root of roots) {
        const cwd = joinSessionPath(sessionPath, root)
        const inner = await runRpc(() => command === 'status'
            ? engine.getGitStatus(sessionId, cwd)
            : engine.getGitDiffNumstat(sessionId, { cwd, staged }))
        if (!inner.success || !inner.stdout) {
            continue
        }
        for (const line of inner.stdout.split('\n')) {
            // The submodule's own `# branch.*` headers describe the submodule repo.
            if (line.length === 0 || line.startsWith('#')) {
                continue
            }
            const rebased = rebase(line, root)
            if (rebased) {
                lines.push(rebased)
            }
        }
    }
    return lines
}

function appendRecords(parent: GitCommandResponse, extra: string[]): GitCommandResponse {
    if (extra.length === 0) {
        return parent
    }
    return { ...parent, stdout: `${(parent.stdout ?? '').replace(/\n?$/, '\n')}${extra.join('\n')}\n` }
}

// Generated-image bytes for a given id never change, so they are cached for a year as immutable.
const GENERATED_IMAGE_CACHE_CONTROL = 'private, max-age=31536000, immutable'

// Weak comparison of an If-None-Match header against our ETag (handles lists, `*`, and W/ prefixes).
function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
    if (!header) {
        return false
    }
    const normalized = etag.replace(/^W\//, '')
    return header.split(',').some((candidate) => {
        const trimmed = candidate.trim()
        return trimmed === '*' || trimmed.replace(/^W\//, '') === normalized
    })
}

export function createGitRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/sessions/:id/git-status', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const sessionId = sessionResult.sessionId
        const result = await runRpc(() => engine.getGitStatus(sessionId, sessionPath))
        if (result.success !== true) {
            return c.json(result)
        }
        const extra = await collectSubmoduleLines(engine, sessionId, sessionPath, 'status', undefined, prefixPorcelainRecord)
        return c.json(appendRecords(result, extra))
    })

    app.get('/sessions/:id/git-diff-numstat', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const staged = parseBooleanParam(c.req.query('staged'))
        const sessionId = sessionResult.sessionId
        const result = await runRpc(() => engine.getGitDiffNumstat(sessionId, { cwd: sessionPath, staged }))
        if (result.success !== true) {
            return c.json(result)
        }
        const extra = await collectSubmoduleLines(engine, sessionId, sessionPath, 'numstat', staged, prefixNumstatLine)
        return c.json(appendRecords(result, extra))
    })

    app.get('/sessions/:id/git-diff-file', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const parsed = filePathSchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid file path' }, 400)
        }

        const staged = parseBooleanParam(c.req.query('staged'))
        const sessionId = sessionResult.sessionId
        const roots = await readSubmoduleRoots(engine, sessionId, sessionPath)
        const inner = submoduleForPath(parsed.data.path, roots)
        const result = await runRpc(() => inner
            ? engine.getGitDiffFile(sessionId, {
                cwd: joinSessionPath(sessionPath, inner.root),
                filePath: inner.relative,
                staged
            })
            : engine.getGitDiffFile(sessionId, {
                cwd: sessionPath,
                filePath: parsed.data.path,
                staged
            }))
        return c.json(result)
    })

    app.get('/sessions/:id/file', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const parsed = filePathSchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid file path' }, 400)
        }

        const result = await runRpc(() => engine.readSessionFile(sessionResult.sessionId, parsed.data.path))
        return c.json(result)
    })

    app.get('/sessions/:id/generated-images/:imageId', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const parsed = generatedImageSchema.safeParse(c.req.param())
        if (!parsed.success) {
            return c.json({ error: 'Invalid generated image id' }, 400)
        }

        // The id is an immutable content fingerprint, so it doubles as the ETag. If the client
        // already holds it, answer 304 *before* the RPC so revalidation skips the CLI round-trip
        // entirely (and still works even if the image was evicted from CLI memory). Issue #927.
        const etag = `"${parsed.data.imageId}"`
        if (ifNoneMatchMatches(c.req.header('if-none-match'), etag)) {
            return c.body(null, 304, {
                'Cache-Control': GENERATED_IMAGE_CACHE_CONTROL,
                ETag: etag
            })
        }

        const result = await runRpc(() => engine.readGeneratedImage(sessionResult.sessionId, parsed.data.imageId))
        if (!result.success || !result.content) {
            return c.json({ success: false, error: result.error ?? 'Generated image not found' }, 404)
        }

        const bytes = Uint8Array.from(Buffer.from(result.content, 'base64'))
        const mimeType = result.mimeType ?? 'application/octet-stream'
        const disposition = !result.mimeType || mimeType.startsWith('image/') || mimeType.startsWith('video/') || mimeType.startsWith('audio/')
            ? 'inline'
            : 'attachment'
        // Generated images are content-addressed by an immutable random id, so the bytes for a
        // given id never change. Cache aggressively so remounts/scroll/session reopen don't
        // re-run the full HTTP -> socket.io RPC -> base64 round-trip every time (issue #927).
        return c.body(bytes, 200, {
            'Content-Type': mimeType,
            'Content-Disposition': `${disposition}; filename="${encodeURIComponent(result.fileName ?? 'generated-media')}"`,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': GENERATED_IMAGE_CACHE_CONTROL,
            ETag: etag
        })
    })

    app.get('/sessions/:id/files', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const parsed = fileSearchSchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query' }, 400)
        }

        const query = parsed.data.query?.trim() ?? ''
        // ripgrep's gitignore-style globs use '/' as the path separator even on Windows.
        // Accept the native separator users see in Windows paths before building the glob.
        const normalizedQuery = isWindowsSessionPath(sessionPath)
            ? normalizeFileSearchPath(query)
            : query
        const limit = parsed.data.limit ?? 200
        const args = ['--files']
        if (normalizedQuery && !isWildcardSearch(normalizedQuery)) {
            args.push('--iglob', toSearchGlob(normalizedQuery))
        }

        const result = await runRpc(() => engine.runRipgrep(
            sessionResult.sessionId,
            args,
            sessionPath,
            { query: normalizedQuery, limit }
        ))
        if (!result.success) {
            return c.json({ success: false, error: result.error ?? 'Failed to list files' })
        }

        const stdout = result.stdout ?? ''
        const normalizePath = isWindowsSessionPath(sessionPath)
            ? normalizeFileSearchPath
            : (path: string) => path
        const paths = stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map(normalizePath)
            .filter((path) => !normalizedQuery || matchesSearchQuery(path, normalizedQuery))
            .slice(0, limit)

        const metadataResult = await runRpc(() => engine.statFiles(sessionResult.sessionId, paths))
        const metadataByPath = new Map(
            metadataResult.success
                ? (metadataResult.entries ?? []).map((entry) => [entry.path, entry] as const)
                : []
        )

        const files = paths.map((fullPath) => {
            const parts = fullPath.split('/')
            const fileName = parts[parts.length - 1] || fullPath
            const filePath = parts.slice(0, -1).join('/')
            const metadata = metadataByPath.get(fullPath)
            return {
                fileName,
                filePath,
                fullPath,
                fileType: 'file' as const,
                size: metadata?.size,
                modified: metadata?.modified
            }
        })

        return c.json({ success: true, files })
    })

    app.get('/sessions/:id/directory', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const parsed = directorySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query' }, 400)
        }

        const path = parsed.data.path ?? ''
        const result = await runRpc(() => engine.listDirectory(sessionResult.sessionId, path))
        return c.json(result)
    })

    return app
}
