import { describe, expect, it } from 'vitest'
import { usageDayKey } from './usage-day'

describe('usageDayKey', () => {
    it('formats a UTC day', () => {
        expect(usageDayKey(Date.parse('2026-10-10T02:00:00Z'), 'UTC')).toBe('2026-10-10')
    })

    it('uses the requested time zone at the midnight boundary', () => {
        // 2026-10-09T20:00Z is already 2026-10-10 in Shanghai.
        expect(usageDayKey(Date.parse('2026-10-09T20:00:00Z'), 'Asia/Shanghai')).toBe('2026-10-10')
        expect(usageDayKey(Date.parse('2026-10-09T20:00:00Z'), 'UTC')).toBe('2026-10-09')
    })

    it('pads single-digit months and days', () => {
        expect(usageDayKey(Date.parse('2026-01-05T12:00:00Z'), 'UTC')).toBe('2026-01-05')
    })

    it('matches the hub bucket key for a dense instant', () => {
        const now = Date.now()
        expect(usageDayKey(now, 'UTC')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(usageDayKey(now, 'Asia/Shanghai')).toBe(usageDayKey(now, 'Asia/Shanghai'))
    })
})