/**
 * FeishuChannelPlugin — implements ChannelPlugin for Feishu/Lark.
 *
 * Composes: gateway (WS), inbound (parsing), outbound (sending),
 * identity (bot info), policy (access control), card-controller (streaming).
 */

import type { InboundMessage, OutboundMessage, SendResult } from '../../bridge/types';
import type { ChannelPlugin, ChannelCapabilities, ChannelMeta, CardStreamController } from '../types';
import type { FeishuConfig } from './types';
import { loadFeishuConfig, validateFeishuConfig } from './config';
import { FeishuGateway } from './gateway';
import { parseInboundMessage } from './inbound';
import { readMessages } from './message-actions';
import { sendLocalFile, sendLocalImage, sendMessage, addReaction, removeReaction } from './outbound';
import { isUserAuthorized } from './policy';
import { createCardStreamController } from './card-controller';
import { getChannelOffset, getMessages, listChannelBindings, setChannelOffset } from '../../db';

export class FeishuChannelPlugin implements ChannelPlugin<FeishuConfig> {
  readonly meta: ChannelMeta = {
    channelType: 'feishu',
    displayName: 'Feishu / Lark',
  };

  private config: FeishuConfig | null = null;
  private gateway: FeishuGateway | null = null;
  private messageQueue: InboundMessage[] = [];
  private waitResolve: ((msg: InboundMessage | null) => void) | null = null;
  private cardController: CardStreamController | null = null;
  /** Track last received messageId per chatId for reaction acknowledgment. */
  private lastMessageIdByChat = new Map<string, string>();
  /** Track active reaction IDs per chatId so we can remove them on completion. */
  private activeReactions = new Map<string, { messageId: string; reactionId: string }>();
  /** Feishu WS can occasionally miss inbound events; use REST polling as a safety net. */
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private pollingInFlight = false;
  private lastPolledCreateTime = 0;
  private recentInboundIds = new Map<string, number>();

  loadConfig(): FeishuConfig | null {
    this.config = loadFeishuConfig();
    return this.config;
  }

  getConfig(): FeishuConfig | null {
    return this.config;
  }

  getCapabilities(): ChannelCapabilities {
    return {
      streaming: true,
      threadReply: true,
      search: false,  // True server-side search requires user_access_token; we only have local filtering
      history: true,
      reactions: false,
    };
  }

  validateConfig(): string | null {
    if (!this.config) {
      this.loadConfig();
    }
    return validateFeishuConfig(this.config);
  }

  async start(): Promise<void> {
    if (!this.config) {
      this.config = loadFeishuConfig();
    }
    if (!this.config) throw new Error('Feishu config not loaded');

    this.gateway = new FeishuGateway(this.config);

    // Register message handler — pushes to internal queue
    this.gateway.registerMessageHandler((data: unknown) => {
      const msg = parseInboundMessage(data, this.config!);
      if (!msg) return;
      this.enqueueMessage(msg);
    });

    // Register card action handler — converts button clicks to callback messages.
    // Gateway guarantees 3-second response; this handler should stay lightweight.
    // Supports two button value formats:
    //   1. { callback_data: "perm:allow:xxx" }  — CodePilot permission buttons
    //   2. { action: "app_auth_done", operation_id: "xxx" }  — OpenClaw-style buttons
    this.gateway.registerCardActionHandler(async (data: unknown) => {
      const event = data as any;
      console.log('[feishu/plugin]', 'Card action raw event:', JSON.stringify(event).slice(0, 500));
      const value = event?.action?.value ?? {};
      // Feishu card.action.trigger v2 callback structure (per official docs):
      //   event.operator.open_id, event.context.open_chat_id, event.context.open_message_id
      // SDK InteractiveCardActionEvent (older type) flattens to:
      //   event.open_id, event.open_message_id
      // WSClient monkey-patch may deliver either format — try both paths.
      // Additionally, we embed chatId in button value as ultimate fallback.
      const chatId = event?.context?.open_chat_id || value.chatId || '';
      const messageId = event?.context?.open_message_id || event?.open_message_id || '';
      const userId = event?.operator?.open_id || event?.open_id || '';

      // Format 1: callback_data (permission buttons)
      const callbackData = value.callback_data;
      if (callbackData && chatId) {
        const callbackMsg: InboundMessage = {
          messageId: messageId || `card_action_${Date.now()}`,
          address: {
            channelType: 'feishu',
            chatId,
            userId,
          },
          text: '',
          timestamp: Date.now(),
          callbackData,
          callbackMessageId: messageId,
        };
        console.log('[feishu/plugin]', 'Card action (callback_data):', callbackData);
        this.enqueueMessage(callbackMsg);
        return {
          toast: { type: 'info' as const, content: '已收到，正在处理...' },
        };
      }

      // Format 2: action / operation_id (OpenClaw-style buttons)
      const action = value.action;
      const operationId = value.operation_id;
      if (action) {
        // Encode as callbackData so the existing bridge-manager callback path
        // can handle it. Format: "action:{action}:{operation_id}"
        const syntheticCallback = operationId
          ? `action:${action}:${operationId}`
          : `action:${action}`;
        const actionMsg: InboundMessage = {
          messageId: messageId || `card_action_${Date.now()}`,
          address: {
            channelType: 'feishu',
            chatId,
            userId,
          },
          text: '',
          timestamp: Date.now(),
          callbackData: syntheticCallback,
          callbackMessageId: messageId,
        };
        console.log('[feishu/plugin]', 'Card action (action):', action, operationId ?? '');
        this.enqueueMessage(actionMsg);
        return {
          toast: { type: 'info' as const, content: '已收到，正在处理...' },
        };
      }

      // Unknown button format — still return a valid toast to prevent 200340
      console.warn('[feishu/plugin]', 'Unknown card action value:', JSON.stringify(value).slice(0, 200));
      return {
        toast: { type: 'info' as const, content: '已收到' },
      };
    });

    await this.gateway.start();
    this.startPollingFallback();
  }

