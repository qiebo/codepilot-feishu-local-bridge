/**
 * Conversation Engine — processes inbound IM messages through Claude.
 *
 * Takes a ChannelBinding + inbound message, calls streamClaude(),
 * consumes the SSE stream server-side, saves messages to DB,
 * and returns the response text for delivery.
 */

import fs from 'fs';
import path from 'path';
import type { ChannelBinding } from './types';
import type { SSEEvent, TokenUsage, MessageContentBlock, FileAttachment } from '@/types';
import { extractArtifactMarkers, type BridgeArtifact } from './artifact-markers';
import { streamClaude } from '../claude-client';
import { materializeToolResultArtifacts } from '../tool-result-artifacts';
import {
  addMessage,
  getMessages,
  acquireSessionLock,
  renewSessionLock,
  releaseSessionLock,
  setSessionRuntimeStatus,
  updateSdkSessionId,
  updateSessionModel,
  syncSdkTasks,
  getSession,
  getProvider,
  getDefaultProviderId,
  getSetting,
} from '../db';
import crypto from 'crypto';

const FEISHU_ARTIFACT_SYSTEM_PROMPT = [
  'When the user should receive a local file or image in Feishu, you must append one marker per artifact at the end of your reply.',
  'This applies to screenshots, exported reports, generated documents, archives, and any other file you created or referenced for delivery.',
  'Use exactly one of these forms on its own line:',
  '<<FEISHU_IMAGE:/absolute/path/to/image.png>>',
  '<<FEISHU_FILE:/absolute/path/to/file.pdf>>',
  'Use absolute paths when possible. Only emit a marker after the file already exists on disk.',
  'Do not wrap the marker in code fences. Do not explain the marker syntax to the user.',
].join('\n');

const BRIDGE_CONTEXT_SYSTEM_PROMPT = [
  'You are replying through a remote chat bridge.',
  'Conversation history may be included for reference, but only the final current user message is the active request.',
  'Do not re-answer earlier user questions unless the current user message explicitly asks you to revisit them.',
  'Do not repeat prior conclusions or prior answers unless they are necessary to answer the current user message.',
].join('\n');

const HUMAN_GATE_SYSTEM_PROMPT = [
  'Some tasks require human interaction, such as login, QR scan, SMS verification, CAPTCHA, two-factor approval, device confirmation, or browser authorization.',
  'When you detect such a task, do not keep the bridge blocked waiting silently for the human step to finish.',
  'Before any long wait, prepare an actionable checkpoint and send it to the user immediately.',
  'Prefer non-blocking ways to expose the checkpoint: fetch a QR image or status through project APIs or tools when available.',
  'If a direct QR image is not available, open the relevant page, capture a concise screenshot, and return it through the Feishu artifact markers.',
  'After sending the checkpoint, stop the turn and tell the user exactly what to do next, then wait for the user to reply after finishing the human step.',
  'Ask the user to reply with a short confirmation such as "继续", "已扫码", "已验证", or "已完成" after the manual step is done.',
  'Do not launch or keep running a command that waits indefinitely for login success unless it has a clear timeout and you have already informed the user.',
  'If you suspect the task is blocked on user action, say so plainly instead of staying silent.',
].join('\n');

const TOOL_DISCOVERY_SYSTEM_PROMPT = [
  'This bridge is primarily used as a remote Feishu assistant.',
  'Before inventing a new script, workflow, or manual workaround, first inspect the tools, MCP servers, plugins, project commands, and existing local integrations already available in the runtime.',
  'If an existing tool or plugin can complete the task, prefer using it over rebuilding the same capability from scratch.',
  'For domain-specific tasks such as login, publishing, browser automation, scraping, or data retrieval, check the relevant project tooling first.',
  'When a tool returns a QR code, screenshot, document, or other structured artifact, return that artifact to the user instead of only summarizing it in text.',
  'When a tool is needed, invoke the real native tool instead of describing or simulating a tool call in text.',
  'Never output pseudo tool-call markup such as <function_calls>, <invoke>, XML tool tags, JSON tool plans, or placeholder function syntax to the user.',
  'After tool execution completes, always give the user a short plain-language conclusion or next step.',
  'For login, verification, and status-check flows, explicitly tell the user whether the operation succeeded, failed, or still needs human action.',
].join('\n');

