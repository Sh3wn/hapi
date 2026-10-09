import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import { formatFileMetadata } from '@/lib/file-metadata'
import { encodeBase64 } from '@/lib/utils'
import FilePage from './file'

const goBackMock = vi.fn()
const copyMock = vi.hoisted(() => vi.fn())
const navigateMock = vi.hoisted(() => vi.fn())
const apiMock = vi.hoisted(() => ({
    getGitDiffFile: vi.fn(),
    readSessionFile: vi.fn(),
}))
const searchMock = vi.hoisted(() => ({
    current: { path: '', staged: undefined as boolean | undefined },
}))

const sampleMarkdown = '# Heading\n\n| Col A | Col B |\n| --- | --- |\n| one | two |'
const filePath = 'docs/README.md'
const encodedPath = encodeBase64(filePath)
const encodedContent = encodeBase64(sampleMarkdown)
const fileSize = 1024
const fileModified = 1_784_175_060_000

vi.mock('@tanstack/react-router', () => ({
    useParams: () => ({ sessionId: 'session-1' }),
    useSearch: () => searchMock.current,
    useNavigate: () => navigateMock,
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ api: apiMock }),
}))

vi.mock('@/hooks/useAppGoBack', () => ({
    useAppGoBack: () => goBackMock,
}))

vi.mock('@/hooks/useCopyToClipboard', () => ({
    useCopyToClipboard: () => ({
        copied: false,
        copy: copyMock,
    }),
}))

vi.mock('@/lib/shiki', () => ({
    langAlias: { md: 'markdown' },
    useShikiHighlighter: (content: string) => content,
}))

vi.mock('@/components/MarkdownRenderer', () => ({
    MarkdownRenderer: (props: { content: string }) => (
        <div data-testid="markdown-preview">{props.content}</div>
    ),
}))

function renderWithProviders() {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
        },
    })
    return render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <FilePage />
            </I18nProvider>
        </QueryClientProvider>
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    window.sessionStorage.clear()
    searchMock.current = { path: encodedPath, staged: undefined }
    apiMock.getGitDiffFile.mockResolvedValue({ success: true, stdout: '' })
    apiMock.readSessionFile.mockResolvedValue({
        success: true,
        content: encodedContent,
        size: fileSize,
        modified: fileModified,
    })
})

describe('FilePage markdown preview', () => {

    it('renders markdown preview by default and toggles to source', async () => {
        renderWithProviders()

        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toHaveTextContent('# Heading')
        })
        expect(screen.getByText(formatFileMetadata(fileSize, fileModified, 'en')!)).toBeInTheDocument()
        expect(screen.getAllByText(filePath)).toHaveLength(1)
        const previewCopyButton = screen.getByRole('button', { name: 'Copy file content' })
        expect(previewCopyButton.closest('[data-hapi-file-content-header="true"]')).not.toBeNull()
        expect(previewCopyButton).not.toHaveClass('absolute')
        fireEvent.click(previewCopyButton)
        expect(copyMock).toHaveBeenCalledWith(sampleMarkdown)
        expect(screen.getByRole('button', { name: 'Preview' })).toHaveClass('opacity-80')

        fireEvent.click(screen.getByRole('button', { name: 'Source' }))

        await waitFor(() => {
            expect(screen.getByRole('code')).toHaveTextContent('# Heading')
        })
        const sourcePreview = screen.getByRole('code').closest('[data-hapi-file-source-preview="true"]')
        const sourceCopyButton = screen.getByRole('button', { name: 'Copy file content' })
        expect(sourcePreview).not.toBeNull()
        expect(sourcePreview).toContainElement(sourceCopyButton)
        expect(sourceCopyButton.closest('[data-hapi-file-content-header="true"]')).not.toBeNull()
        expect(sourceCopyButton).not.toHaveClass('absolute')
        expect(screen.queryByTestId('markdown-preview')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toBeInTheDocument()
        })
    })

    it('uses the shared code-wrap preference for the source preview', async () => {
        window.localStorage.setItem('hapi-code-wrap', '1')
        renderWithProviders()

        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toBeInTheDocument()
        })
        fireEvent.click(screen.getByRole('button', { name: 'Source' }))

        await waitFor(() => {
            expect(screen.getByRole('code')).toHaveTextContent('# Heading')
        })
        const sourceCode = screen.getByRole('code')
        const sourcePre = sourceCode.closest('pre')
        const wrapToggle = screen.getByRole('button', { pressed: true })

        expect(wrapToggle).toBeInTheDocument()
        expect(sourcePre).toHaveStyle({ whiteSpace: 'pre-wrap', wordBreak: 'break-word' })

        fireEvent.click(wrapToggle)

        expect(screen.getByRole('button', { pressed: false })).toBeInTheDocument()
        expect(sourcePre).toHaveStyle({ whiteSpace: 'pre' })
        expect(window.localStorage.getItem('hapi-code-wrap')).toBeNull()
    })

    it('preserves the file preview scroll position across route remounts', async () => {
        const firstRender = renderWithProviders()

        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toBeInTheDocument()
        })
        const firstScrollRegion = document.querySelector('[data-hapi-file-scroll="true"]') as HTMLElement
        expect(firstScrollRegion).not.toBeNull()
        firstScrollRegion.scrollTop = 123
        firstRender.unmount()

        renderWithProviders()
        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toBeInTheDocument()
        })
        const secondScrollRegion = document.querySelector('[data-hapi-file-scroll="true"]') as HTMLElement
        expect(secondScrollRegion.scrollTop).toBe(123)
    })
})

