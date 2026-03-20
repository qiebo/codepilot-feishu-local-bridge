import { NextRequest, NextResponse } from 'next/server';
import { getConversation } from '@/lib/conversation-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { sessionId, serverName, enabled } = await request.json();

    if (!sessionId || !serverName || typeof enabled !== 'boolean') {
      return NextResponse.json({ error: 'sessionId, serverName, and enabled (boolean) are required' }, { status: 400 });
    }

    const conversation = getConversation(sessionId);
    if (!conversation) {
      return NextResponse.json({ success: false, error: 'No active conversation' }, { status: 404 });
    }

    await conversation.toggleMcpServer(serverName, enabled);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[mcp/toggle] Failed to toggle MCP server:', error);
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