const TOOL_RETRY_SYSTEM_PROMPT = [
  'Your previous draft tried to represent a tool call in text instead of using a native tool call.',
  'Retry this turn now.',
  'If a tool is needed, invoke the actual native tool directly.',
  'Do not emit <function_calls>, <invoke>, XML, JSON tool plans, or any other pseudo tool syntax.',
  'After the tool finishes, answer the user with the result in plain language.',
].join('\n');

function buildOperatingAgentSystemPrompt(workingDirectory?: string): string {
  const lines = [
    'You are the local coding agent running inside Claude Code CLI on the user\'s computer.',
    'You are not a cloud-only chat assistant.',
    'You can inspect local system state, read and write files, run shell commands, and operate installed tools within the runtime\'s granted permissions.',
    'When the user asks for local information, software installation, configuration, troubleshooting, or file operations, do the work directly instead of only describing manual steps.',
    'Only switch to tutorial-style guidance if the user explicitly asks for instructions or if direct execution is actually blocked.',
    'Never claim that you cannot access the local machine unless a tool call has already failed and you report that concrete failure.',
    'If the user asks about the active model, provider, permissions, or environment, inspect the runtime or configuration instead of guessing.',
    'For risky or destructive actions, verify intent briefly before proceeding.',
  ];

  if (workingDirectory) {
    lines.push(`Current working directory: ${workingDirectory}`);
  }

  return lines.join('\n');
}

// Remote bridge conversations already persist user/assistant messages in the
// local DB. Reusing the native Claude SDK resume chain here has proven brittle
// for long-running tool-heavy sessions and can wedge the bridge on stale
// tool_result pairing. Prefer DB-backed history for bridge stability.
function shouldUseSdkResumeForBinding(_binding: ChannelBinding): boolean {
  return false;
}

export interface PermissionRequestInfo {
  permissionRequestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestions?: unknown[];
}

/**
 * Callback invoked immediately when a permission_request SSE event arrives.
 * This breaks the deadlock: the stream blocks until the permission is resolved,
 * so we must forward the request to the IM *during* stream consumption,
 * not after it returns.
 */
export type OnPermissionRequest = (perm: PermissionRequestInfo) => Promise<void>;

/**
 * Callback invoked on each `text` SSE event with the full accumulated text so far.
 * Must return synchronously — the bridge-manager handles throttling and fire-and-forget.
 */
export type OnPartialText = (fullText: string) => void;

export type ProgressUpdate =
  | { kind: 'session_initialized'; model?: string }
  | { kind: 'tool_started'; toolName: string }
  | { kind: 'tool_progress'; toolName: string; elapsedSeconds: number }
  | { kind: 'notification'; title?: string; message?: string };

export type OnProgressUpdate = (update: ProgressUpdate) => void;

export interface ConversationResult {
  responseText: string;
  artifacts: BridgeArtifact[];
  tokenUsage: TokenUsage | null;
  hasError: boolean;
  errorMessage: string;
  actualToolUseCount: number;
  actualToolResultCount: number;
  lastToolResultSummary: string;
  usedPseudoToolMarkup: boolean;
  /** Permission request events that were forwarded during streaming */
  permissionRequests: PermissionRequestInfo[];
  /** SDK session ID captured from status/result events, for session resume */
  sdkSessionId: string | null;
}

/**
 * Process an inbound message: send to Claude, consume the response stream,
 * save to DB, and return the result.
 */
