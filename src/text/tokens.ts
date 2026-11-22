/**
 * Finds the text delta in one item of an LLM stream, by duck typing, without importing any
 * LLM SDK. Returns undefined for items with no text (role headers, tool calls, usage, …).
 *
 * - strings, as they are;
 * - OpenAI Chat Completions chunks: `choices[0].delta.content`;
 * - OpenAI Responses events: `{ type: 'response.output_text.delta', delta }`;
 * - Anthropic Messages events: `{ type: 'content_block_delta', delta: { text } }`;
 * - Google Gemini responses, as SDK objects or as the REST/SSE JSON: the `text` of each part
 *   of `candidates[0].content.parts` joined, skipping thought parts (what the `.text` getter
 *   of `@google/genai` returns), else `.text` (a getter, or a method in older SDKs);
 * - Vercel AI SDK `fullStream` parts: `{ type: 'text-delta', text | textDelta }`.
 */
export function textOf(item: unknown): string | undefined {
  if (typeof item === 'string') return item;
  if (typeof item !== 'object' || item === null) return undefined;
  const o = item as Record<string, unknown>;
  const choices = o.choices;
  if (Array.isArray(choices)) {
    const delta = (choices[0] as { delta?: { content?: unknown } } | undefined)?.delta;
    return typeof delta?.content === 'string' ? delta.content : undefined;
  }
  switch (o.type) {
    case 'content_block_delta': {
      const delta = o.delta as { text?: unknown } | undefined;
      return typeof delta?.text === 'string' ? delta.text : undefined;
    }
    case 'response.output_text.delta':
      return typeof o.delta === 'string' ? o.delta : undefined;
    case 'text-delta': {
      const text = o.text ?? o.textDelta;
      return typeof text === 'string' ? text : undefined;
    }
  }
  if (typeof o.type === 'string') return undefined; // Another typed event: not text.
  const candidates = o.candidates;
  if (Array.isArray(candidates)) {
    const parts = (candidates[0] as { content?: { parts?: unknown } } | undefined)?.content?.parts;
    // Read here rather than through the SDK's getter, which warns on the console for a
    // response with a function call. Once there are parts, they decide.
    if (Array.isArray(parts)) return geminiText(parts);
  }
  try {
    const text = typeof o.text === 'function' ? (o.text as () => unknown).call(item) : o.text;
    return typeof text === 'string' ? text : undefined;
  } catch {
    return undefined; // Gemini's text() throws for a response without text (e.g. blocked).
  }
}

/** The text parts of a Gemini candidate joined, skipping thoughts; undefined if there are none. */
function geminiText(parts: unknown[]): string | undefined {
  let text: string | undefined;
  for (const part of parts) {
    if (typeof part !== 'object' || part === null) continue;
    const p = part as { text?: unknown; thought?: unknown };
    if (typeof p.text !== 'string' || p.thought === true) continue;
    text = (text ?? '') + p.text;
  }
  return text;
}