  async stop(): Promise<void> {
    if (this.gateway) {
      await this.gateway.stop();
      this.gateway = null;
    }
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    this.pollingInFlight = false;
    this.cardController = null;
    // Unblock any waiting consumer
    if (this.waitResolve) {
      this.waitResolve(null);
      this.waitResolve = null;
    }
  }

  isRunning(): boolean {
    return this.gateway?.isRunning() ?? false;
  }

  private enqueueMessage(msg: InboundMessage): void {
    if (!msg.callbackData && msg.messageId) {
      const now = Date.now();
      const existing = this.recentInboundIds.get(msg.messageId);
      if (existing && now - existing < 24 * 60 * 60 * 1000) {
        return;
      }
      this.recentInboundIds.set(msg.messageId, now);
      if (this.recentInboundIds.size > 500) {
        for (const [messageId, seenAt] of this.recentInboundIds) {
          if (now - seenAt > 24 * 60 * 60 * 1000) {
            this.recentInboundIds.delete(messageId);
          }
        }
      }
    }

    // Track messageId for reaction acknowledgment (skip callback messages)
    if (msg.messageId && !msg.callbackData) {
      this.lastMessageIdByChat.set(msg.address.chatId, msg.messageId);
    }
    if (this.waitResolve) {
      const resolve = this.waitResolve;
      this.waitResolve = null;
      resolve(msg);
    } else {
      this.messageQueue.push(msg);
    }
  }

