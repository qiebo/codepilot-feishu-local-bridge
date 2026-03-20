/**
 * Unit tests for structured output route logic.
 *
 * Tests verify that:
 * 1. structured_output from SDKResultSuccess is preferred over text fallback
 * 2. Text fallback is used when structured_output is absent
 * 3. Raw text is returned when JSON.parse fails on fallback
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Simulate the extraction logic from the structured route
// (We can't import Next.js route handlers directly in node:test,
//  so we test the core logic inline.)

function extractStructuredResult(messages: Array<{ type: string; subtype?: string; structured_output?: unknown; result?: string; message?: unknown }>) {
  let structuredOutput: unknown = undefined;
  let resultText = '';

  for (const message of messages) {
    if (message.type === 'result' && message.subtype === 'success') {
      if (message.structured_output !== undefined) {
        structuredOutput = message.structured_output;
      }
      if (message.result) {
        resultText = message.result;
      }
    } else if (message.type === 'assistant') {
      const msg = message.message as { content?: Array<{ type: string; text?: string }> } | string;
      if (typeof msg === 'string') {
        resultText += msg;
      } else if (msg && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            resultText += block.text;
          }
        }
      }
    }
  }

  // Prefer structured_output
  if (structuredOutput !== undefined) {
    return { result: structuredOutput, source: 'structured_output' };
  }

  // Fallback: try JSON parse
  if (resultText) {
    try {
      return { result: JSON.parse(resultText), source: 'text_parsed' };
    } catch {
      return { result: resultText, source: 'text_raw' };
    }
  }

  return { result: null, source: 'empty' };
}

describe('structured output extraction', () => {
  it('prefers structured_output from SDK result', () => {
    const messages = [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '{"name":"from text"}' }] },
      },
      {
        type: 'result',
        subtype: 'success',
        structured_output: { name: 'from structured' },
        result: '{"name":"from text"}',
      },
    ];

    const out = extractStructuredResult(messages);
    assert.equal(out.source, 'structured_output');
    assert.deepEqual(out.result, { name: 'from structured' });
  });

  it('falls back to text parsing when structured_output is absent', () => {
    const messages = [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '{"fallback":true}' }] },
      },
      {
        type: 'result',
        subtype: 'success',
        result: '',
      },
    ];

    const out = extractStructuredResult(messages);
    assert.equal(out.source, 'text_parsed');
    assert.deepEqual(out.result, { fallback: true });
  });

  it('returns raw text when JSON parse fails', () => {
    const messages = [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'not valid json' }] },
      },
      {
        type: 'result',
        subtype: 'success',
      },
    ];

    const out = extractStructuredResult(messages);
    assert.equal(out.source, 'text_raw');
    assert.equal(out.result, 'not valid json');
  });

  it('returns null when no content at all', () => {
    const messages = [
      { type: 'result', subtype: 'success' },
    ];

    const out = extractStructuredResult(messages);
    assert.equal(out.source, 'empty');
    assert.equal(out.result, null);
  });

  it('handles structured_output that is a primitive (e.g. number)', () => {
    const messages = [
      {
        type: 'result',
        subtype: 'success',
        structured_output: 42,
      },
    ];

    const out = extractStructuredResult(messages);
    assert.equal(out.source, 'structured_output');
    assert.equal(out.result, 42);
  });
});
