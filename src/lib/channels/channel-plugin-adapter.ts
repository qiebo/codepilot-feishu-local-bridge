/**
 * ChannelPluginAdapter — bridges a ChannelPlugin to BaseChannelAdapter.
 *
 * This allows any ChannelPlugin implementation to be used as a
 * BaseChannelAdapter in the bridge system without modification.
 */

import { BaseChannelAdapter } from '../bridge/channel-adapter';
import type {
  ChannelType,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from '../bridge/types';
import type { CardStreamController, ChannelPlugin } from './types';

export class ChannelPluginAdapter extends BaseChannelAdapter {
  private plugin: ChannelPlugin;

  constructor(plugin: ChannelPlugin) {
    super();
    this.plugin = plugin;
  }

  get channelType(): ChannelType {
    return this.plugin.meta.channelType;
  }

  /** Expose the underlying plugin for direct access (e.g. message-actions). */
  getPlugin(): ChannelPlugin {
    return this.plugin;
  }

  async start(): Promise<void> {
    return this.plugin.start();
  }

  async stop(): Promise<void> {
    return this.plugin.stop();
  }

  isRunning(): boolean {
    return this.plugin.isRunning();
  }

  async consumeOne(): Promise<InboundMessage | null> {
    return this.plugin.consumeOne();
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    return this.plugin.send(message);
  }

  validateConfig(): string | null {
    return this.plugin.validateConfig();
  }

  isAuthorized(userId: string, chatId: string): boolean {
    return this.plugin.isAuthorized(userId, chatId);
  }

  onMessageStart(chatId: string): void {
    this.plugin.onMessageStart?.(chatId);
  }

  onMessageEnd(chatId: string): void {
    this.plugin.onMessageEnd?.(chatId);
  }

  getCardStreamController(): CardStreamController | null {
    return this.plugin.getCardStreamController?.() ?? null;
  }

  async sendLocalImage(chatId: string, filePath: string): Promise<SendResult> {
    if (!this.plugin.sendLocalImage) {
      return { ok: false, error: 'Local image sending not supported' };
    }
    return this.plugin.sendLocalImage(chatId, filePath);
  }

  async sendLocalFile(chatId: string, filePath: string): Promise<SendResult> {
    if (!this.plugin.sendLocalFile) {
      return { ok: false, error: 'Local file sending not supported' };
    }
    return this.plugin.sendLocalFile(chatId, filePath);
  }
}
