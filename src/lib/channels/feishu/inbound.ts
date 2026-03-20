/**
 * Feishu inbound message processing.
 *
 * Converts raw Feishu event data into InboundMessage for the bridge queue.
 */

import type { InboundMessage } from '../../bridge/types';
import type { FeishuConfig } from './types';

const LOG_TAG = '[feishu/inbound]';

function extractTextFromTextMessage(rawContent: string): string {
  try {
    const content = JSON.parse(rawContent || '{}');
    return content.text || '';
  } catch {
    return rawContent || '';
  }
}

function extractTextFromPostMessage(rawContent: string): string {
  try {
    const parsed = JSON.parse(rawContent || '{}');
    const locale = Array.isArray(parsed?.content)
      ? parsed
      : Object.values(parsed || {}).find((value: any) => value && typeof value === 'object' && Array.isArray((value as any).content)) as any;
    if (!locale || !Array.isArray(locale.content)) return '';

    const lines: string[] = [];
    if (locale.title && typeof locale.title === 'string' && locale.title.trim()) {
      lines.push(locale.title.trim());
    }

    for (const paragraph of locale.content as any[]) {
      if (!Array.isArray(paragraph)) continue;
      const parts: string[] = [];
      for (const item of paragraph) {
        if (!item || typeof item !== 'object') continue;
        switch (item.tag) {
          case 'text':
          case 'code_block':
          case 'md':
            if (typeof item.text === 'string') parts.push(item.text);
            break;
          case 'a':
            if (typeof item.text === 'string' && item.text.trim()) {
              parts.push(item.text);
            } else if (typeof item.href === 'string' && item.href.trim()) {
              parts.push(item.href);
            }
            break;
          case 'at':
            if (typeof item.user_name === 'string' && item.user_name.trim()) {
              parts.push(`@${item.user_name}`);
            }
            break;
          case 'img':
            parts.push('[图片]');
            break;
          case 'emotion':
            parts.push('[表情]');
            break;
          default:
            if (typeof item.text === 'string' && item.text.trim()) {
              parts.push(item.text);
            }
            break;
        }
      }

      const line = parts.join('').trim();
      if (line) {
        lines.push(line);
      }
    }

    return lines.join('\n');
  } catch (err) {
    console.warn(LOG_TAG, 'Failed to parse post message content:', err);
    return '';
  }
}

/** Parse a raw Feishu im.message.receive_v1 event into an InboundMessage. */
export function parseInboundMessage(
  eventData: any,
  _config: FeishuConfig,
): InboundMessage | null {
  try {
    const event = eventData?.event ?? eventData;
    const message = event?.message;
    if (!message) return null;

    const chatId = message.chat_id || '';
    const messageId = message.message_id || '';
    const sender = event.sender?.sender_id?.open_id || '';
    const msgType = message.message_type;

    let text = '';
    if (msgType === 'text') {
      text = extractTextFromTextMessage(message.content || '');
    } else if (msgType === 'post') {
      text = extractTextFromPostMessage(message.content || '');
    } else {
      console.warn(LOG_TAG, `Skipping unsupported message type: ${msgType}`);
      return null;
    }

    if (!text.trim()) return null;

    // Build thread-session address if applicable
    const rootId = message.root_id || '';
    const effectiveChatId = rootId ? `${chatId}:thread:${rootId}` : chatId;

    return {
      messageId,
      address: {
        channelType: 'feishu',
        chatId: effectiveChatId,
        userId: sender,
      },
      text: text.trim(),
      timestamp: parseInt(message.create_time, 10) || Date.now(),
    };
  } catch (err) {
    console.error(LOG_TAG, 'Failed to parse inbound message:', err);
    return null;
  }
}
