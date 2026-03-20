/**
 * Feishu Card Streaming Controller
 *
 * Primary path: CardKit v2 streaming API when available.
 * Fallback path: patch the same shared interactive message in place.
 * Optional path: CardKit v1 card instance updates when app scopes allow it.
 * Last-resort fallback: recreate content by editing the same message body.
 *
 * The fallback is necessary because @larksuiteoapi/node-sdk 1.59.0 exposes
 * cardkit.v1 only; there is no runtime cardkit.v2 client despite upstream code
 * targeting it.
 */

import type * as lark from '@larksuiteoapi/node-sdk';
import type { CardStreamController, ToolCallInfo } from '../types';
import type { CardStreamConfig } from './types';
import { optimizeMarkdown } from './outbound';

const LOG_TAG = '[card-controller]';
const MAX_TIMELINE_ENTRIES = 8;
const FEISHU_RATE_LIMIT_CODE = 230020;
const MIN_SAFE_UPDATE_INTERVAL_MS = 1500;
const RATE_LIMIT_RETRY_MS = 2000;

type ControllerMode = 'cardkit_v2' | 'message_patch' | 'cardkit_v1' | 'message_update';

interface CardState {
  mode: ControllerMode;
  chatId: string;
  cardId: string | null;
  messageId: string;
  sequence: number;
  lastUpdateAt: number;
  startTime: number;
  throttleTimer: ReturnType<typeof setTimeout> | null;
  pendingText: string | null;
  renderedText: string;
  toolCalls: ToolCallInfo[];
  thinking: boolean;
  toolDetailsExpanded: boolean;
  status: 'completed' | 'interrupted' | 'error' | null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractFeishuErrorCode(err: any): number | null {
  return err?.response?.data?.code
    ?? err?.response?.data?.error?.code
    ?? err?.code
    ?? null;
}

function isFeishuRateLimitError(err: any): boolean {
  return extractFeishuErrorCode(err) === FEISHU_RATE_LIMIT_CODE;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.floor(sec % 60);
  return `${min}m ${remSec}s`;
}

function truncateText(value: string | undefined, maxLen: number): string {
  if (!value) return '';
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 1)}…`;
}

function formatToolDuration(tool: ToolCallInfo): string {
  if (tool.finishedAt && tool.startedAt && tool.finishedAt >= tool.startedAt) {
    return formatElapsed(tool.finishedAt - tool.startedAt);
  }
  if (typeof tool.elapsedSeconds === 'number' && tool.elapsedSeconds > 0) {
    return formatElapsed(tool.elapsedSeconds * 1000);
  }
  if (tool.startedAt) {
    return formatElapsed(Date.now() - tool.startedAt);
  }
  return '';
}

function buildToolSummaryMarkdown(tools: ToolCallInfo[]): string {
  if (tools.length === 0) return '';

  const running = tools.filter((tool) => tool.status === 'running');
  const complete = tools.filter((tool) => tool.status === 'complete').length;
  const error = tools.filter((tool) => tool.status === 'error').length;
  const runningCount = running.length;
  const latestRunning = running[running.length - 1];
  const latestTool = tools[tools.length - 1];

  const lines = [
    `**工具过程**：共 ${tools.length} 次调用 · ✅ ${complete} · 🔄 ${runningCount} · ❌ ${error}`,
  ];

  if (latestRunning) {
    const elapsed = formatToolDuration(latestRunning);
    lines.push(`当前：\`${latestRunning.name}\`${elapsed ? ` · ${elapsed}` : ''}`);
    if (latestRunning.latestProgress) {
      lines.push(`进度：${truncateText(latestRunning.latestProgress, 120)}`);
    }
  } else if (latestTool) {
    const statusIcon = latestTool.status === 'complete' ? '✅' : latestTool.status === 'error' ? '❌' : '🔄';
    const duration = formatToolDuration(latestTool);
    lines.push(`最近：${statusIcon} \`${latestTool.name}\`${duration ? ` · ${duration}` : ''}`);
  }

  return lines.join('\n');
}

