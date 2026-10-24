import { randomUUID } from 'node:crypto';
import { decodeFileTransferFrame, FileTransferOpcode, TerminalStreamOpcode } from '@getpaseo/protocol/binary-frames/index';
import type { ClientContext, Outbound } from './gateway.js';
import type { UploadedFile } from '../upload-names.js';

/** Staging is socket-owned, memory-only, and never names a host file. Reservations include completed
 * files and leased expired files. Binary processing is synchronous: request/Begin/Chunk/End cannot
 * overtake one another while the daemon is starting or a different prompt awaits RPC. */
export const FACADE_UPLOAD_LIMITS = {
  maxObjectBytes: 20 * 1024 * 1024, maxConnectionBytes: 40 * 1024 * 1024,
  maxConnectionFiles: 8, maxTotalBytes: 128 * 1024 * 1024, maxTotalFiles: 64,
  maxFrameBytes: 1024 * 1024 + 257, timeoutMs: 10 * 60 * 1000,
};
type Record = { file: UploadedFile; requestId: string; modifiedAt: string; received: number; complete: boolean;
  begun: boolean; data?: Buffer; timer?: NodeJS.Timeout; leases: number; removed: boolean };
type State = { records: Map<string, Record>; pending: Map<string, Record>; bytes: number; count: number };
const MIME = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const fail = (message: string): never => { throw new Error(message); };
export function createFacadeUploads(limits = FACADE_UPLOAD_LIMITS) {
  const states = new Map<ClientContext, State>();
  let bytes = 0, count = 0;
  function state(client: ClientContext) {
    client.assertActive?.();
    const state = states.get(client);
    if (!state) return fail('This upload connection is closed');
    return state;
  }
  function release(s: State, record: Record) {
    if (!record.removed || record.leases) return;
    bytes -= record.file.size; count--; s.bytes -= record.file.size; s.count--;
    record.data = undefined;
  }
  function remove(s: State, record: Record) {
    if (record.removed) return;
    record.removed = true;
    clearTimeout(record.timer);
    s.records.delete(record.file.id); if (s.pending.get(record.requestId) === record) s.pending.delete(record.requestId);
    release(s, record);
  }
  function answer(client: ClientContext, requestId: string, error: string | null, file: UploadedFile | null = null) {
    client.emit({ type: 'file.upload.response', payload: { requestId, file, error } });
  }
  return {
    add(client: ClientContext) { if (!states.has(client)) states.set(client, { records: new Map(), pending: new Map(), bytes: 0, count: 0 }); },
    drop(client: ClientContext) { const s = states.get(client); if (!s) return; states.delete(client); for (const record of s.records.values()) remove(s, record); },
    close() { for (const client of states.keys()) this.drop(client); },
    request(message: any, client: ClientContext): Outbound | void {
      const requestId = typeof message.requestId === 'string' ? message.requestId : '';
      try {
        const s = state(client);
        if (!requestId || Buffer.byteLength(requestId) > 255 || /[\p{Cc}\p{Cf}]/u.test(requestId)) fail('Invalid upload request id');
        if (s.pending.has(requestId)) { const old = s.pending.get(requestId)!; remove(s, old); fail('Duplicate upload request id'); }
        const { fileName, mimeType, size, modifiedAt } = message;
        if (typeof fileName !== 'string' || !fileName.trim() || fileName === '.' || fileName === '..' || Buffer.byteLength(fileName) > 240 || /[\\/\p{Cc}\p{Cf}]/u.test(fileName)) fail('Invalid upload file name');
        if (typeof mimeType !== 'string' || !MIME.test(mimeType)) fail('Invalid upload MIME type');
        if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxObjectBytes) fail(`Upload exceeds the ${limits.maxObjectBytes} byte file limit`);
        if (typeof modifiedAt !== 'string' || modifiedAt.length > 64 || !Number.isFinite(Date.parse(modifiedAt))) fail('Invalid upload modified time');
        if (s.count >= limits.maxConnectionFiles || count >= limits.maxTotalFiles || s.bytes + size > limits.maxConnectionBytes || bytes + size > limits.maxTotalBytes) fail('Upload staging quota exceeded; reconnect or wait for files to expire');
        const id = `upload_${randomUUID()}`;
        const record: Record = { file: { type: 'uploaded_file', id, fileName, mimeType, size, path: `alp-upload:${id}` }, requestId, modifiedAt, data: Buffer.alloc(size), received: 0, complete: false, begun: false, leases: 0, removed: false };
        s.records.set(id, record); s.pending.set(requestId, record);
        s.bytes += size; bytes += size; s.count++; count++;
        record.timer = setTimeout(() => { if (s.pending.get(requestId) === record) answer(client, requestId, 'Upload timed out'); remove(s, record); }, limits.timeoutMs);
        record.timer.unref();
      } catch (error: any) { return { type: 'file.upload.response', payload: { requestId, file: null, error: error.message } }; }
    },
    binary(data: Uint8Array, client: ClientContext) {
      const s = state(client);
      // Terminal binary input was ignored by this facade; it must not cancel an upload.
      if (Object.values(TerminalStreamOpcode).includes(data[0] as any)) return;
      // Decode only bounded input. Invalid framing has no trustworthy request id; fail every pending
      // transfer with its native response instead of leaving requests waiting until client timeout.
      const frame = data.byteLength <= limits.maxFrameBytes ? decodeFileTransferFrame(data) : null;
      if (!frame) {
        for (const record of [...s.pending.values()]) { answer(client, record.requestId, 'Malformed or oversized upload frame'); remove(s, record); }
        return;
      }
      const record = s.pending.get(frame.requestId);
      if (!record) return;
      try {
        if (frame.opcode === FileTransferOpcode.FileBegin) {
          const m = frame.metadata;
          if (record.begun || m.encoding !== 'binary' || m.size !== record.file.size || m.mime !== record.file.mimeType || m.fileName !== record.file.fileName || m.modifiedAt !== record.modifiedAt) fail('Upload Begin metadata does not match its request');
          record.begun = true;
        } else {
          if (!record.begun) fail('Upload frame arrived before Begin');
          if (frame.opcode === FileTransferOpcode.FileChunk) {
            if (!frame.payload.byteLength || record.received + frame.payload.byteLength > record.file.size) fail('Upload bytes exceed the declared size');
            record.data!.set(frame.payload, record.received); record.received += frame.payload.byteLength;
          } else {
            if (record.received !== record.file.size) fail('Upload ended before its declared size');
            record.complete = true;
            s.pending.delete(record.requestId);
            answer(client, record.requestId, null, { ...record.file });
          }
        }
      } catch (error: any) { answer(client, record.requestId, error.message); remove(s, record); }
    },
    /** Resolve all grants before side effects. Expiry/disconnect revokes future resolutions; a lease
     * retains bounded bytes until the in-flight operation exits, with active checked after awaits. */
    lease(client: ClientContext | undefined, files: unknown[]) {
      if (!client) fail('Files must be uploaded on this connection');
      const s = state(client!);
      if (files.length > limits.maxConnectionFiles) fail('Too many files in one message');
      const records = files.map((value: any) => {
        const r = s.records.get(value?.id);
        if (!r || r.removed || !r.complete || !r.data || ['type', 'id', 'fileName', 'mimeType', 'size', 'path'].some(key => value[key] !== (r.file as any)[key])) fail('File was not uploaded on this connection, is incomplete, or has expired');
        return r!;
      });
      for (const r of records) r.leases++;
      let released = false;
      return { files: records.map(r => ({ ...r.file, data: r.data! })),
        assertActive: () => { state(client!); },
        release: () => { if (released) return; released = true; for (const r of records) { r.leases--; release(s, r); } },
      };
    },
  };
}
export type FacadeUploads = ReturnType<typeof createFacadeUploads>;
