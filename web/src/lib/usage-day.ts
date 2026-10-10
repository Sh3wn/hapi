/**
 * Usage days are keyed by the viewer's local calendar day, and the hub buckets
 * `daily` with the exact same formatter (hub `usageService.createDayFormatter`):
 * `en-CA` + ISO calendar yields `YYYY-MM-DD`. Keep both sides in sync — the
 * usage page picks today's bucket out of `daily` by this key.
 */

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
    const cached = formatterCache.get(timeZone)
    if (cached) return cached
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        calendar: 'iso8601',
        numberingSystem: 'latn',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    })
    formatterCache.set(timeZone, formatter)
    return formatter
}

/** `YYYY-MM-DD` day bucket key for `timestamp` in `timeZone`. */
export function usageDayKey(timestamp: number, timeZone: string): string {
    const parts = dayFormatter(timeZone).formatToParts(new Date(timestamp))
    const year = parts.find((part) => part.type === 'year')?.value
    const month = parts.find((part) => part.type === 'month')?.value
    const day = parts.find((part) => part.type === 'day')?.value
    if (!year || !month || !day) throw new Error('Failed to format usage day')
    return `${year}-${month}-${day}`
}