export async function processMessage(
  binding: ChannelBinding,
  text: string,
  onPermissionRequest?: OnPermissionRequest,
  abortSignal?: AbortSignal,
  files?: FileAttachment[],
  onPartialText?: OnPartialText,
  onProgressUpdate?: OnProgressUpdate,
): Promise<ConversationResult> {
  const sessionId = binding.codepilotSessionId;

  // Acquire session lock
  const lockId = crypto.randomBytes(8).toString('hex');
  const lockAcquired = acquireSessionLock(sessionId, lockId, `bridge-${binding.channelType}`, 600);
  if (!lockAcquired) {
    return {
      responseText: '',
      artifacts: [],
      tokenUsage: null,
      hasError: true,
      errorMessage: 'Session is busy processing another request',
      actualToolUseCount: 0,
      actualToolResultCount: 0,
      lastToolResultSummary: '',
      usedPseudoToolMarkup: false,
      permissionRequests: [],
      sdkSessionId: null,
    };
  }

  setSessionRuntimeStatus(sessionId, 'running');

  // Lock renewal interval
  const renewalInterval = setInterval(() => {
    try { renewSessionLock(sessionId, lockId, 600); } catch { /* best effort */ }
  }, 60_000);

  try {
    // Resolve session early — needed for workingDirectory and provider resolution
    const session = getSession(sessionId);
    const effectiveWorkingDirectory = binding.workingDirectory || session?.working_directory || undefined;

    // Save user message — persist file attachments to disk using the same
    // <!--files:JSON--> format as the desktop chat route, so the UI can render them.
    let savedContent = text;
    if (files && files.length > 0) {
      const workDir = effectiveWorkingDirectory || '';
      if (workDir) {
        try {
          const uploadDir = path.join(workDir, '.codepilot-uploads');
          if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
          }
          const fileMeta = files.map((f) => {
            const safeName = path.basename(f.name).replace(/[^a-zA-Z0-9._-]/g, '_');
            const filePath = path.join(uploadDir, `${Date.now()}-${safeName}`);
            const buffer = Buffer.from(f.data, 'base64');
            fs.writeFileSync(filePath, buffer);
            return { id: f.id, name: f.name, type: f.type, size: buffer.length, filePath };
          });
          savedContent = `<!--files:${JSON.stringify(fileMeta)}-->${text}`;
        } catch (err) {
          console.warn('[conversation-engine] Failed to persist file attachments:', err instanceof Error ? err.message : err);
          savedContent = `[${files.length} image(s) attached] ${text}`;
        }
      } else {
        savedContent = `[${files.length} image(s) attached] ${text}`;
      }
    }
    addMessage(sessionId, 'user', savedContent);

    // Resolve provider
    let resolvedProvider: import('@/types').ApiProvider | undefined;
    const providerId = session?.provider_id || '';
    if (providerId && providerId !== 'env') {
      resolvedProvider = getProvider(providerId);
    }
    if (!resolvedProvider) {
      const defaultId = getDefaultProviderId();
      if (defaultId) resolvedProvider = getProvider(defaultId);
    }

    // Effective model
    const effectiveModel = binding.model || session?.model || getSetting('default_model') || undefined;

    // Permission mode from binding mode
    let permissionMode: string;
    switch (binding.mode) {
      case 'plan': permissionMode = 'plan'; break;
      case 'ask': permissionMode = 'default'; break;
      default: permissionMode = 'acceptEdits'; break;
    }

    // Load conversation history for context
    const { messages: recentMsgs } = getMessages(sessionId, { limit: 50 });
    const historyMsgs = recentMsgs.slice(0, -1).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const abortController = new AbortController();
    if (abortSignal) {
      if (abortSignal.aborted) {
        abortController.abort();
      } else {
        abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
      }
    }

    const systemPromptParts = [session?.system_prompt || ''];
    if (binding.channelType === 'feishu') {
      systemPromptParts.push(BRIDGE_CONTEXT_SYSTEM_PROMPT);
      systemPromptParts.push(buildOperatingAgentSystemPrompt(effectiveWorkingDirectory));
      systemPromptParts.push(TOOL_DISCOVERY_SYSTEM_PROMPT);
      systemPromptParts.push(HUMAN_GATE_SYSTEM_PROMPT);
      systemPromptParts.push(FEISHU_ARTIFACT_SYSTEM_PROMPT);
    }
    const effectiveSystemPrompt = systemPromptParts
      .filter(Boolean)
      .join('\n\n')
      .trim() || undefined;

    const runStreamTurn = async (systemPrompt: string | undefined): Promise<ConversationResult> => {
      const stream = streamClaude({
        prompt: text,
        sessionId,
        sdkSessionId: shouldUseSdkResumeForBinding(binding)
          ? (binding.sdkSessionId || undefined)
          : undefined,
        model: effectiveModel,
        systemPrompt,
        workingDirectory: effectiveWorkingDirectory,
        abortController,
        permissionMode,
        provider: resolvedProvider,
        conversationHistory: historyMsgs,
        files,
        onRuntimeStatusChange: (status: string) => {
          try { setSessionRuntimeStatus(sessionId, status); } catch { /* best effort */ }
        },
      });

      // Consume the stream server-side (replicate collectStreamResponse pattern).
      // Permission requests are forwarded immediately via the callback during streaming
      // because the stream blocks until permission is resolved — we can't wait until after.
      return await consumeStream(
        stream,
        sessionId,
        effectiveWorkingDirectory,
        onPermissionRequest,
        onPartialText,
        onProgressUpdate,
      );
    };

    let result = await runStreamTurn(effectiveSystemPrompt);

    const shouldRetryPseudoToolTurn = binding.channelType === 'feishu'
      && !abortController.signal.aborted
      && !result.hasError
      && result.usedPseudoToolMarkup
      && result.actualToolUseCount === 0
      && result.actualToolResultCount === 0;

    if (shouldRetryPseudoToolTurn) {
      result = await runStreamTurn(
        [effectiveSystemPrompt, TOOL_RETRY_SYSTEM_PROMPT].filter(Boolean).join('\n\n'),
      );
    }

    return result;
  } finally {
    clearInterval(renewalInterval);
    releaseSessionLock(sessionId, lockId);
    setSessionRuntimeStatus(sessionId, 'idle');
  }
}

