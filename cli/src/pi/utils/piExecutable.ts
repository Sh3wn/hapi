import type { PiFamilyFlavor } from '@hapi/protocol'

type LaunchEnvironment = Record<string, string | undefined>

/**
 * Launcher + override per Pi-family flavor. The two flavors are separate
 * products with separate release lines, so neither may stand in for the other:
 *
 * - `pi`  — `@mariozechner/pi-coding-agent` (badlogic/pi-mono), binary `pi`
 * - `omp` — `@oh-my-pi/pi-coding-agent` (can1357/oh-my-pi), binary `omp`
 *
 * Resolving `omp` for a Pi session used to paper over an omp-only machine, but
 * the binaries diverge (omp rejects `--no-prompt-templates` and reports
 * thinking levels as `thinking.efforts`, not `thinkingLevelMap`), so a session
 * labelled Pi silently ran a different agent.
 *
 * Returns the command *name* rather than an absolute path: every call site
 * spawns with the process environment, matching what `resolveExecutable` probes
 * in the availability preflight so the agent shown as available is the agent
 * that gets started.
 */
const PI_FAMILY_COMMANDS: Record<PiFamilyFlavor, { command: string; pathEnv: string }> = {
    pi: { command: 'pi', pathEnv: 'HAPI_PI_PATH' },
    omp: { command: 'omp', pathEnv: 'HAPI_OMP_PATH' },
}

export function resolvePiFamilyCommand(
    flavor: PiFamilyFlavor = 'pi',
    env: LaunchEnvironment = process.env,
): string {
    const spec = PI_FAMILY_COMMANDS[flavor]
    return env[spec.pathEnv]?.trim() || spec.command
}