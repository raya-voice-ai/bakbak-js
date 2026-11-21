import { describe, expect, it } from 'vitest';
import { textOf } from '../../src/text/tokens';

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
