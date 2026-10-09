import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createGitRoutes } from './git'

function buildApp(engine: Partial<SyncEngine>): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createGitRoutes(() => engine as SyncEngine))
    return app
}

describe('generated images route', () => {
    it('serves generated images with an immutable cache header instead of no-store', async () => {
        const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedImage: async () => ({
                success: true,
                content: pngBytes.toString('base64'),
                mimeType: 'image/png',
                fileName: 'shot.png'
            })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/generated-images/img-1')

        expect(response.status).toBe(200)
        const cacheControl = response.headers.get('cache-control') ?? ''
        // Generated images are content-addressed by an immutable random id, so they must be
        // cacheable; `no-store` forces a full RPC round-trip on every remount (issue #927).
        expect(cacheControl).toContain('immutable')
        expect(cacheControl).not.toContain('no-store')
        expect(response.headers.get('etag')).toBe('"img-1"')
    })

    it('returns 304 without an RPC round-trip when If-None-Match matches', async () => {
        const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session
        let rpcCalls = 0
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedImage: async () => {
                rpcCalls += 1
                return { success: true, content: '', mimeType: 'image/png', fileName: 'shot.png' }
            }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/generated-images/img-1', {
            headers: { 'if-none-match': '"img-1"' }
        })

        expect(response.status).toBe(304)
        // The whole point: a cache hit must not touch the CLI over the socket.
        expect(rpcCalls).toBe(0)
    })

    it('serves audio inline and generic files as downloads with nosniff', async () => {
        const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session
        let mimeType = 'audio/wav'
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedImage: async () => ({
                success: true,
                content: Buffer.from('media').toString('base64'),
                mimeType,
                fileName: mimeType === 'audio/wav' ? 'sample.wav' : 'archive.bin'
            })
        } as unknown as Partial<SyncEngine>

        const audio = await buildApp(engine).request('/api/sessions/session-1/generated-images/audio-1')
        expect(audio.headers.get('content-disposition')).toStartWith('inline;')
        expect(audio.headers.get('x-content-type-options')).toBe('nosniff')

        mimeType = 'application/octet-stream'
        const file = await buildApp(engine).request('/api/sessions/session-1/generated-images/file-1')
        expect(file.headers.get('content-disposition')).toStartWith('attachment;')
        expect(file.headers.get('content-type')).toContain('application/octet-stream')
    })
})

