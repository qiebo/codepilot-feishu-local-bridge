import { NextRequest, NextResponse } from 'next/server';
import { getConversation } from '@/lib/conversation-registry';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { sessionId, mode } = await request.json();

    if (!sessionId || !mode) {
      return NextResponse.json({ error: 'sessionId and mode are required' }, { status: 400 });
    }

    const conversation = getConversation(sessionId);
    if (!conversation) {
      return NextResponse.json({ applied: false });
    }

    const permissionMode: PermissionMode = mode === 'code' ? 'acceptEdits' : 'plan';
    await conversation.setPermissionMode(permissionMode);

    return NextResponse.json({ applied: true });
  } catch (error) {
    console.error('[mode] Failed to switch mode:', error);
    return NextResponse.json({ applied: false, error: String(error) });
  }
}
