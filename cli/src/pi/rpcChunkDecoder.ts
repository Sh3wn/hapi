import { isObject } from '@hapi/protocol'

/**
 * OMP RPC protocol v2 chunk reassembly.
 *
 * OMP splits any logical frame larger than one JSONL frame across `rpc_chunk`
 * lines once the client negotiates protocol 2. Without reassembly a session
 * transport only ever sees 256 KiB base64 fragments — or, under protocol 1,
 * OMP replaces an oversized response with
 * `RPC response exceeded the transport limit`.
 *
 * Limits mirror `@oh-my-pi/pi-coding-agent/src/modes/rpc/rpc-frame.ts`.
 */
export const PI_RPC_MAX_FRAME_BYTES = 1024 * 1024
export const PI_RPC_MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024
export const PI_RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024

const MAX_CHUNK_COUNT = Math.ceil(PI_RPC_MAX_REASSEMBLED_BYTES / PI_RPC_CHUNK_PAYLOAD_BYTES)

type PendingChunks = {
    chunkId: string
    count: number
    byteLength: number
    nextIndex: number
    chunks: Buffer[]
    receivedBytes: number
}

export class PiRpcChunkError extends Error {}

function decodeBase64(data: unknown): Buffer {
    if (
        typeof data !== 'string'
        || data.length === 0
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
    ) {
        throw new PiRpcChunkError('invalid rpc chunk data')
    }
    const bytes = Buffer.from(data, 'base64')
    if (bytes.toString('base64') !== data) throw new PiRpcChunkError('invalid rpc chunk data')
    return bytes
}

export type PiRpcChunkPushResult =
    | { kind: 'frame'; frame: unknown }
    | { kind: 'pending' }

/**
 * Feed every decoded JSONL value here. Non-chunk frames pass through, chunk
 * sequences are buffered until complete. Throws {@link PiRpcChunkError} on a
 * malformed or interrupted sequence; the caller should drop that sequence.
 */
export class PiRpcChunkDecoder {
    private pending: PendingChunks | undefined

    push(value: unknown): PiRpcChunkPushResult {
        if (!isObject(value) || value.type !== 'rpc_chunk') {
            if (this.pending) {
                this.pending = undefined
                throw new PiRpcChunkError('rpc chunk sequence interrupted')
            }
            return { kind: 'frame', frame: value }
        }

        const { chunkId, index, count, byteLength } = value
        if (
            typeof chunkId !== 'string'
            || chunkId.length === 0
            || chunkId.length > 128
            || !Number.isSafeInteger(index)
            || !Number.isSafeInteger(count)
            || !Number.isSafeInteger(byteLength)
            || (index as number) < 0
            || (count as number) < 2
            || (count as number) > MAX_CHUNK_COUNT
            || (index as number) >= (count as number)
            || (byteLength as number) < PI_RPC_MAX_FRAME_BYTES
            || (byteLength as number) > PI_RPC_MAX_REASSEMBLED_BYTES
        ) {
            this.pending = undefined
            throw new PiRpcChunkError('invalid rpc chunk metadata')
        }

        const bytes = decodeBase64(value.data)
        if (bytes.byteLength > PI_RPC_CHUNK_PAYLOAD_BYTES) {
            this.pending = undefined
            throw new PiRpcChunkError('rpc chunk payload exceeds the transport limit')
        }

        if (!this.pending) {
            if (index !== 0) {
                throw new PiRpcChunkError('rpc chunk sequence must start at index 0')
            }
            this.pending = {
                chunkId,
                count: count as number,
                byteLength: byteLength as number,
                nextIndex: 0,
                chunks: [],
                receivedBytes: 0,
            }
        }

        const pending = this.pending
        if (
            pending.chunkId !== chunkId
            || pending.count !== count
            || pending.byteLength !== byteLength
            || pending.nextIndex !== index
        ) {
            this.pending = undefined
            throw new PiRpcChunkError('rpc chunk sequence mismatch')
        }

        pending.chunks.push(bytes)
        pending.receivedBytes += bytes.byteLength
        pending.nextIndex += 1
        if (pending.receivedBytes > pending.byteLength) {
            this.pending = undefined
            throw new PiRpcChunkError('rpc chunk sequence exceeds declared length')
        }
        if (pending.nextIndex < pending.count) return { kind: 'pending' }
        if (pending.receivedBytes !== pending.byteLength) {
            this.pending = undefined
            throw new PiRpcChunkError('rpc chunk sequence length mismatch')
        }

        this.pending = undefined
        let frame: unknown
        try {
            frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(pending.chunks)))
        } catch {
            throw new PiRpcChunkError('rpc chunk payload is not valid JSON')
        }
        if (!isObject(frame) || Array.isArray(frame)) throw new PiRpcChunkError('rpc frame must be an object')
        return { kind: 'frame', frame }
    }
}