function buildToolDetailsMarkdown(tools: ToolCallInfo[]): string {
  if (tools.length === 0) return '';

  return tools.map((tool, index) => {
    const icon = tool.status === 'running' ? '🔄' : tool.status === 'complete' ? '✅' : '❌';
    const duration = formatToolDuration(tool);
    const lines = [`${index + 1}. ${icon} \`${tool.name}\`${duration ? ` · ${duration}` : ''}`];

    if (tool.inputSummary) {
      lines.push(`输入：${truncateText(tool.inputSummary, 220)}`);
    }

    const timeline = Array.isArray(tool.timeline) ? tool.timeline.slice(-MAX_TIMELINE_ENTRIES) : [];
    if (timeline.length > 0) {
      lines.push('过程：');
      for (const entry of timeline) {
        lines.push(`- ${truncateText(entry.label, 180)}`);
      }
    } else if (tool.latestProgress) {
      lines.push(`过程：${truncateText(tool.latestProgress, 180)}`);
    }

    if (tool.errorSummary) {
      lines.push(`结果：${truncateText(tool.errorSummary, 220)}`);
    } else if (tool.resultSummary) {
      lines.push(`结果：${truncateText(tool.resultSummary, 220)}`);
    }

    return lines.join('\n');
  }).join('\n\n');
}

function buildCardElements(
  text: string,
  tools: ToolCallInfo[],
  opts: {
    chatId?: string;
    thinking?: boolean;
    status?: 'completed' | 'interrupted' | 'error';
    startedAt?: number;
    toolDetailsExpanded?: boolean;
  } = {},
): any[] {
  const elements: any[] = [];
  const normalizedMainText = optimizeMarkdown(text || (opts.thinking ? '💭 Thinking...' : ''));

  elements.push({
    tag: 'markdown',
    content: normalizedMainText || ' ',
    text_size: 'normal',
    element_id: 'streaming_content',
  });

  const toolSummaryMd = buildToolSummaryMarkdown(tools);
  if (toolSummaryMd) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: toolSummaryMd,
      text_size: 'notation',
      element_id: 'tool_summary',
    });
  }

  if (opts.toolDetailsExpanded && tools.length > 0) {
    const toolDetailMd = buildToolDetailsMarkdown(tools);
    if (toolDetailMd) {
      elements.push({
        tag: 'markdown',
        content: optimizeMarkdown(toolDetailMd),
        text_size: 'normal',
        element_id: 'tool_details',
      });
    }
  }

  if (opts.status) {
    const footerParts: string[] = [];
    const statusLabels: Record<string, string> = {
      completed: '✅ Completed',
      interrupted: '⚠️ Interrupted',
      error: '❌ Error',
    };
    footerParts.push(statusLabels[opts.status] || opts.status);

    if (opts.startedAt) {
      footerParts.push(formatElapsed(Date.now() - opts.startedAt));
    }

    if (footerParts.length > 0) {
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'markdown',
        content: footerParts.join(' · '),
        text_size: 'notation',
        element_id: 'footer',
      });
    }
  }

  return elements;
}

function buildInteractiveCardJson(
  text: string,
  tools: ToolCallInfo[],
  opts: {
    chatId?: string;
    thinking?: boolean;
    status?: 'completed' | 'interrupted' | 'error';
    startedAt?: number;
    streamingMode?: boolean;
    toolDetailsExpanded?: boolean;
  } = {},
): string {
  return JSON.stringify({
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
      ...(opts.streamingMode ? { streaming_mode: true, summary: { content: '思考中...' } } : {}),
    },
    body: {
      elements: buildCardElements(text, tools, opts),
    },
  });
}

function supportsCardKitV2(client: lark.Client): boolean {
  const cardApi = (client as any)?.cardkit?.v2?.card;
  return !!cardApi
    && typeof cardApi.create === 'function'
    && typeof cardApi.streamContent === 'function'
    && typeof cardApi.setStreamingMode === 'function'
    && typeof cardApi.update === 'function';
}