  async consumeOne(): Promise<InboundMessage | null> {
    if (this.messageQueue.length > 0) {
      return this.messageQueue.shift()!;
    }
    return new Promise<InboundMessage | null>((resolve) => {
      this.waitResolve = resolve;
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const client = this.gateway?.getRestClient();
    if (!client) return { ok: false, error: 'Not connected' };
    return sendMessage(client, message);
  }

  async sendLocalImage(chatId: string, filePath: string): Promise<SendResult> {
    const client = this.gateway?.getRestClient();
    if (!client) return { ok: false, error: 'Not connected' };
    const imageResult = await sendLocalImage(client, chatId, filePath);
    if (imageResult.ok) return imageResult;
    return sendLocalFile(client, chatId, filePath);
  }

  async sendLocalFile(chatId: string, filePath: string): Promise<SendResult> {
    const client = this.gateway?.getRestClient();
    if (!client) return { ok: false, error: 'Not connected' };
    return sendLocalFile(client, chatId, filePath);
  }

  isAuthorized(userId: string, chatId: string): boolean {
    if (!this.config) return false;
    return isUserAuthorized(this.config, userId, chatId);
  }

  /** Add emoji reaction to acknowledge message receipt. */
  onMessageStart(chatId: string): void {
    const client = this.gateway?.getRestClient();
    const messageId = this.lastMessageIdByChat.get(chatId);
    if (!client || !messageId) return;
    // Fire-and-forget — don't block message processing
    addReaction(client, messageId, 'Typing').then((reactionId) => {
      if (reactionId) {
        this.activeReactions.set(chatId, { messageId, reactionId });
      }
    }).catch(() => {});
  }

  /** Remove the "processing" reaction after response is sent. */
  onMessageEnd(chatId: string): void {
    const client = this.gateway?.getRestClient();
    const reaction = this.activeReactions.get(chatId);
    if (!client || !reaction) return;
    this.activeReactions.delete(chatId);
    removeReaction(client, reaction.messageId, reaction.reactionId).catch(() => {});
  }

  getCardStreamController(): CardStreamController | null {
    if (this.cardController) {
      return this.cardController;
    }

    const client = this.gateway?.getRestClient();
    if (!client) {
      console.log('[feishu/plugin] getCardStreamController: no client');
      return null;
    }
    if (!this.config) {
      console.log('[feishu/plugin] getCardStreamController: no config');
      return null;
    }
    this.cardController = createCardStreamController(client, this.config.cardStreamConfig);
    return this.cardController;
  }

  /** Expose gateway for direct access (e.g. message-actions need restClient). */
  get _gateway(): FeishuGateway | null {
    return this.gateway;
  }

  private startPollingFallback(): void {
    const storedOffset = Number(getChannelOffset('feishu'));
    if (Number.isFinite(storedOffset) && storedOffset > 0) {
      this.lastPolledCreateTime = storedOffset;
    } else {
      const activeBindings = listChannelBindings('feishu').filter((binding) => binding.active);
      let latestPersistedMessageTime = 0;
      for (const binding of activeBindings) {
        const latest = getMessages(binding.codepilotSessionId, { limit: 1 }).messages.at(-1);
        if (!latest?.created_at) continue;
        const epoch = Date.parse(latest.created_at.replace(' ', 'T') + 'Z');
        if (Number.isFinite(epoch)) {
          latestPersistedMessageTime = Math.max(latestPersistedMessageTime, epoch);
        }
      }
      this.lastPolledCreateTime = latestPersistedMessageTime || (Date.now() - (10 * 60 * 1000));
    }
    console.log('[feishu/poll]', `Starting REST fallback polling from offset ${this.lastPolledCreateTime}`);

    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
    }

    this.pollingTimer = setInterval(() => {
      void this.pollRecentMessages();
    }, 5000);

    void this.pollRecentMessages();
  }

  private async pollRecentMessages(): Promise<void> {
    if (this.pollingInFlight) return;

    const client = this.gateway?.getRestClient();
    if (!client || !this.config) return;

    this.pollingInFlight = true;
    let maxSeen = this.lastPolledCreateTime;

    try {
      const realChatIds = [...new Set(
        listChannelBindings('feishu')
          .filter((binding) => binding.active)
          .map((binding) => binding.chatId.split(':thread:')[0])
          .filter(Boolean),
      )];
      console.log('[feishu/poll]', `Polling ${realChatIds.length} chat(s) from offset ${this.lastPolledCreateTime}`);

      for (const chatId of realChatIds) {
        const result = await readMessages(client, chatId, { pageSize: 20 });
        const items = [...result.items].reverse();
        console.log('[feishu/poll]', `Fetched ${items.length} recent message(s) for chat ${chatId}`);

        for (const item of items) {
          const createTime = Number(item.createTime || 0);
          if (createTime && createTime <= this.lastPolledCreateTime) {
            continue;
          }

          if (createTime) {
            maxSeen = Math.max(maxSeen, createTime);
          }

          if (item.sender?.senderType !== 'user') {
            continue;
          }

          const parsed = parseInboundMessage({
            message: {
              chat_id: chatId,
              message_id: item.messageId,
              message_type: item.msgType,
              content: item.content,
              create_time: item.createTime,
              root_id: item.rootId || '',
            },
            sender: {
              sender_id: {
                open_id: item.sender?.id || '',
              },
            },
          }, this.config);

          if (parsed) {
            console.log('[feishu/poll]', `Recovered inbound message via REST fallback: ${item.messageId} (${item.msgType})`);
            this.enqueueMessage(parsed);
          }
        }
      }

      if (maxSeen > this.lastPolledCreateTime) {
        this.lastPolledCreateTime = maxSeen;
        setChannelOffset('feishu', String(maxSeen));
      }
    } catch (err) {
      console.warn('[feishu/poll]', 'REST fallback polling failed:', err instanceof Error ? err.message : err);
    } finally {
      this.pollingInFlight = false;
    }
  }
}