/**
 * Consume an SSE stream and extract response data.
 * Mirrors the collectStreamResponse() logic from chat/route.ts.
 */
async function consumeStream(
  stream: ReadableStream<string>,
  sessionId: string,
  workingDirectory: string | undefined,
  onPermissionRequest?: OnPermissionRequest,
  onPartialText?: OnPartialText,
  onProgressUpdate?: OnProgressUpdate,
): Promise<ConversationResult> {
  const reader = stream.getReader();
  const contentBlocks: MessageContentBlock[] = [];
  let currentText = '';
  /** Monotonically accumulated text for streaming preview — never resets on tool_use. */
  let previewText = '';
  let tokenUsage: TokenUsage | null = null;
  let hasError = false;
  let errorMessage = '';
  let actualToolUseCount = 0;
  let actualToolResultCount = 0;
  let lastToolResultSummary = '';
  const seenToolResultIds = new Set<string>();
  const toolResultArtifacts = new Map<string, BridgeArtifact[]>();
  const permissionRequests: PermissionRequestInfo[] = [];
  let capturedSdkSessionId: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const lines = value.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        let event: SSEEvent;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue;
        }

        switch (event.type) {
          case 'text':
            currentText += event.data;
            if (onPartialText) {
              previewText += event.data;
              try { onPartialText(previewText); } catch { /* non-critical */ }
            }
            break;

          case 'tool_use': {
            if (currentText.trim()) {
              contentBlocks.push({ type: 'text', text: currentText });
              currentText = '';
            }
            try {
              const toolData = JSON.parse(event.data);
              actualToolUseCount += 1;
              if (onProgressUpdate && toolData?.name) {
                try {
                  onProgressUpdate({
                    kind: 'tool_started',
                    toolName: String(toolData.name),
                  });
                } catch { /* non-critical */ }
              }
              contentBlocks.push({
                type: 'tool_use',
                id: toolData.id,
                name: toolData.name,
                input: toolData.input,
              });
            } catch { /* skip */ }
            break;
          }

          case 'tool_result': {
            try {
              const resultData = JSON.parse(event.data);
              const materializedArtifacts = materializeToolResultArtifacts(
                Array.isArray(resultData.artifacts) ? resultData.artifacts : [],
                sessionId,
                workingDirectory,
              );
              const newBlock = {
                type: 'tool_result' as const,
                tool_use_id: resultData.tool_use_id,
                content: typeof resultData.content === 'string' ? resultData.content : '',
                is_error: resultData.is_error || false,
              };
              if (materializedArtifacts.length > 0) {
                toolResultArtifacts.set(resultData.tool_use_id, materializedArtifacts);
              }
              if (seenToolResultIds.has(resultData.tool_use_id)) {
                const idx = contentBlocks.findIndex(
                  (b) => b.type === 'tool_result' && 'tool_use_id' in b && b.tool_use_id === resultData.tool_use_id
                );
                if (idx >= 0) {
                  const previousBlock = contentBlocks[idx];
                  if (
                    previousBlock.type === 'tool_result'
                    && previousBlock.content.trim()
                    && !newBlock.content.trim()
                    && !newBlock.is_error
                  ) {
                    break;
                  }
                  contentBlocks[idx] = newBlock;
                }
              } else {
                seenToolResultIds.add(resultData.tool_use_id);
                actualToolResultCount += 1;
                contentBlocks.push(newBlock);
              }
              if (newBlock.content.trim()) {
                lastToolResultSummary = newBlock.content.trim();
              }
            } catch { /* skip */ }
            break;
          }

          case 'permission_request': {
            try {
              const permData = JSON.parse(event.data);
              const perm: PermissionRequestInfo = {
                permissionRequestId: permData.permissionRequestId,
                toolName: permData.toolName,
                toolInput: permData.toolInput,
                suggestions: permData.suggestions,
              };
              permissionRequests.push(perm);
              // Forward immediately — the stream blocks until the permission is
              // resolved, so we must send the IM prompt *now*, not after the stream ends.
              if (onPermissionRequest) {
                onPermissionRequest(perm).catch((err) => {
                  console.error('[conversation-engine] Failed to forward permission request:', err);
                });
              }
            } catch { /* skip */ }
            break;
          }

          case 'status': {
            try {
              const statusData = JSON.parse(event.data);
              if (statusData.session_id) {
                capturedSdkSessionId = statusData.session_id;
                updateSdkSessionId(sessionId, statusData.session_id);
              }
              if (statusData.model) {
                updateSessionModel(sessionId, statusData.model);
              }
              if (onProgressUpdate) {
                if (statusData.notification) {
                  try {
                    onProgressUpdate({
                      kind: 'notification',
                      title: typeof statusData.title === 'string' ? statusData.title : undefined,
                      message: typeof statusData.message === 'string' ? statusData.message : undefined,
                    });
                  } catch { /* non-critical */ }
                } else if (statusData.session_id || statusData.model) {
                  try {
                    onProgressUpdate({
                      kind: 'session_initialized',
                      model: typeof statusData.model === 'string' ? statusData.model : undefined,
                    });
                  } catch { /* non-critical */ }
                }
              }
            } catch { /* skip */ }
            break;
          }

          case 'task_update': {
            try {
              const taskData = JSON.parse(event.data);
              if (taskData.session_id && taskData.todos) {
                syncSdkTasks(taskData.session_id, taskData.todos);
              }
            } catch { /* skip */ }
            break;
          }

          case 'error':
            hasError = true;
            errorMessage = event.data || 'Unknown error';
            break;

          case 'result': {
            try {
              const resultData = JSON.parse(event.data);
              if (resultData.usage) tokenUsage = resultData.usage;
              if (resultData.is_error) hasError = true;
              if (resultData.session_id) {
                capturedSdkSessionId = resultData.session_id;
                updateSdkSessionId(sessionId, resultData.session_id);
              }
            } catch { /* skip */ }
            break;
          }

          case 'tool_output': {
            if (!onProgressUpdate) break;
            try {
              const toolOutputData = JSON.parse(event.data);
              if (toolOutputData?._progress && toolOutputData.tool_name) {
                try {
                  onProgressUpdate({
                    kind: 'tool_progress',
                    toolName: String(toolOutputData.tool_name),
                    elapsedSeconds: Number(toolOutputData.elapsed_time_seconds) || 0,
                  });
                } catch { /* non-critical */ }
              }
            } catch { /* ignore non-JSON tool output */ }
            break;
          }

          // tool_timeout, mode_changed, done — ignored for bridge
        }
      }
    }

    // Flush remaining text
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }

    const { cleanedBlocks, artifacts: inlineArtifacts } = extractArtifactsFromContentBlocks(contentBlocks);
    const artifacts = mergeArtifacts(
      inlineArtifacts,
      Array.from(toolResultArtifacts.values()).flat(),
    );

    // Save assistant message
    if (cleanedBlocks.length > 0) {
      const hasToolBlocks = cleanedBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result'
      );
      const content = hasToolBlocks
        ? JSON.stringify(cleanedBlocks)
        : cleanedBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim();

      if (content) {
        addMessage(sessionId, 'assistant', content, tokenUsage ? JSON.stringify(tokenUsage) : null);
      }
    }

    // Extract text-only response for IM delivery
    let responseText = cleanedBlocks
      .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    if (!responseText && lastToolResultSummary) {
      responseText = summarizeToolResult(lastToolResultSummary);
    }

    return {
      responseText,
      artifacts,
      tokenUsage,
      hasError,
      errorMessage,
      actualToolUseCount,
      actualToolResultCount,
      lastToolResultSummary,
      usedPseudoToolMarkup: looksLikePseudoToolMarkup(responseText),
      permissionRequests,
      sdkSessionId: capturedSdkSessionId,
    };
  } catch (e) {
    // Best-effort save on stream error
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }
    const { cleanedBlocks, artifacts: inlineArtifacts } = extractArtifactsFromContentBlocks(contentBlocks);
    const artifacts = mergeArtifacts(
      inlineArtifacts,
      Array.from(toolResultArtifacts.values()).flat(),
    );
    if (cleanedBlocks.length > 0) {
      const hasToolBlocks = cleanedBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result'
      );
      const content = hasToolBlocks
        ? JSON.stringify(cleanedBlocks)
        : cleanedBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim();
      if (content) {
        addMessage(sessionId, 'assistant', content);
      }
    }

    const isAbort = e instanceof DOMException && e.name === 'AbortError'
      || e instanceof Error && e.name === 'AbortError';

    return {
      responseText: '',
      artifacts,
      tokenUsage,
      hasError: true,
      errorMessage: isAbort ? 'Task stopped by user' : (e instanceof Error ? e.message : 'Stream consumption error'),
      actualToolUseCount,
      actualToolResultCount,
      lastToolResultSummary,
      usedPseudoToolMarkup: false,
      permissionRequests,
      sdkSessionId: capturedSdkSessionId,
    };
  }
}

