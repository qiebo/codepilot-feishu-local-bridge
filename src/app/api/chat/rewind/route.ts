import { NextRequest, NextResponse } from 'next/server';
import { getConversation } from '@/lib/conversation-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { sessionId, userMessageId, dryRun } = await request.json();

    if (!sessionId || !userMessageId) {
      return NextResponse.json({ error: 'sessionId and userMessageId are required' }, { status: 400 });
    }

    const conversation = getConversation(sessionId);
    if (!conversation) {
      return NextResponse.json({ canRewind: false, error: 'No active conversation' });
    }

    const result = await conversation.rewindFiles(userMessageId, { dryRun: !!dryRun });

    return NextResponse.json(result);
  } catch (error) {
    console.error('[rewind] Failed to rewind:', error);
    return NextResponse.json({ canRewind: false, error: String(error) });
  }
}
