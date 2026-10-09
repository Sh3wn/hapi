import { describe, expect, it } from 'vitest'
import { parseDirectoryListing } from './directory-listing'

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