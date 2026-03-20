import { NextRequest, NextResponse } from 'next/server';
import { getConversation } from '@/lib/conversation-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { sessionId, serverName } = await request.json();

    if (!sessionId || !serverName) {
      return NextResponse.json({ error: 'sessionId and serverName are required' }, { status: 400 });
    }

    const conversation = getConversation(sessionId);
    if (!conversation) {
      return NextResponse.json({ success: false, error: 'No active conversation' }, { status: 404 });
    }

    await conversation.reconnectMcpServer(serverName);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[mcp/reconnect] Failed to reconnect MCP server:', error);
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