describe('FilePage directory listing', () => {
    const directoryPath = 'Open3DBench'
    const directoryEntries = 'bin/\nOpenROAD-GRT/\nREADME.md\n'

    function useDirectory(directory = true) {
        searchMock.current = { path: encodeBase64(directoryPath), staged: undefined }
        apiMock.readSessionFile.mockResolvedValue({
            success: true,
            content: encodeBase64(directoryEntries),
            size: directoryEntries.length,
            modified: fileModified,
            ...(directory ? { directory: true } : {}),
        })
    }

    it('lists the entries of a directory and opens an entry one level deeper', async () => {
        useDirectory()
        renderWithProviders()

        await waitFor(() => {
            expect(screen.getByText('OpenROAD-GRT/')).toBeInTheDocument()
        })
        expect(screen.getByText('bin/')).toBeInTheDocument()
        expect(screen.getByText('README.md')).toBeInTheDocument()
        // A byte size is meaningless for a directory, so the header only shows when it changed.
        expect(screen.getByText(formatFileMetadata(undefined, fileModified, 'en')!)).toBeInTheDocument()

        fireEvent.click(screen.getByText('OpenROAD-GRT/'))

        expect(navigateMock).toHaveBeenCalledWith({
            to: '/sessions/$sessionId/file',
            params: { sessionId: 'session-1' },
            search: { path: encodeBase64(`${directoryPath}/OpenROAD-GRT`) },
        })
    })

    it('opens a file from a listing on its diff instead of keeping the folder view', async () => {
        useDirectory()
        const view = renderWithProviders()

        await waitFor(() => {
            expect(screen.getByText('bin/')).toBeInTheDocument()
        })

        const innerPath = `${directoryPath}/OpenROAD-GRT/README.md`
        searchMock.current = { path: encodeBase64(innerPath), staged: undefined }
        apiMock.getGitDiffFile.mockResolvedValue({
            success: true,
            stdout: 'diff --git a/OpenROAD-GRT/README.md b/OpenROAD-GRT/README.md\n@@ -1 +1 @@\n-one\n+two\n',
        })
        apiMock.readSessionFile.mockResolvedValue({
            success: true,
            content: encodeBase64('two\n'),
            size: 4,
            modified: fileModified,
        })
        view.rerender(
            <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
                <I18nProvider>
                    <FilePage />
                </I18nProvider>
            </QueryClientProvider>
        )

        await waitFor(() => {
            expect(screen.getByText('diff --git a/OpenROAD-GRT/README.md b/OpenROAD-GRT/README.md')).toBeInTheDocument()
        })
        expect(screen.queryByText('bin/')).not.toBeInTheDocument()
    })
})
