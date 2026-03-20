import { NextResponse } from 'next/server';
import { invalidateClaudeClientCache } from '@/lib/claude-client';

/**
 * POST /api/claude-status/invalidate
 * Clears all cached Claude binary paths so the next status check or SDK call
 * picks up a freshly-installed binary. Called by the install wizard on success.
 */
export async function POST() {
  invalidateClaudeClientCache();
  return NextResponse.json({ ok: true });
}
