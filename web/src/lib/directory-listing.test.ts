import { describe, expect, it } from 'vitest'
import { isPathInChangeSet, joinListedPath, parseDirectoryListing } from './directory-listing'

describe('parseDirectoryListing', () => {
    it('marks trailing-slash entries as directories', () => {
        expect(parseDirectoryListing('src/\nREADME.md\n')).toEqual([
            { name: 'src', type: 'directory' },
            { name: 'README.md', type: 'file' },
        ])
    })

    it('returns an empty list for an empty directory instead of null', () => {
        expect(parseDirectoryListing('')).toEqual([])
    })

    it('ignores blank and padded lines', () => {
        expect(parseDirectoryListing('\n  lib/  \n\n')).toEqual([{ name: 'lib', type: 'directory' }])
    })
})
describe('joinListedPath', () => {
    it('joins inside a directory', () => {
        expect(joinListedPath('Open3DBench', 'README.md')).toBe('Open3DBench/README.md')
    })

    it('keeps a root listing bare', () => {
        expect(joinListedPath('', 'README.md')).toBe('README.md')
    })

    it('tolerates a trailing slash', () => {
        expect(joinListedPath('src/', 'lib')).toBe('src/lib')
    })
})

describe('isPathInChangeSet', () => {
    const changed = new Set(['Open3DBench/README.md', 'docs/plans/plan.md', 'tmp'])

    it('matches a changed file', () => {
        expect(isPathInChangeSet('Open3DBench/README.md', changed)).toBe(true)
    })

    it('matches a directory that contains a change', () => {
        expect(isPathInChangeSet('Open3DBench', changed)).toBe(true)
        expect(isPathInChangeSet('docs/plans', changed)).toBe(true)
    })

    it('rejects an unchanged sibling', () => {
        expect(isPathInChangeSet('Open3DBench/OpenROAD-GRT', changed)).toBe(false)
        expect(isPathInChangeSet('Open3DBench/README.rej', changed)).toBe(false)
    })

    it('does not treat a name prefix as containment', () => {
        expect(isPathInChangeSet('tmp', changed)).toBe(true)
        expect(isPathInChangeSet('tmpx', changed)).toBe(false)
    })
})
