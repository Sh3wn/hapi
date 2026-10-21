import { describe, expect, it } from 'vitest'
import {
    PI_RPC_CHUNK_PAYLOAD_BYTES,
    PI_RPC_MAX_FRAME_BYTES,
    PI_RPC_MAX_REASSEMBLED_BYTES,
    PiRpcChunkDecoder,
    PiRpcChunkError,
} from './rpcChunkDecoder'

function chunkFrames(json: string, chunkId = 'rpc-1') {
    const bytes = Buffer.from(json, 'utf8')
    const count = Math.ceil(bytes.byteLength / PI_RPC_CHUNK_PAYLOAD_BYTES)
    return Array.from({ length: count }, (_, index) => ({
        type: 'rpc_chunk' as const,
        chunkId,
        index,
        count,
        byteLength: bytes.byteLength,
        data: bytes
            .subarray(index * PI_RPC_CHUNK_PAYLOAD_BYTES, (index + 1) * PI_RPC_CHUNK_PAYLOAD_BYTES)
            .toString('base64'),
    }))
}

/** A response comfortably above the 1 MiB single-frame ceiling. */
function largeResponse(): string {
    return JSON.stringify({
        type: 'response',
        id: 'rpc-1',
        command: 'get_entries',
        success: true,
        data: { padding: 'a'.repeat(PI_RPC_MAX_FRAME_BYTES + 64 * 1024) },
    })
}

describe('PiRpcChunkDecoder', () => {
    it('passes non-chunk frames through untouched', () => {
        const decoder = new PiRpcChunkDecoder()
        const frame = { type: 'turn_start' }
        expect(decoder.push(frame)).toEqual({ kind: 'frame', frame })
    })

    it('reassembles a multi-chunk frame into one object', () => {
        const decoder = new PiRpcChunkDecoder()
        const json = largeResponse()
        const chunks = chunkFrames(json)
        expect(chunks.length).toBeGreaterThan(1)

        for (const chunk of chunks.slice(0, -1)) {
            expect(decoder.push(chunk)).toEqual({ kind: 'pending' })
        }
        expect(decoder.push(chunks[chunks.length - 1]!)).toEqual({
            kind: 'frame',
            frame: JSON.parse(json),
        })
    })

    it('rejects a sequence interrupted by an unrelated frame', () => {
        const decoder = new PiRpcChunkDecoder()
        decoder.push(chunkFrames(largeResponse())[0]!)

        expect(() => decoder.push({ type: 'turn_start' })).toThrow(PiRpcChunkError)
    })

    it('rejects out-of-order indices', () => {
        const decoder = new PiRpcChunkDecoder()
        const chunks = chunkFrames(largeResponse())
        expect(() => decoder.push(chunks[1]!)).toThrow(/start at index 0/)
    })

    it('rejects a mismatched chunk header', () => {
        const decoder = new PiRpcChunkDecoder()
        const chunks = chunkFrames(largeResponse())
        decoder.push(chunks[0]!)
        expect(() => decoder.push({ ...chunks[1]!, chunkId: 'other' })).toThrow(/mismatch/)
    })

    it('rejects a declared size below the single-frame ceiling', () => {
        const decoder = new PiRpcChunkDecoder()
        const chunk = chunkFrames(largeResponse())[0]!
        expect(() => decoder.push({ ...chunk, byteLength: PI_RPC_MAX_FRAME_BYTES - 1 })).toThrow(/metadata/)
    })

    it('rejects a declared size above the reassembly ceiling', () => {
        const decoder = new PiRpcChunkDecoder()
        const chunk = chunkFrames(largeResponse())[0]!
        expect(() => decoder.push({ ...chunk, byteLength: PI_RPC_MAX_REASSEMBLED_BYTES + 1 })).toThrow(/metadata/)
    })

    it('rejects non-base64 payloads', () => {
        const decoder = new PiRpcChunkDecoder()
        const chunk = chunkFrames(largeResponse())[0]!
        expect(() => decoder.push({ ...chunk, data: 'not base64!' })).toThrow(/data/)
    })

    it('rejects a chunk whose payload exceeds the chunk size', () => {
        const decoder = new PiRpcChunkDecoder()
        const chunk = chunkFrames(largeResponse())[0]!
        const oversized = Buffer.alloc(PI_RPC_CHUNK_PAYLOAD_BYTES + 1, 1).toString('base64')
        expect(() => decoder.push({ ...chunk, data: oversized })).toThrow(/payload/)
    })

    it('rejects payloads that are not JSON objects', () => {
        const decoder = new PiRpcChunkDecoder()
        const json = 'x'.repeat(PI_RPC_MAX_FRAME_BYTES + 1024)
        const chunks = chunkFrames(json)
        for (const chunk of chunks.slice(0, -1)) decoder.push(chunk)
        expect(() => decoder.push(chunks[chunks.length - 1]!)).toThrow(/not valid JSON/)
    })
})