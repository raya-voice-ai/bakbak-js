import { describe, expect, it } from 'vitest';
import { isKnownShape, textOf } from '../../src/text/tokens';

describe('textOf: LLM stream events by duck typing', () => {
  it('passes strings through', () => {
    expect(textOf('नमस्ते')).toBe('नमस्ते');
    expect(textOf('')).toBe('');
  });

  it('reads OpenAI Chat Completions chunks', () => {
    expect(textOf({ choices: [{ delta: { content: 'Hi' } }] })).toBe('Hi');
    expect(textOf({ choices: [{ delta: { role: 'assistant' } }] })).toBeUndefined();
    expect(textOf({ choices: [{ delta: { content: null } }] })).toBeUndefined();
    expect(textOf({ choices: [] })).toBeUndefined();
  });

  it('reads OpenAI Responses events', () => {
    expect(textOf({ type: 'response.output_text.delta', delta: 'Hi' })).toBe('Hi');
    expect(textOf({ type: 'response.completed', response: {} })).toBeUndefined();
  });

  it('reads Anthropic events', () => {
    expect(textOf({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } })).toBe(
      'Hi',
    );
    expect(
      textOf({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } }),
    ).toBeUndefined();
    expect(textOf({ type: 'message_start', message: {} })).toBeUndefined();
  });

  it('reads Gemini responses: a text getter or a text() method', () => {
    expect(textOf({ text: 'Hi', candidates: [] })).toBe('Hi');
    const legacy = { text: () => 'Hi' };
    expect(textOf(legacy)).toBe('Hi');
    const blocked = {
      text() {
        throw new Error('blocked');
      },
    };
    expect(textOf(blocked)).toBeUndefined();
    const getter = {
      get text() {
        return 'G';
      },
    };
    expect(textOf(getter)).toBe('G');
  });

  it("reads Gemini's REST/SSE JSON: the first candidate's text parts joined, without thoughts", () => {
    const chunk = (parts: unknown[]) => ({
      candidates: [{ content: { role: 'model', parts }, index: 0 }],
      usageMetadata: { promptTokenCount: 4 },
      modelVersion: 'gemini-x',
    });
    expect(textOf(chunk([{ text: 'नमस्ते' }]))).toBe('नमस्ते');
    expect(textOf(chunk([{ text: 'Hello ' }, { text: 'there.' }]))).toBe('Hello there.');
    expect(textOf(chunk([{ text: 'Planning…', thought: true }, { text: 'Hi' }]))).toBe('Hi');
    expect(textOf(chunk([{ text: 'Planning…', thought: true }]))).toBeUndefined();
    expect(textOf(chunk([{ functionCall: { name: 'f', args: {} } }]))).toBeUndefined();
    expect(textOf(chunk([{ text: 42 }, null, 'x', { text: 'ok' }]))).toBe('ok');
    expect(textOf(chunk([]))).toBeUndefined();
    expect(textOf({ candidates: [] })).toBeUndefined();
    expect(textOf({ candidates: [{ finishReason: 'SAFETY' }] })).toBeUndefined();
    // Only the first candidate, as the SDK's getter does.
    expect(
      textOf({
        candidates: [{ content: { parts: [{ text: 'A' }] } }, { content: { parts: [{ text: 'B' }] } }],
      }),
    ).toBe('A');
  });

  it('reads an @google/genai response object the same through candidates as through its getter', () => {
    // The shape of @google/genai's GenerateContentResponse: data fields plus a `text` getter.
    class GenerateContentResponse {
      warnings = 0;
      constructor(readonly candidates: Array<{ content?: { parts?: Array<Record<string, unknown>> } }>) {}
      get text(): string | undefined {
        const parts = this.candidates[0]?.content?.parts;
        if (!parts || parts.length === 0) return undefined;
        let text = '';
        let any = false;
        for (const part of parts) {
          if (Object.keys(part).some((k) => k !== 'text' && k !== 'thought' && k !== 'thoughtSignature'))
            this.warnings++; // the SDK's console.warn about non-text parts
          if (typeof part.text !== 'string' || part.thought === true) continue;
          any = true;
          text += part.text;
        }
        return any ? text : undefined;
      }
    }
    const cases = [
      [{ text: 'Hello ' }, { text: 'there.' }],
      [{ text: 'Planning…', thought: true, thoughtSignature: 'sig' }, { text: 'Hi' }],
      [{ text: '' }],
      [{ functionCall: { name: 'f', args: {} } }],
      [],
    ];
    for (const parts of cases) {
      const response = new GenerateContentResponse([{ content: { parts } }]);
      const raw = JSON.parse(JSON.stringify({ candidates: response.candidates }));
      expect(textOf(response)).toBe(response.text);
      expect(textOf(raw)).toBe(response.text);
    }
    const toolCall = new GenerateContentResponse([{ content: { parts: [{ functionCall: { name: 'f' } }] } }]);
    textOf(toolCall);
    expect(toolCall.warnings).toBe(0); // textOf did not go through the warning getter
  });

  it('reads Vercel AI SDK stream parts', () => {
    expect(textOf({ type: 'text-delta', text: 'v5' })).toBe('v5');
    expect(textOf({ type: 'text-delta', textDelta: 'v4' })).toBe('v4');
    expect(textOf({ type: 'finish' })).toBeUndefined();
  });

  it('ignores anything else', () => {
    expect(textOf(42)).toBeUndefined();
    expect(textOf(null)).toBeUndefined();
    expect(textOf({ foo: 'bar' })).toBeUndefined();
  });
});

describe('isKnownShape: the shapes textOf reads, with or without text', () => {
  it('knows strings, null and undefined (mapped events without text) and the event shapes', () => {
    class Legacy {
      text() {
        return 'x';
      }
    }
    for (const item of [
      '',
      null,
      undefined,
      { choices: [] },
      { type: 'message_stop' },
      { candidates: [] },
      { text: undefined },
      new Legacy(),
      {
        get text() {
          return undefined;
        },
      },
    ]) {
      expect(isKnownShape(item)).toBe(true);
    }
  });

  it('does not know anything else', () => {
    for (const item of [42, () => 'x', { choices: {} }, { type: 1 }, { candidates: {} }, {}]) {
      expect(isKnownShape(item)).toBe(false);
    }
  });
});
