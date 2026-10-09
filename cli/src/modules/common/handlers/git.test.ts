import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RpcHandlerManager } from '../../../api/rpc/RpcHandlerManager'
import { registerGitHandlers } from './git'

describe('git RPC handlers', () => {
    const temps: string[] = []
    let mainRepo: string
    let rpc: RpcHandlerManager

    beforeEach(() => {
        mainRepo = tempDir('hapi-git-handler-main-')
        rpc = new RpcHandlerManager({ scopePrefix: 'session-test' })
        registerGitHandlers(rpc, mainRepo)
    })

    afterEach(() => {
        for (const dir of temps.splice(0)) {
            try {
                rmSync(dir, { recursive: true, force: true })
            } catch {
                // best-effort cleanup
            }
        }
    })

    function tempDir(prefix: string): string {
        const dir = mkdtempSync(join(tmpdir(), prefix))
        temps.push(dir)
        return dir
    }

    function git(cwd: string, args: string[]): void {
        execFileSync('git', args, {
            cwd,
            stdio: ['ignore', 'ignore', 'pipe'],
            env: {
                ...process.env,
                GIT_AUTHOR_NAME: 'test',
                GIT_AUTHOR_EMAIL: 'test@example.com',
                GIT_COMMITTER_NAME: 'test',
                GIT_COMMITTER_EMAIL: 'test@example.com'
            }
        })
    }

    /** Main repo with a checked-out `sub` submodule whose work tree is dirty. */
    function repoWithDirtySubmodule(): void {
        const subRepo = tempDir('hapi-git-handler-sub-')
        git(subRepo, ['init'])
        writeFileSync(join(subRepo, 'file.txt'), 'one\n')
        git(subRepo, ['add', 'file.txt'])
        git(subRepo, ['commit', '-m', 'init'])

        git(mainRepo, ['init'])
        writeFileSync(join(mainRepo, 'README'), 'main\n')
        git(mainRepo, ['add', 'README'])
        git(mainRepo, ['commit', '-m', 'init'])
        git(mainRepo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', subRepo, 'sub'])
        git(mainRepo, ['commit', '-m', 'add sub'])

        appendFileSync(join(mainRepo, 'sub', 'file.txt'), 'two\n')
    }

    async function diffFile(filePath: string, staged = false): Promise<{ success: boolean; stdout?: string; error?: string }> {
        const response = await rpc.handleRequest({
            method: 'session-test:git-diff-file',
            params: JSON.stringify({ cwd: mainRepo, filePath, staged })
        })
        return JSON.parse(response) as { success: boolean; stdout?: string; error?: string }
    }

    it('expands a dirty submodule into its inner file diff', async () => {
        repoWithDirtySubmodule()

        const parsed = await diffFile('sub')

        expect(parsed.success).toBe(true)
        expect(parsed.stdout).toContain('Submodule sub contains modified content')
        expect(parsed.stdout).toContain('diff --git a/sub/file.txt b/sub/file.txt')
        expect(parsed.stdout).toContain('+two')
    })

    it('leaves an ordinary file diff unchanged', async () => {
        git(mainRepo, ['init'])
        writeFileSync(join(mainRepo, 'README'), 'main\n')
        git(mainRepo, ['add', 'README'])
        git(mainRepo, ['commit', '-m', 'init'])
        appendFileSync(join(mainRepo, 'README'), 'more\n')

        const parsed = await diffFile('README')

        expect(parsed.success).toBe(true)
        expect(parsed.stdout).toContain('diff --git a/README b/README')
        expect(parsed.stdout).toContain('+more')
    })
})