function summarizeToolResult(content: string): string {
  return content.trim();
}

function looksLikePseudoToolMarkup(text: string): boolean {
  if (!text) return false;
  return /<function_calls>/i.test(text)
    || /<invoke\s+name=/i.test(text)
    || /<\/invoke>/i.test(text);
}

function extractArtifactsFromContentBlocks(
  contentBlocks: MessageContentBlock[],
): { cleanedBlocks: MessageContentBlock[]; artifacts: BridgeArtifact[] } {
  const artifacts: BridgeArtifact[] = [];
  const seen = new Set<string>();
  const cleanedBlocks: MessageContentBlock[] = [];

  for (const block of contentBlocks) {
    if (block.type !== 'text') {
      cleanedBlocks.push(block);
      continue;
    }

    const extracted = extractArtifactMarkers(block.text);
    for (const artifact of extracted.artifacts) {
      const key = `${artifact.type}:${artifact.path}`;
      if (!seen.has(key)) {
        seen.add(key);
        artifacts.push(artifact);
      }
    }

    if (extracted.text) {
      cleanedBlocks.push({ ...block, text: extracted.text });
    }
  }

  const hasTextBlock = cleanedBlocks.some((block) => block.type === 'text' && block.text.trim());
  if (!hasTextBlock && artifacts.length > 0) {
    cleanedBlocks.push({ type: 'text', text: summarizeArtifacts(artifacts) });
  }

  return { cleanedBlocks, artifacts };
}

function mergeArtifacts(...artifactLists: BridgeArtifact[][]): BridgeArtifact[] {
  const merged: BridgeArtifact[] = [];
  const seen = new Set<string>();

  for (const artifactList of artifactLists) {
    for (const artifact of artifactList) {
      const key = `${artifact.type}:${artifact.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(artifact);
    }
  }

  return merged;
}

function summarizeArtifacts(artifacts: BridgeArtifact[]): string {
  const imageCount = artifacts.filter((artifact) => artifact.type === 'image').length;
  const fileCount = artifacts.filter((artifact) => artifact.type === 'file').length;
  const parts: string[] = [];

  if (imageCount > 0) {
    parts.push(`${imageCount} image attachment${imageCount > 1 ? 's' : ''}`);
  }
  if (fileCount > 0) {
    parts.push(`${fileCount} file attachment${fileCount > 1 ? 's' : ''}`);
  }

  return `Sent ${parts.join(' and ')}.`;
}