describe('file search route', () => {
    it('normalizes Windows path separators in search queries before invoking ripgrep', async () => {
        const session = {
            id: 'session-1',
            namespace: 'default',
            active: true,
            metadata: { path: 'C:\\project' }
        } as unknown as Session
        let ripgrepArgs: string[] = []
        let fileSearchQuery: string | undefined
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            runRipgrep: async (_sessionId: string, args: string[], _cwd: string, fileSearch?: { query: string }) => {
                ripgrepArgs = args
                fileSearchQuery = fileSearch?.query
                return { success: true, stdout: 'src/nested/file.ts\n' }
            },
            statFiles: async (_sessionId: string, paths: string[]) => ({
                success: true,
                entries: paths.map((path) => ({ path, size: 10, modified: 100 }))
            })
        } as unknown as Partial<SyncEngine>

        const query = new URLSearchParams({ query: 'src\\nested\\file.ts' }).toString()
        const response = await buildApp(engine).request(`/api/sessions/session-1/files?${query}`)

        expect(response.status).toBe(200)
        expect(ripgrepArgs).toEqual(['--files', '--iglob', '*src/nested/file.ts*'])
        expect(fileSearchQuery).toBe('src/nested/file.ts')
    })

    it('preserves backslashes in POSIX search queries', async () => {
        const session = {
            id: 'session-1',
            namespace: 'default',
            active: true,
            metadata: { path: '/project' }
        } as unknown as Session
        let ripgrepArgs: string[] = []
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            runRipgrep: async (_sessionId: string, args: string[]) => {
                ripgrepArgs = args
                return { success: true, stdout: 'src/file\\name.ts\n' }
            },
            statFiles: async (_sessionId: string, paths: string[]) => ({
                success: true,
                entries: paths.map((path) => ({ path, size: 10, modified: 100 }))
            })
        } as unknown as Partial<SyncEngine>

        const query = new URLSearchParams({ query: 'src\\file\\name.ts' }).toString()
        const response = await buildApp(engine).request(`/api/sessions/session-1/files?${query}`)

        expect(response.status).toBe(200)
        expect(ripgrepArgs).toEqual(['--files', '--iglob', '*src\\\\file\\\\name.ts*'])
    })

    it('uses shared matching semantics for plain and wildcard queries', async () => {
        const session = {
            id: 'session-1',
            namespace: 'default',
            active: true,
            metadata: { path: '/project' }
        } as unknown as Session
        const ripgrepArgs: string[][] = []
        const fileSearchOptions: Array<{ query: string; limit: number }> = []
        const stdout = [
            'src/file.ts',
            'other.ts',
            'test-AB',
            '!literal.ts',
            '[ab]literal.ts',
            '{a,b}literal.ts',
            'notes.txt'
        ].join('\n')
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            runRipgrep: async (_sessionId: string, args: string[], _cwd: string, fileSearch?: { query: string; limit: number }) => {
                ripgrepArgs.push(args)
                if (fileSearch) fileSearchOptions.push(fileSearch)
                return { success: true, stdout }
            },
            statFiles: async (_sessionId: string, paths: string[]) => ({
                success: true,
                entries: paths.map((path) => ({ path, size: 1, modified: 1 }))
            })
        } as unknown as Partial<SyncEngine>

        const app = buildApp(engine)
        const queries: Array<[string, string[]]> = [
            ['.txt', ['notes.txt']],
            ['*.ts', ['src/file.ts', 'other.ts', '!literal.ts', '[ab]literal.ts', '{a,b}literal.ts']],
            ['test-%3F%3F', ['test-AB']],
            ['%21*.ts', ['!literal.ts']],
            ['%5Bab%5D*.ts', ['[ab]literal.ts']],
            ['%7Ba%2Cb%7D*.ts', ['{a,b}literal.ts']],
            ['src*.ts', ['src/file.ts']]
        ]

        for (const [query, expected] of queries) {
            const response = await app.request(`/api/sessions/session-1/files?query=${query}`)
            expect(response.status).toBe(200)
            const body = await response.json() as { files: Array<{ fullPath: string }> }
            expect(body.files.map((file) => file.fullPath)).toEqual(expected)
        }

        expect(ripgrepArgs).toEqual([
            ['--files', '--iglob', '*.txt*'],
            ['--files'],
            ['--files'],
            ['--files'],
            ['--files'],
            ['--files'],
            ['--files']
        ])
        expect(fileSearchOptions).toEqual([
            { query: '.txt', limit: 200 },
            { query: '*.ts', limit: 200 },
            { query: 'test-??', limit: 200 },
            { query: '!*.ts', limit: 200 },
            { query: '[ab]*.ts', limit: 200 },
            { query: '{a,b}*.ts', limit: 200 },
            { query: 'src*.ts', limit: 200 }
        ])
    })

    it('adds size and modification metadata to search results', async () => {
        const session = {
            id: 'session-1',
            namespace: 'default',
            active: true,
            metadata: { path: '/project' }
        } as unknown as Session
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            runRipgrep: async () => ({
                success: true,
                stdout: 'src/large.txt\nsrc/small.txt\n'
            }),
            statFiles: async (_sessionId: string, paths: string[]) => ({
                success: true,
                entries: paths.map((path, index) => ({ path, size: index ? 10 : 500, modified: index ? 100 : 200 }))
            })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/files?query=.txt')
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            success: true,
            files: [
                { fileName: 'large.txt', filePath: 'src', fullPath: 'src/large.txt', fileType: 'file', size: 500, modified: 200 },
                { fileName: 'small.txt', filePath: 'src', fullPath: 'src/small.txt', fileType: 'file', size: 10, modified: 100 },
            ]
        })
    })

    it('normalizes ripgrep path separators before deriving file names and directories', async () => {
        const session = {
            id: 'session-1',
            namespace: 'default',
            active: true,
            metadata: { path: 'C:\\project' }
        } as unknown as Session
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            runRipgrep: async () => ({
                success: true,
                stdout: 'src\\nested\\file.ts\nroot.ts\n'
            }),
            statFiles: async (_sessionId: string, paths: string[]) => ({
                success: true,
                entries: paths.map((path) => ({ path, size: 10, modified: 100 }))
            })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/files?query=.ts')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            success: true,
            files: [
                { fileName: 'file.ts', filePath: 'src/nested', fullPath: 'src/nested/file.ts', fileType: 'file', size: 10, modified: 100 },
                { fileName: 'root.ts', filePath: '', fullPath: 'root.ts', fileType: 'file', size: 10, modified: 100 },
            ]
        })
    })

    it('preserves backslashes in file names for non-Windows sessions', async () => {
        const session = {
            id: 'session-1',
            namespace: 'default',
            active: true,
            metadata: { path: '/project' }
        } as unknown as Session
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            runRipgrep: async () => ({
                success: true,
                stdout: 'src/file\\name.ts\n'
            }),
            statFiles: async (_sessionId: string, paths: string[]) => ({
                success: true,
                entries: paths.map((path) => ({ path, size: 10, modified: 100 }))
            })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/files?query=.ts')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            success: true,
            files: [
                { fileName: 'file\\name.ts', filePath: 'src', fullPath: 'src/file\\name.ts', fileType: 'file', size: 10, modified: 100 },
            ]
        })
    })
})

