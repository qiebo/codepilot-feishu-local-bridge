import { NextRequest, NextResponse } from 'next/server';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKResultSuccess } from '@anthropic-ai/claude-agent-sdk';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { prompt, outputFormat, options } = body;

    if (!prompt) {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    // Validate outputFormat: must be { type: 'json_schema', schema: { ... } }
    if (
      !outputFormat ||
      typeof outputFormat !== 'object' ||
      outputFormat.type !== 'json_schema' ||
      !outputFormat.schema ||
      typeof outputFormat.schema !== 'object'
    ) {
      return NextResponse.json(
        { error: 'outputFormat must be { type: "json_schema", schema: { ... } }' },
        { status: 400 },
      );
    }

    const queryOptions: Partial<Options> = {
      cwd: options?.cwd || process.cwd(),
      model: options?.model,
      outputFormat,
    };

    // Collect the result message which contains structured_output
    let structuredOutput: unknown = undefined;
    let resultText = '';

    for await (const message of query({
      prompt,
      options: queryOptions as Options,
    })) {
      if (message.type === 'result' && message.subtype === 'success') {
        const successResult = message as SDKResultSuccess;
        // Primary path: read structured_output directly from the SDK result
        if (successResult.structured_output !== undefined) {
          structuredOutput = successResult.structured_output;
        }
        // Also capture result text as fallback
        if (successResult.result) {
          resultText = successResult.result;
        }
      } else if (message.type === 'assistant') {
        // Fallback: accumulate assistant text in case structured_output is absent
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

    // Prefer structured_output from the SDK result message
    if (structuredOutput !== undefined) {
      return NextResponse.json({ result: structuredOutput });
    }

    // Fallback: try to parse accumulated text as JSON
    if (resultText) {
      try {
        const parsed = JSON.parse(resultText);
        return NextResponse.json({ result: parsed });
      } catch {
        return NextResponse.json({ result: resultText });
      }
    }

    return NextResponse.json({ result: null });
  } catch (error) {
    console.error('[structured] Structured query failed:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
