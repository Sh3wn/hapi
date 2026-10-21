import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolvePiFamilyCommand } from './piExecutable'

async function makeExecutable(directory: string, name: string): Promise<string> {
    const path = join(directory, name)
    await writeFile(path, '#!/bin/sh\nexit 0\n')
    await chmod(path, 0o755)
    return path
}

describe('resolvePiFamilyCommand', () => {
    it('resolves each flavor to its own binary', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-pi-path-'))
        await makeExecutable(directory, 'pi')
        await makeExecutable(directory, 'omp')

        expect(resolvePiFamilyCommand('pi', { PATH: directory })).toBe('pi')
        expect(resolvePiFamilyCommand('omp', { PATH: directory })).toBe('omp')
    })

    it('never substitutes the other flavor when its own binary is missing', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-pi-path-'))
        await makeExecutable(directory, 'omp')

        expect(resolvePiFamilyCommand('pi', { PATH: directory })).toBe('pi')
        expect(resolvePiFamilyCommand('omp', { PATH: '' })).toBe('omp')
    })

    it('honors the per-flavor path override and ignores a blank one', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-pi-path-'))
        const customPi = await makeExecutable(directory, 'pi-custom')
        const customOmp = await makeExecutable(directory, 'omp-custom')

        expect(resolvePiFamilyCommand('pi', { PATH: directory, HAPI_PI_PATH: customPi })).toBe(customPi)
        expect(resolvePiFamilyCommand('omp', { PATH: directory, HAPI_OMP_PATH: customOmp })).toBe(customOmp)
        expect(resolvePiFamilyCommand('pi', { PATH: directory, HAPI_PI_PATH: '   ' })).toBe('pi')
        expect(resolvePiFamilyCommand('omp', { PATH: directory, HAPI_OMP_PATH: '   ' })).toBe('omp')
        // An override for one flavor must not leak into the other.
        expect(resolvePiFamilyCommand('omp', { PATH: directory, HAPI_PI_PATH: customPi })).toBe('omp')
    })
})