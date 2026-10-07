import { resolveExecutable } from '@/agent/agentLaunchCommand'

type LaunchEnvironment = Record<string, string | undefined>

/**
 * Binary names that ship the same Pi coding agent.
 *
 * `@oh-my-pi/pi-coding-agent` publishes its CLI as `omp` only, so a machine
 * that installed OMP has no `pi` on PATH even though it is the identical agent:
 * `omp --mode rpc` answers the same `ready`/protocol handshake, loads the
 * `--extension` file the launcher passes, and serves the same RPC commands the
 * Pi session uses. Without this alias such a machine reports Pi as `not_found`
 * in the create-session form and cannot start Pi sessions at all.
 */
const PI_COMMANDS = ['pi', 'omp'] as const

const DEFAULT_PI_COMMAND = PI_COMMANDS[0]

/**
 * Resolves the Pi CLI to the name that will be spawned: `HAPI_PI_PATH` wins,
 * then the canonical `pi`, then the aliases above. Falls back to `pi` when
 * nothing is on PATH so the availability preflight can report the canonical
 * name as missing instead of an alias.
 *
 * Returns the command *name* rather than an absolute path: every call site
 * spawns with the process environment, matching what `resolveExecutable` just
 * probed. The availability preflight and the launchers share this function so
 * the agent shown as available is the agent that gets started.
 */
export function resolvePiCommand(env: LaunchEnvironment = process.env): string {
    const configured = env.HAPI_PI_PATH?.trim()
    if (configured) return configured
    for (const command of PI_COMMANDS) {
        const resolved = resolveExecutable(command, { pathValue: env.PATH, pathExt: env.PATHEXT })
        if (resolved) return command
    }
    return DEFAULT_PI_COMMAND
}