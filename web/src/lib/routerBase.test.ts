import { describe, expect, it } from 'vitest'
import { routerBasepathFromBase } from './routerBase'

describe('routerBasepathFromBase', () => {
    it('returns / for the root base', () => {
        expect(routerBasepathFromBase('/')).toBe('/')
    })

    it('strips the trailing slash of a subpath base', () => {
        expect(routerBasepathFromBase('/hapi/')).toBe('/hapi')
    })

    it('accepts a base without a trailing slash', () => {
        expect(routerBasepathFromBase('/hapi')).toBe('/hapi')
    })

    it('falls back to / for an empty or unset base', () => {
        expect(routerBasepathFromBase('')).toBe('/')
        expect(routerBasepathFromBase(undefined)).toBe('/')
    })
})