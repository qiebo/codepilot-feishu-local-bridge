import { NextResponse } from 'next/server';
import { CLI_TOOLS_CATALOG, EXTRA_WELL_KNOWN_BINS } from '@/lib/cli-tools-catalog';
import { generateTextViaSdk } from '@/lib/claude-client';

/**
 * Try to extract a JSON object from text that may be wrapped in markdown code blocks
 * or contain leading/trailing non-JSON content.
 */
function extractJson(raw: string): Record<string, string> {
  // Try direct parse first
  const trimmed = raw.trim();
  try { return JSON.parse(trimmed); } catch { /* continue */ }

  // Strip markdown code fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch { /* continue */ }
  }

  // Find first { ... last }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* continue */ }
  }

  throw new Error('AI response was not valid JSON');
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Look up in catalog first, then in extra well-known list
  const catalogTool = CLI_TOOLS_CATALOG.find(t => t.id === id);
  const extraEntry = !catalogTool ? EXTRA_WELL_KNOWN_BINS.find(([eid]) => eid === id) : null;

  if (!catalogTool && !extraEntry) {
    return NextResponse.json({ error: 'Tool not found' }, { status: 404 });
  }

  if (catalogTool && !catalogTool.supportsAutoDescribe) {
    return NextResponse.json(
      { error: 'Auto-describe not supported for this tool' },
      { status: 400 }
    );
  }

  try {
    const body = await request.json();
    const { providerId, model: requestModel } = body as { providerId?: string; model?: string };

    const toolName = catalogTool?.name ?? extraEntry?.[1] ?? id;
    const binNames = catalogTool?.binNames.join(', ') ?? extraEntry?.[2] ?? id;
    const categories = catalogTool?.categories.join(', ') ?? 'general';
    const homepage = catalogTool?.homepage ?? 'N/A';

    const prompt = `You are a technical writer. Write a brief, practical description of the CLI tool "${toolName}" (binary: ${binNames}).
Categories: ${categories}
Homepage: ${homepage}

Provide the description in both Chinese and English. Focus on practical use cases in AI-assisted development workflows.

Respond in this exact JSON format (no markdown, no code fences, just raw JSON):
{"zh": "中文描述（2-3句话）", "en": "English description (2-3 sentences)"}`;

    let result: string;
    try {
      result = await generateTextViaSdk({
        providerId: providerId || undefined,
        model: requestModel || undefined,
        system: 'You are a technical documentation writer. Respond with raw JSON only, no markdown formatting.',
        prompt,
      });
    } catch (genError) {
      console.error(`[cli-tools/${id}/describe] generateTextViaSdk threw:`, genError);
      const msg = genError instanceof Error ? genError.message : 'Text generation failed';
      return NextResponse.json({ error: msg }, { status: 502 });
    }

    if (!result || !result.trim()) {
      return NextResponse.json(
        { error: 'AI returned an empty response. Please check your provider configuration.' },
        { status: 502 }
      );
    }

    const parsed = extractJson(result);

    if (!parsed.zh || !parsed.en) {
      return NextResponse.json(
        { error: 'AI response missing required zh/en fields' },
        { status: 502 }
      );
    }

    return NextResponse.json({ description: parsed });
  } catch (error) {
    console.error(`[cli-tools/${id}/describe] Error:`, error);
    const message = error instanceof Error ? error.message : 'Description generation failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