function supportsCardKitV1(client: lark.Client): boolean {
  const cardApi = (client as any)?.cardkit?.v1?.card;
  return !!cardApi
    && typeof cardApi.create === 'function'
    && typeof cardApi.update === 'function';
}

function supportsMessagePatch(client: lark.Client): boolean {
  return typeof (client as any)?.im?.message?.patch === 'function';
}

class FeishuCardStreamController implements CardStreamController {
  private client: lark.Client;
  private config: CardStreamConfig;
  private cards = new Map<string, CardState>();

  constructor(client: lark.Client, config: CardStreamConfig) {
    this.client = client;
    this.config = config;
  }

  async create(chatId: string, initialText: string, replyToMessageId?: string): Promise<string> {
    if (supportsCardKitV2(this.client)) {
      const messageId = await this.createViaCardKitV2(chatId, initialText, replyToMessageId);
      if (messageId) return messageId;
    }
    // Prefer shared interactive cards over CardKit v1 in local bridge mode.
    // CardKit v1 streams, but button callbacks on locally hosted cards can
    // surface Feishu-side 200340 errors before the callback reaches us.
    if (supportsMessagePatch(this.client)) {
      const messageId = await this.createViaMessagePatch(chatId, initialText, replyToMessageId);
      if (messageId) return messageId;
    }
    if (supportsCardKitV1(this.client)) {
      const messageId = await this.createViaCardKitV1(chatId, initialText, replyToMessageId);
      if (messageId) return messageId;
    }
    return this.createViaMessageUpdate(chatId, initialText, replyToMessageId);
  }

  async update(messageId: string, text: string): Promise<'ok' | 'fail'> {
    const state = this.cards.get(messageId);
    if (!state) return 'fail';

    if (state.thinking && text.trim()) {
      state.thinking = false;
    }

    state.pendingText = text;
    state.renderedText = text;
    const elapsed = Date.now() - state.lastUpdateAt;
    const throttleMs = Math.max(this.config.throttleMs, MIN_SAFE_UPDATE_INTERVAL_MS);
    if (elapsed < throttleMs) {
      if (!state.throttleTimer) {
        state.throttleTimer = setTimeout(() => {
          state.throttleTimer = null;
          if (state.pendingText !== null) {
            this.flushUpdate(state).catch(() => {});
          }
        }, throttleMs - elapsed);
      }
      return 'ok';
    }

    return this.flushUpdate(state);
  }

  updateToolCalls(messageId: string, tools: ToolCallInfo[]): void {
    const state = this.cards.get(messageId);
    if (!state) return;
    state.toolCalls = tools;

    const elapsed = Date.now() - state.lastUpdateAt;
    const throttleMs = Math.max(this.config.throttleMs, MIN_SAFE_UPDATE_INTERVAL_MS);
    if (elapsed >= throttleMs) {
      this.flushUpdate(state).catch(() => {});
    } else if (!state.throttleTimer) {
      state.throttleTimer = setTimeout(() => {
        state.throttleTimer = null;
        this.flushUpdate(state).catch(() => {});
      }, throttleMs - elapsed);
    }
  }

  setThinking(messageId: string): void {
    const state = this.cards.get(messageId);
    if (!state) return;
    state.thinking = true;
  }

  async handleCallback(_messageId: string, _callbackData: string): Promise<boolean> {
    return false;
  }

  async finalize(
    messageId: string,
    finalText: string,
    status: 'completed' | 'interrupted' | 'error' = 'completed',
  ): Promise<void> {
    const state = this.cards.get(messageId);
    if (!state) return;

    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }

    state.renderedText = finalText;
    state.status = status;
    state.thinking = false;
    state.pendingText = finalText;

