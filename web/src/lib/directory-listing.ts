import type { DirectoryEntry } from '@/types/api'

/**
 * Parse the entry listing the read-file RPC returns for a directory: one entry
 * per line, directories carrying a trailing `/`. An empty listing is a real
 * result (an empty directory), not a missing one, so callers must treat `[]`
 * differently from the `null` they use for "this path is not a directory".
 */
export function parseDirectoryListing(content: string): DirectoryEntry[] {
    return content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => line.endsWith('/')
            ? { name: line.slice(0, -1), type: 'directory' as const }
            : { name: line, type: 'file' as const })
}

/** Full path of an entry listed inside `directory` (an empty base means the session root). */
export function joinListedPath(directory: string, name: string): string {
    return directory ? `${directory.replace(/\/+$/, '')}/${name}` : name
}

/**
 * Whether `path` belongs to the change set: it is a changed path itself or the
 * directory above one. The folder view is reached from the change list, so
 * unchanged siblings of a change must stay out of it.
 */
export function isPathInChangeSet(path: string, changedPaths: ReadonlySet<string>): boolean {
    if (changedPaths.has(path)) return true
    const prefix = `${path}/`
    for (const changed of changedPaths) {
        if (changed.startsWith(prefix)) return true
    }
    return false
}