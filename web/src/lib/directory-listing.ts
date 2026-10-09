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