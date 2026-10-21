import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isObject } from '@hapi/protocol';
import { logger } from '@/ui/logger';
import { JsonLineParser } from '@/utils/jsonLineParser';
import { PiAgentEventSchema } from './schemas';
import { PiRpcChunkDecoder } from './rpcChunkDecoder';
import type { PiAgentEvent, PiRpcCommand } from './types';

export interface PiTransportOptions {
    command: string;
    args: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
}

export class PiTransport extends JsonLineParser {
    private process: ChildProcessWithoutNullStreams | null = null;
    private eventHandler: ((event: PiAgentEvent) => void) | null = null;
    private closeHandler: ((code: number | null, signal: string | null) => void) | null = null;
    private errorHandler: ((error: Error) => void) | null = null;
    private killed = false;
    private started = false;
    private exited = false;
    private closeReported = false;
    private readonly chunkDecoder = new PiRpcChunkDecoder();
    private negotiationId: string | null = null;
    private negotiationRequested = false;
    private protocolVersion: 1 | 2 = 1;
    private readonly options: PiTransportOptions;

    constructor(options: PiTransportOptions) {
        super();
        this.options = options;
    }

    start(): void {
        if (this.started) {
            logger.warn('[pi] PiTransport.start() called twice — ignoring');
            return;
        }
        this.started = true;

        logger.debug(`[pi] Starting Pi process: ${this.options.command} ${this.options.args.join(' ')}`);

        this.process = spawn(this.options.command, this.options.args, {
            cwd: this.options.cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: this.options.env
        }) as ChildProcessWithoutNullStreams;

        this.process.stdout.setEncoding('utf8');
        this.process.stdout.on('data', (chunk: string) => this.feed(chunk));
        this.process.stdout.on('end', () => {
            // stdout can end before ChildProcess emits `close`. Do not publish a
            // synthetic close here: doing so loses the real exit code and used to
            // invoke lifecycle cleanup twice. `close` below is the one authority.
            logger.debug('[pi] stdout ended; awaiting process close for exit status');
        });

        this.process.stderr.setEncoding('utf8');
        this.process.stderr.on('data', (chunk: string) => {
            logger.debug(`[pi][stderr] ${chunk.toString().trim()}`);
        });

        this.process.on('close', (code, signal) => {
            logger.debug(`[pi] Process exited (code=${code}, signal=${signal})`);
            this.exited = true;
            if (this.closeReported) return;
            this.closeReported = true;
            this.closeHandler?.(code, signal);
        });

        this.process.on('error', (err) => {
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr.code === 'ENOENT') {
                this.errorHandler?.(new Error(
                    `Pi was not found on PATH. Please install Pi and retry.`
                ));
            } else {
                this.errorHandler?.(new Error(
                    `Failed to start Pi: ${nodeErr.message}`
                ));
            }
        });
    }

    send(message: PiRpcCommand): void {
        if (!this.process || this.killed || this.exited || this.process.stdin.destroyed || this.process.stdin.writableEnded) {
            logger.debug('[pi] Dropping message: transport not running');
            return;
        }
        try {
            this.process.stdin.write(JSON.stringify(message) + '\n');
        } catch (err) {
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr.code === 'EPIPE') {
                logger.debug('[pi] EPIPE on write — process likely exited');
            } else {
                throw err;
            }
        }
    }

    onEvent(handler: (event: PiAgentEvent) => void): void {
        this.eventHandler = handler;
    }

    onClose(handler: (code: number | null, signal: string | null) => void): void {
        this.closeHandler = handler;
    }

    onError(handler: (error: Error) => void): void {
        this.errorHandler = handler;
    }

    kill(): void {
        if (!this.process || this.killed) return;
        this.killed = true;
        this.process.kill('SIGTERM');
    }

    protected handleLine(line: string): void {
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            logger.debug(`[pi] Skipping malformed JSON: ${line.slice(0, 100)}`);
            return;
        }

        try {
            const decoded = this.chunkDecoder.push(parsed);
            if (decoded.kind === 'pending') return;
            parsed = decoded.frame;
        } catch (error) {
            // A malformed chunk sequence loses only that frame; later lines stay usable.
            logger.debug(`[pi] Dropping RPC chunk sequence: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }

        this.requestProtocolV2(parsed);
        if (this.consumeNegotiationResponse(parsed)) return;

        const result = PiAgentEventSchema.safeParse(parsed);
        if (result.success) {
            this.eventHandler?.(result.data as PiAgentEvent);
        }
    }

    /**
     * OMP caps a protocol-v1 response at 1 MiB and replaces anything larger with
     * `RPC response exceeded the transport limit` (large `get_entries` history
     * reads hit this immediately). Protocol 2 raises the ceiling to 64 MiB and
     * chunks larger frames, so ask for it as soon as the ready frame advertises
     * support. The response is consumed here: it is transport bookkeeping, not a
     * session event.
     */
    private requestProtocolV2(value: unknown): void {
        if (this.negotiationRequested || !isObject(value) || value.type !== 'ready') return;
        this.negotiationRequested = true;
        const supported = value.supportedProtocolVersions;
        if (!Array.isArray(supported) || !supported.includes(2)) return;
        const id = `hapi-negotiate-${randomUUID()}`;
        this.negotiationId = id;
        this.send({ id, type: 'negotiate_protocol', protocolVersion: 2 });
    }

    private consumeNegotiationResponse(value: unknown): boolean {
        if (this.negotiationId === null) return false;
        if (!isObject(value) || value.type !== 'response' || value.id !== this.negotiationId) return false;
        const negotiated = value.success === true
            && isObject(value.data)
            && value.data.protocolVersion === 2;
        if (negotiated) this.protocolVersion = 2;
        logger.debug(`[pi] RPC protocol negotiation ${negotiated ? 'accepted v2' : 'stayed on v1'}`);
        this.negotiationId = null;
        return true;
    }
}