// A submodule is a directory in the work tree but one gitlink commit to the
// session repo, so its own changes are invisible to git running in the session
// root. These routes rebase the submodule's records onto the session root so
// clients that cannot ask for the submodule root (hosted web, installed apps)
// still see what changed inside it.
describe('submodule-aware git routes', () => {
    const session = {
        id: 'session-1',
        namespace: 'default',
        active: true,
        metadata: { path: '/repo' }
    } as unknown as Session

    const gitmodules = {
        success: true,
        content: Buffer.from('[submodule "sub"]\n\tpath = sub\n\turl = ./sub.git\n').toString('base64')
    }

    function engineWith(overrides: Partial<SyncEngine>): Partial<SyncEngine> {
        return {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readSessionFile: async () => gitmodules,
            ...overrides
        } as unknown as Partial<SyncEngine>
    }

    it('appends the submodule own status records, rebased onto the session root', async () => {
        const engine = engineWith({
            getGitStatus: async (_sessionId: string, cwd?: string) => cwd === '/repo'
                ? {
                    success: true,
                    stdout: '# branch.head main\n1 .M S.MU 160000 160000 160000 aaa bbb sub\n'
                }
                : {
                    success: true,
                    stdout: '# branch.head EDA_contest\n'
                        + '1 .M N... 100644 100644 100644 ccc ddd OpenROAD-GRT/README.md\n'
                        + '2 .M N... 100644 100644 100644 eee fff R100 old.cpp\tnew.cpp\n'
                        + '? PlacementTiming3D.cpp\n'
                }
        } as unknown as Partial<SyncEngine>)

        const response = await buildApp(engine).request('/api/sessions/session-1/git-status')
        const body = await response.json() as { success: boolean; stdout: string }

        expect(body.success).toBe(true)
        expect(body.stdout.split('\n').filter(Boolean)).toEqual([
            '# branch.head main',
            '1 .M S.MU 160000 160000 160000 aaa bbb sub',
            '1 .M N... 100644 100644 100644 ccc ddd sub/OpenROAD-GRT/README.md',
            '2 .M N... 100644 100644 100644 eee fff R100 sub/old.cpp\tsub/new.cpp',
            '? sub/PlacementTiming3D.cpp'
        ])
    })

    it('rebases the submodule numstat on the requested diff side', async () => {
        const calls: Array<{ cwd?: string; staged?: boolean }> = []
        const engine = engineWith({
            getGitDiffNumstat: async (_sessionId: string, options: { cwd?: string; staged?: boolean }) => {
                calls.push(options)
                return options.cwd === '/repo'
                    ? { success: true, stdout: '0\t0\tsub\n' }
                    : { success: true, stdout: '2\t1\tOpenROAD-GRT/README.md\n' }
            }
        } as unknown as Partial<SyncEngine>)

        const response = await buildApp(engine).request('/api/sessions/session-1/git-diff-numstat?staged=true')
        const body = await response.json() as { success: boolean; stdout: string }

        expect(body.stdout).toBe('0\t0\tsub\n2\t1\tsub/OpenROAD-GRT/README.md\n')
        expect(calls).toEqual([
            { cwd: '/repo', staged: true },
            { cwd: '/repo/sub', staged: true }
        ])
    })

    it('diffs a file inside a submodule from the submodule root', async () => {
        const calls: Array<{ cwd?: string; filePath: string; staged?: boolean }> = []
        const engine = engineWith({
            getGitDiffFile: async (_sessionId: string, options: { cwd?: string; filePath: string; staged?: boolean }) => {
                calls.push(options)
                return { success: true, stdout: 'diff --git a/OpenROAD-GRT/README.md b/OpenROAD-GRT/README.md\n' }
            }
        } as unknown as Partial<SyncEngine>)

        const response = await buildApp(engine).request('/api/sessions/session-1/git-diff-file?path=sub%2FOpenROAD-GRT%2FREADME.md')
        const body = await response.json() as { success: boolean; stdout: string }

        expect(body.stdout).toContain('diff --git a/OpenROAD-GRT/README.md')
        expect(calls).toEqual([{ cwd: '/repo/sub', filePath: 'OpenROAD-GRT/README.md', staged: undefined }])
    })

    it('diffs the gitlink itself from the session root', async () => {
        const calls: Array<{ cwd?: string; filePath: string; staged?: boolean }> = []
        const engine = engineWith({
            getGitDiffFile: async (_sessionId: string, options: { cwd?: string; filePath: string; staged?: boolean }) => {
                calls.push(options)
                return { success: true, stdout: 'Submodule sub contains modified content\n' }
            }
        } as unknown as Partial<SyncEngine>)

        await buildApp(engine).request('/api/sessions/session-1/git-diff-file?path=sub')

        expect(calls).toEqual([{ cwd: '/repo', filePath: 'sub', staged: undefined }])
    })

    it('leaves the parent records untouched when the session repo has no submodules', async () => {
        let statusCalls = 0
        const engine = engineWith({
            readSessionFile: async () => ({ success: false, error: 'File not found' }),
            getGitStatus: async () => {
                statusCalls += 1
                return { success: true, stdout: '# branch.head main\n' }
            }
        } as unknown as Partial<SyncEngine>)

        const response = await buildApp(engine).request('/api/sessions/session-1/git-status')

        expect(await response.json()).toEqual({ success: true, stdout: '# branch.head main\n' })
        expect(statusCalls).toBe(1)
    })

    it('skips a submodule whose own status cannot be read', async () => {
        const engine = engineWith({
            getGitStatus: async (_sessionId: string, cwd?: string) => {
                if (cwd === '/repo') {
                    return { success: true, stdout: '1 .M S.MU 160000 160000 160000 aaa bbb sub\n' }
                }
                throw new Error('fatal: not a git repository')
            }
        } as unknown as Partial<SyncEngine>)

        const response = await buildApp(engine).request('/api/sessions/session-1/git-status')
        const body = await response.json() as { success: boolean; stdout: string }

        expect(body).toEqual({ success: true, stdout: '1 .M S.MU 160000 160000 160000 aaa bbb sub\n' })
    })
})
