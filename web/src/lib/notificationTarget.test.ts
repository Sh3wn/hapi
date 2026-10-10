import { describe, expect, it } from 'vitest'
import { resolveNotificationUrl } from './notificationTarget'

const ROOT_SCOPE = 'https://hapi.example.com/'
const BASE_SCOPE = 'https://sh3wn.github.io/hapi/'

describe('resolveNotificationUrl', () => {
    it('keeps a session path inside a sub-path deployment', () => {
        expect(resolveNotificationUrl('/sessions/abc', BASE_SCOPE)).toBe('https://sh3wn.github.io/hapi/sessions/abc')
    })

    it('keeps a session path at the origin root', () => {
        expect(resolveNotificationUrl('/sessions/abc', ROOT_SCOPE)).toBe('https://hapi.example.com/sessions/abc')
    })

    it('accepts a path without a leading slash', () => {
        expect(resolveNotificationUrl('sessions/abc', BASE_SCOPE)).toBe('https://sh3wn.github.io/hapi/sessions/abc')
    })

    it('opens the app root when the payload has no url', () => {
        expect(resolveNotificationUrl(undefined, BASE_SCOPE)).toBe(BASE_SCOPE)
        expect(resolveNotificationUrl('   ', BASE_SCOPE)).toBe(BASE_SCOPE)
    })

    it('uses the fallback asset for notification icons', () => {
        expect(resolveNotificationUrl(undefined, BASE_SCOPE, 'pwa-192x192.png')).toBe('https://sh3wn.github.io/hapi/pwa-192x192.png')
    })

    it('leaves absolute and protocol-relative urls alone', () => {
        expect(resolveNotificationUrl('https://hub.example.com/sessions/abc', BASE_SCOPE)).toBe('https://hub.example.com/sessions/abc')
        expect(resolveNotificationUrl('//hub.example.com/sessions/abc', BASE_SCOPE)).toBe('//hub.example.com/sessions/abc')
    })
})