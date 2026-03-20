import { useMemo } from 'react';
import type { Message } from '@/types';
import { getContextWindow } from '@/lib/model-context';

export interface ContextUsageData {
  modelName: string;
  contextWindow: number | null;
  used: number;
  ratio: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  hasData: boolean;
}

export function useContextUsage(messages: Message[], modelName: string): ContextUsageData {
  return useMemo(() => {
    const contextWindow = getContextWindow(modelName);
    const noData: ContextUsageData = {
      modelName,
      contextWindow,
      used: 0,
      ratio: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      hasData: false,
    };

    // Find the last assistant message with token_usage
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'assistant' || !msg.token_usage) continue;

      try {
        const usage = typeof msg.token_usage === 'string'
          ? JSON.parse(msg.token_usage)
          : msg.token_usage;

        const inputTokens = usage.input_tokens || 0;
        const cacheRead = usage.cache_read_input_tokens || 0;
        const cacheCreation = usage.cache_creation_input_tokens || 0;
        const outputTokens = usage.output_tokens || 0;
        const used = inputTokens + cacheRead + cacheCreation;

        return {
          modelName,
          contextWindow,
          used,
          ratio: contextWindow ? used / contextWindow : 0,
          cacheReadTokens: cacheRead,
          cacheCreationTokens: cacheCreation,
          outputTokens,
          hasData: true,
        };
      } catch {
        continue;
      }
    }

    return noData;
  }, [messages, modelName]);
}
