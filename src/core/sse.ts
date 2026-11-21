import { APIConnectionError } from './errors';

/** One Server-Sent Event: its `event:` name (a hint only) and its joined `data:` lines. */
export interface SSEEvent {
  event: string;
  data: string;
}

/** No line limit below this (BEHAVIOR.md §5.1): one chunk's base64 can be large. */
const MAX_LINE_CHARS = 32 * 1024 * 1024;

/**
 * Parses an SSE body (BEHAVIOR.md §5.1): LF or CRLF line ends, comment lines ignored,
 * `id:`/`retry:` ignored, multi-line `data:` joined with `\n`, dispatch on a blank line.
 * `onRead` is called for every network read, to feed an inactivity timer.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  onRead: () => void,
): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let scanFrom = 0;
  let eventName = '';
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      onRead();
      buf += decoder.decode(value, { stream: true });
      let lineStart = 0;
      for (let nl = buf.indexOf('\n', scanFrom); nl !== -1; nl = buf.indexOf('\n', lineStart)) {
        const end = nl > lineStart && buf.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
        const line = buf.slice(lineStart, end);
        lineStart = nl + 1;
        if (line === '') {
          if (data.length) {
            yield { event: eventName, data: data.length === 1 ? (data[0] as string) : data.join('\n') };
          }
          eventName = '';
          data = [];
          continue;
        }
        if (line.charCodeAt(0) === 58) continue; // ":" comment
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let fieldValue = colon === -1 ? '' : line.slice(colon + 1);
        if (fieldValue.charCodeAt(0) === 32) fieldValue = fieldValue.slice(1);
        if (field === 'data') data.push(fieldValue);
        else if (field === 'event') eventName = fieldValue;
        // id, retry and unknown fields are ignored.
      }
      buf = lineStart ? buf.slice(lineStart) : buf;
      scanFrom = buf.length;
      if (buf.length > MAX_LINE_CHARS) {
        throw new APIConnectionError(`An event line exceeded ${MAX_LINE_CHARS} characters.`, {
          retryable: false,
        });
      }
    }
    // A complete final event whose blank line never came is still dispatched.
    buf += decoder.decode();
    if (buf.endsWith('\r')) buf = buf.slice(0, -1);
    if (buf === '' && data.length) yield { event: eventName, data: data.join('\n') };
  } finally {
    reader.releaseLock();
  }
}
