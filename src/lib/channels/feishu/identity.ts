/**
 * Feishu bot identity resolution.
 */

import type * as lark from '@larksuiteoapi/node-sdk';
import type { FeishuBotInfo } from './types';

const LOG_TAG = '[feishu/identity]';

/** Fetch bot info from Feishu API. */
export async function getBotInfo(client: lark.Client): Promise<FeishuBotInfo | null> {
  try {
    const resp = await (client as any).bot.v3.botInfo.list();
    const bot = resp?.data?.bot;
    if (!bot) return null;
    return {
      appId: bot.app_id || '',
      botName: bot.app_name || '',
      openId: bot.open_id || '',
    };
  } catch (err) {
    console.error(LOG_TAG, 'Failed to get bot info:', err);
    return null;
  }
}
