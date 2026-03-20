import { NextRequest, NextResponse } from 'next/server';
import { getConversation } from '@/lib/conversation-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { sessionId, model } = await request.json();

    if (!sessionId || !model) {
      return NextResponse.json({ error: 'sessionId and model are required' }, { status: 400 });
    }

    const conversation = getConversation(sessionId);
    if (!conversation) {
      return NextResponse.json({ applied: false });
    }

    await conversation.setModel(model);

    return NextResponse.json({ applied: true });
  } catch (error) {
    console.error('[model] Failed to set model:', error);
    return NextResponse.json({ applied: false, error: String(error) });
  }
}
