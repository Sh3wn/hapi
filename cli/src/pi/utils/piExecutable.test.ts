import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolvePiCommand } from './piExecutable'

async function makeExecutable(directory: string, name: string): Promise<string> {
    const path = join(directory, name)
    await writeFile(path, '#!/bin/sh\nexit 0\n')
    await chmod(path, 0o755)
    return path
}

describe('resolvePiCommand', () => {
    it('prefers the canonical pi binary over the omp alias', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-pi-path-'))
        await makeExecutable(directory, 'pi')
        await makeExecutable(directory, 'omp')

        expect(resolvePiCommand({ PATH: directory })).toBe('pi')
    })

    it('falls back to the omp alias so an OMP-only machine can start Pi sessions', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-pi-path-'))
        await makeExecutable(directory, 'omp')

        expect(resolvePiCommand({ PATH: directory })).toBe('omp')
    })

    it('uses HAPI_PI_PATH as-is and ignores a blank override', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-pi-path-'))
        const custom = await makeExecutable(directory, 'pi-custom')
        await makeExecutable(directory, 'pi')

        expect(resolvePiCommand({ PATH: directory, HAPI_PI_PATH: custom })).toBe(custom)
        expect(resolvePiCommand({ PATH: directory, HAPI_PI_PATH: '   ' })).toBe('pi')
    })

    it('keeps the canonical name when no Pi binary is on PATH', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-pi-path-'))

        expect(resolvePiCommand({ PATH: directory })).toBe('pi')
        expect(resolvePiCommand({ PATH: '' })).toBe('pi')
    })
})