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
  // The current incomplete line, as pieces: joined only once its newline arrives, so a huge
  // line (one chunk's base64) costs linear time however many reads it spans.
  let pending: string[] = [];
  let pendingLength = 0;
  let eventName = '';
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      onRead();
      const text = decoder.decode(value, { stream: true });
      let start = 0;
      for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', start)) {
        let line = text.slice(start, nl);
        start = nl + 1;
        if (pending.length) {
          pending.push(line);
          line = pending.join('');
          pending = [];
          pendingLength = 0;
        }
        if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1); // CRLF
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
      if (start < text.length) {
        pending.push(start ? text.slice(start) : text);
        pendingLength += text.length - start;
        if (pendingLength > MAX_LINE_CHARS) {
          throw new APIConnectionError(`An event line exceeded ${MAX_LINE_CHARS} characters.`, {
            retryable: false,
          });
        }
      }
    }
    // A complete final event whose blank line never came is still dispatched.
    let tail = pending.join('') + decoder.decode();
    if (tail.endsWith('\r')) tail = tail.slice(0, -1);
    if (tail === '' && data.length) yield { event: eventName, data: data.join('\n') };
  } finally {
    reader.releaseLock();
  }
}