    try {
      const throttleMs = Math.max(this.config.throttleMs, MIN_SAFE_UPDATE_INTERVAL_MS);
      const elapsed = Date.now() - state.lastUpdateAt;
      if (elapsed < throttleMs) {
        await delay(throttleMs - elapsed);
      }

      if (state.mode === 'cardkit_v2' && state.cardId) {
        state.sequence++;
        await (this.client as any).cardkit.v2.card.setStreamingMode({
          path: { card_id: state.cardId },
          data: { streaming_mode: false, sequence: state.sequence },
        });

        state.sequence++;
        await (this.client as any).cardkit.v2.card.update({
          path: { card_id: state.cardId },
          data: {
            type: 'card_json',
            data: buildInteractiveCardJson(finalText, state.toolCalls, {
              chatId: state.chatId,
              status,
              startedAt: state.startTime,
              toolDetailsExpanded: state.toolDetailsExpanded,
            }),
            sequence: state.sequence,
          },
        });
      } else if (state.mode === 'message_patch') {
        await this.client.im.message.patch({
          path: { message_id: messageId },
          data: {
            content: buildInteractiveCardJson(finalText, state.toolCalls, {
              chatId: state.chatId,
              status,
              startedAt: state.startTime,
              toolDetailsExpanded: state.toolDetailsExpanded,
            }),
          },
        });
      } else if (state.mode === 'cardkit_v1' && state.cardId) {
        state.sequence++;
        await (this.client as any).cardkit.v1.card.update({
          path: { card_id: state.cardId },
          data: {
            sequence: state.sequence,
            card: {
              type: 'card_json',
              data: buildInteractiveCardJson(finalText, state.toolCalls, {
                chatId: state.chatId,
                status,
                startedAt: state.startTime,
                toolDetailsExpanded: state.toolDetailsExpanded,
              }),
            },
          },
        });
      } else {
        await this.client.im.message.update({
          path: { message_id: messageId },
          data: {
            msg_type: 'interactive',
            content: buildInteractiveCardJson(finalText, state.toolCalls, {
              chatId: state.chatId,
              status,
              startedAt: state.startTime,
              toolDetailsExpanded: state.toolDetailsExpanded,
            }),
          },
        });
      }
      state.lastUpdateAt = Date.now();
    } catch (err: any) {
      if (isFeishuRateLimitError(err)) {
        try {
          await delay(RATE_LIMIT_RETRY_MS);
          state.lastUpdateAt = Date.now();
          await this.finalize(messageId, finalText, status);
          return;
        } catch (retryErr: any) {
          console.error(LOG_TAG, 'Finalize retry failed:', retryErr?.message || retryErr);
          return;
        }
      }
      console.error(LOG_TAG, 'Finalize failed:', err?.message || err);
    }
  }

  private async createViaCardKitV2(chatId: string, initialText: string, replyToMessageId?: string): Promise<string> {
    try {
      const createResp = await (this.client as any).cardkit.v2.card.create({
        data: {
          type: 'card_json',
          data: buildInteractiveCardJson(initialText || '💭 Thinking...', [], {
            chatId,
            thinking: !initialText,
            streamingMode: true,
          }),
        },
      });
      const cardId = createResp?.data?.card_id;
      if (!cardId) {
        console.error(LOG_TAG, 'CardKit v2 create returned no card_id');
        return '';
      }

      const cardContent = JSON.stringify({ type: 'card', data: { card_id: cardId } });
      let msgResp: any;
      if (replyToMessageId) {
        msgResp = await this.client.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content: cardContent, msg_type: 'interactive' },
        });
      } else {
        msgResp = await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, content: cardContent, msg_type: 'interactive' },
        });
      }

      const messageId = msgResp?.data?.message_id || '';
      if (!messageId) return '';

      console.log(LOG_TAG, 'Created streaming card via CardKit v2:', messageId);
      this.cards.set(messageId, {
        mode: 'cardkit_v2',
        chatId,
        cardId,
        messageId,
        sequence: 0,
        lastUpdateAt: Date.now(),
        startTime: Date.now(),
        throttleTimer: null,
        pendingText: null,
        renderedText: initialText || '💭 Thinking...',
        toolCalls: [],
        thinking: !initialText,
        toolDetailsExpanded: false,
        status: null,
      });
      return messageId;
    } catch (err: any) {
      console.error(LOG_TAG, 'CardKit v2 create failed:', err?.message || err);
      return '';
    }
  }

  private async createViaCardKitV1(chatId: string, initialText: string, replyToMessageId?: string): Promise<string> {
    try {
      const createResp = await (this.client as any).cardkit.v1.card.create({
        data: {
          type: 'card_json',
          data: buildInteractiveCardJson(initialText || '💭 Thinking...', [], {
            chatId,
            thinking: !initialText,
          }),
        },
      });
      const createdCardId = createResp?.data?.card_id;
      if (!createdCardId) {
        console.error(LOG_TAG, 'CardKit v1 create returned no card_id');
        return '';
      }

      const content = JSON.stringify({ type: 'card', data: { card_id: createdCardId } });
      let resp: any;
      if (replyToMessageId) {
        resp = await this.client.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { msg_type: 'interactive', content },
        });
      } else {
        resp = await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'interactive', content },
        });
      }

      const messageId = resp?.data?.message_id || '';
      if (!messageId) {
        console.error(LOG_TAG, 'CardKit v1 message send returned no message_id');
        return '';
      }

      let cardId = createdCardId;
      try {
        const convertResp = await (this.client as any).cardkit.v1.card.idConvert({
          data: { message_id: messageId },
        });
        cardId = convertResp?.data?.card_id || createdCardId;
      } catch {
        cardId = createdCardId;
      }

      console.log(LOG_TAG, 'Created streaming card via CardKit v1:', messageId);
      this.cards.set(messageId, {
        mode: 'cardkit_v1',
        chatId,
        cardId,
        messageId,
        sequence: 0,
        lastUpdateAt: Date.now(),
        startTime: Date.now(),
        throttleTimer: null,
        pendingText: null,
        renderedText: initialText || '💭 Thinking...',
        toolCalls: [],
        thinking: !initialText,
        toolDetailsExpanded: false,
        status: null,
      });
      return messageId;
    } catch (err: any) {
      console.error(LOG_TAG, 'CardKit v1 create failed:', err?.message || err);
      return '';
    }
  }

  private async createViaMessagePatch(chatId: string, initialText: string, replyToMessageId?: string): Promise<string> {
    try {
      let resp: any;
      const content = buildInteractiveCardJson(initialText || '💭 Thinking...', [], {
        chatId,
        thinking: !initialText,
      });

      if (replyToMessageId) {
        resp = await this.client.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { msg_type: 'interactive', content },
        });
      } else {
        resp = await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'interactive', content },
        });
      }

      const messageId = resp?.data?.message_id || '';
      if (!messageId) {
        console.error(LOG_TAG, 'Shared-card create returned no message_id');
        return '';
      }

      console.log(LOG_TAG, 'Created streaming card via message.patch:', messageId);
      this.cards.set(messageId, {
        mode: 'message_patch',
        chatId,
        cardId: null,
        messageId,
        sequence: 0,
        lastUpdateAt: Date.now(),
        startTime: Date.now(),
        throttleTimer: null,
        pendingText: null,
        renderedText: initialText || '💭 Thinking...',
        toolCalls: [],
        thinking: !initialText,
        toolDetailsExpanded: false,
        status: null,
      });
      return messageId;
    } catch (err: any) {
      console.error(LOG_TAG, 'Shared-card create failed:', err?.message || err);
      return '';
    }
  }

  private async createViaMessageUpdate(chatId: string, initialText: string, replyToMessageId?: string): Promise<string> {
    try {
      let resp: any;
      const content = buildInteractiveCardJson(initialText || '💭 Thinking...', [], {
        chatId,
        thinking: !initialText,
      });

      if (replyToMessageId) {
        resp = await this.client.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { msg_type: 'interactive', content },
        });
      } else {
        resp = await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'interactive', content },
        });
      }

      const messageId = resp?.data?.message_id || '';
      if (!messageId) {
        console.error(LOG_TAG, 'Message-update create returned no message_id');
        return '';
      }

      console.log(LOG_TAG, 'Created streaming card via message.update:', messageId);
      this.cards.set(messageId, {
        mode: 'message_update',
        chatId,
        cardId: null,
        messageId,
        sequence: 0,
        lastUpdateAt: Date.now(),
        startTime: Date.now(),
        throttleTimer: null,
        pendingText: null,
        renderedText: initialText || '💭 Thinking...',
        toolCalls: [],
        thinking: !initialText,
        toolDetailsExpanded: false,
        status: null,
      });
      return messageId;
    } catch (err: any) {
      console.error(LOG_TAG, 'Message-update create failed:', err?.message || err);
      return '';
    }
  }

  private async flushUpdate(state: CardState): Promise<'ok' | 'fail'> {
    if (state.pendingText === null && state.toolCalls.length === 0) return 'ok';

    const nextText = state.pendingText ?? state.renderedText ?? '';
    state.pendingText = null;
    state.renderedText = nextText;

    try {
      if (state.mode === 'cardkit_v2' && state.cardId) {
        if (state.status) {
          state.sequence++;
          await (this.client as any).cardkit.v2.card.update({
            path: { card_id: state.cardId },
            data: {
              type: 'card_json',
              data: buildInteractiveCardJson(nextText, state.toolCalls, {
                chatId: state.chatId,
                thinking: state.thinking,
                status: state.status,
                startedAt: state.startTime,
                toolDetailsExpanded: state.toolDetailsExpanded,
              }),
              sequence: state.sequence,
            },
          });
        } else {
          let content = nextText;
          const toolMd = buildToolSummaryMarkdown(state.toolCalls);
          if (toolMd) {
            content = content ? `${content}\n\n${toolMd}` : toolMd;
          }

          state.sequence++;
          await (this.client as any).cardkit.v2.card.streamContent({
            path: { card_id: state.cardId },
            data: { content, sequence: state.sequence },
          });
        }
      } else if (state.mode === 'message_patch') {
        await this.client.im.message.patch({
          path: { message_id: state.messageId },
          data: {
            content: buildInteractiveCardJson(nextText, state.toolCalls, {
              chatId: state.chatId,
              thinking: state.thinking,
              status: state.status || undefined,
              startedAt: state.startTime,
              toolDetailsExpanded: state.toolDetailsExpanded,
            }),
          },
        });
      } else if (state.mode === 'cardkit_v1' && state.cardId) {
        state.sequence++;
        await (this.client as any).cardkit.v1.card.update({
          path: { card_id: state.cardId },
          data: {
            sequence: state.sequence,
            card: {
              type: 'card_json',
              data: buildInteractiveCardJson(nextText, state.toolCalls, {
                chatId: state.chatId,
                thinking: state.thinking,
                status: state.status || undefined,
                startedAt: state.startTime,
                toolDetailsExpanded: state.toolDetailsExpanded,
              }),
            },
          },
        });
      } else {
        await this.client.im.message.update({
          path: { message_id: state.messageId },
          data: {
            msg_type: 'interactive',
            content: buildInteractiveCardJson(nextText, state.toolCalls, {
              chatId: state.chatId,
              thinking: state.thinking,
              status: state.status || undefined,
              startedAt: state.startTime,
              toolDetailsExpanded: state.toolDetailsExpanded,
            }),
          },
        });
      }

      state.lastUpdateAt = Date.now();
      return 'ok';
    } catch (err: any) {
      if (isFeishuRateLimitError(err)) {
        state.pendingText = nextText;
        state.lastUpdateAt = Date.now();
        if (!state.throttleTimer) {
          state.throttleTimer = setTimeout(() => {
            state.throttleTimer = null;
            this.flushUpdate(state).catch(() => {});
          }, RATE_LIMIT_RETRY_MS);
        }
        console.warn(LOG_TAG, 'Stream update hit Feishu rate limit; backing off and retrying.');
        return 'ok';
      }
      console.error(LOG_TAG, 'Stream update failed:', err?.message || err);
      return 'fail';
    }
  }
}

export function createCardStreamController(
  client: lark.Client,
  config: CardStreamConfig,
): CardStreamController {
  return new FeishuCardStreamController(client, config);
}
