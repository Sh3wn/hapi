import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import SettingsUsagePage from './usage'

function bucket(key: string, totalTokens: number) {
    return {
        key,
        inputTokens: totalTokens,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens,
        uncachedTokens: totalTokens,
        requests: 1,
    }
}

const getUsageSummary = vi.fn()

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ api: { getUsageSummary } }),
}))

function renderPage() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <SettingsUsagePage />
            </I18nProvider>
        </QueryClientProvider>,
    )
}

describe('SettingsUsagePage', () => {
    it('offers the today range when the hub applies it', async () => {
        getUsageSummary.mockImplementation(async (range: string) => ({
            range: { key: range, from: 1, to: 2 },
            totals: bucket('totals', 10).valueOf() as never,
            daily: [bucket('2026-10-10', 10)],
            byAgent: [],
            byModel: [],
            updatedAt: 2,
        }))

        renderPage()

        await waitFor(() => expect(screen.getByRole('radio', { name: 'Today' })).toBeInTheDocument())
        expect(screen.queryByText(/does not support that range/i)).not.toBeInTheDocument()
    })

    it('drops a range the hub ignored instead of relabelling its numbers', async () => {
        // An older hub answers any unknown range with its 7 day default.
        getUsageSummary.mockImplementation(async () => ({
            range: { key: '7d', from: 1, to: 2 },
            totals: bucket('totals', 999).valueOf() as never,
            daily: [bucket('2026-10-10', 999)],
            byAgent: [],
            byModel: [],
            updatedAt: 2,
        }))

        renderPage()

        const today = await screen.findByRole('radio', { name: 'Today' })
        today.click()

        await waitFor(() => expect(screen.getByText(/does not support that range/i)).toBeInTheDocument())
        await waitFor(() => expect(screen.queryByRole('radio', { name: 'Today' })).not.toBeInTheDocument())
        expect(screen.getByRole('radio', { name: '7 days' })).toHaveAttribute('aria-checked', 'true')
    })
})