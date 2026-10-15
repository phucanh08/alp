/**
 * Newline-delimited JSON framing for stream transports (a Unix socket, a named pipe, a TCP
 * stream). Portable: strings in, strings out; the stream owner decodes bytes to text first.
 * Message transports such as a WebSocket carry whole frames and need none of this.
 */

/** UTF-8 length of `text` without Buffer or TextEncoder; an unpaired surrogate counts as U+FFFD (3 bytes). @param {string} text */
export function utf8Length(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) { bytes += 4; index++; }
    else bytes += 3;
  }
  return bytes;
}

/**
 * Splits decoded text chunks into frames. `push` returns the complete frames in order, blank
 * lines skipped, and throws once a frame (complete or still arriving) exceeds `maxFrame` bytes;
 * the decoder is unusable after that. Each character is measured once, so a frame that arrives
 * in many chunks costs linear time.
 * @param {{ maxFrame: number }} options
 * @returns {{ push(chunk: string): string[], readonly buffered: number }}
 */
export function createLineDecoder({ maxFrame }) {
  /** @type {string[]} */
  let parts = [];
  let bytes = 0;
  let failed = false;
  const overflow = () => { failed = true; parts = []; bytes = 0; return new RangeError(`Frame exceeds ${maxFrame} bytes`); };
  return {
    push(chunk) {
      if (failed) throw new RangeError('Line decoder already failed');
      /** @type {string[]} */
      const frames = [];
      let start = 0;
      for (let index = chunk.indexOf('\n'); index >= 0; index = chunk.indexOf('\n', start)) {
        const piece = chunk.slice(start, index);
        bytes += utf8Length(piece);
        if (bytes > maxFrame) throw overflow();
        parts.push(piece);
        const line = parts.length === 1 ? parts[0] : parts.join('');
        parts = [];
        bytes = 0;
        start = index + 1;
        if (line.trim()) frames.push(line);
      }
      if (start < chunk.length) {
        const rest = chunk.slice(start);
        bytes += utf8Length(rest);
        if (bytes > maxFrame) throw overflow();
        parts.push(rest);
      }
      return frames;
    },
    get buffered() { return bytes; },
  };
}
