/**
 * Bridge Manager — singleton orchestrator for the multi-IM bridge system.
 *
 * Manages adapter lifecycles, routes inbound messages through the
 * conversation engine, and coordinates permission handling.
 *
 * Uses globalThis to survive Next.js HMR in development.
 */

import fs from 'fs';
import path from 'path';
import type { BridgeStatus, InboundMessage, OutboundMessage, StreamingPreviewState } from './types';
import { createAdapter, getRegisteredTypes } from './channel-adapter';
import type { BaseChannelAdapter } from './channel-adapter';
// Side-effect import: triggers self-registration of all adapter factories
import './adapters';
import * as router from './channel-router';
import * as engine from './conversation-engine';
import type { ProgressUpdate } from './conversation-engine';
import * as broker from './permission-broker';
import { deliver, deliverRendered, chunkText } from './delivery-layer';
import { PLATFORM_LIMITS as limits } from './types';
import { markdownToTelegramChunks } from './markdown/telegram';
import { markdownToDiscordChunks } from './markdown/discord';
import { stripArtifactMarkers, type BridgeArtifact } from './artifact-markers';
import { getSetting, insertAuditLog, setSetting, updateChannelBinding, updateSessionModel } from '../db';
import { setBridgeModeActive } from '../telegram-bot';
import { escapeHtml } from './adapters/telegram-utils';
import {
  validateWorkingDirectory,
  validateSessionId,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from './security/validators';
import { ChannelPluginAdapter } from '../channels/channel-plugin-adapter';
import type { ToolCallInfo, ToolTimelineEntry } from '../channels/types';

/**
 * Extract the real platform chat_id from a potentially synthetic thread-session address.
 * Thread-session mode encodes addresses as `{real_chat_id}:thread:{root_id}`.
 */
function extractRealChatId(chatId: string): string {
  const threadIdx = chatId.indexOf(':thread:');
  return threadIdx >= 0 ? chatId.slice(0, threadIdx) : chatId;
}

const GLOBAL_KEY = '__bridge_manager__';
const BRIDGE_MODEL_ALIASES: Record<string, string> = {
  code: 'doubao-seed-2.0-code',
  pro: 'doubao-seed-2.0-pro',
  kimi: 'kimi-k2.5',
  'kimi-k2.5': 'kimi-k2.5',
  'doubao-seed-2.0-code': 'doubao-seed-2.0-code',
  'doubao-seed-2.0-pro': 'doubao-seed-2.0-pro',
};

const BRIDGE_MODEL_HELP = [
  '/model - Show current and available models',
  '/model code - Switch to doubao-seed-2.0-code',
  '/model pro - Switch to doubao-seed-2.0-pro',
  '/model kimi - Switch to kimi-k2.5',
].join('\n');

const FEISHU_STARTUP_GREETING = '你的小龙虾上线了。';
const CLAUDE_SETTINGS_PATH = path.join(process.env.HOME || '', '.claude', 'settings.json');
const CODEPILOT_RUNTIME_ENV_PATH = path.join(process.env.HOME || '', 'Applications', 'CodePilot-v2-runtime', 'codepilot.env');

// ── Streaming preview helpers ──────────────────────────────────

/** Generate a non-zero random 31-bit integer for use as draft_id. */
function generateDraftId(): number {
  return (Math.floor(Math.random() * 0x7FFFFFFE) + 1); // 1 .. 2^31-1
}

interface StreamConfig {
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
}

interface SparseStatusConfig {
  firstDelayMs: number;
  minIntervalMs: number;
  longRunningThresholdMs: number;
  longRunningRepeatMs: number;
  maxUpdates: number;
}

function syncClaudeModelDefaults(model: string): { updatedClaudeSettings: boolean; updatedRuntimeEnv: boolean; errors: string[] } {
  const result = {
    updatedClaudeSettings: false,
    updatedRuntimeEnv: false,
    errors: [] as string[],
  };

  process.env.ANTHROPIC_MODEL = model;

  try {
    const settingsDir = path.dirname(CLAUDE_SETTINGS_PATH);
    if (!fs.existsSync(settingsDir)) {
      fs.mkdirSync(settingsDir, { recursive: true });
    }

    let parsed: Record<string, any> = {};
    if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      const raw = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8').trim();
      parsed = raw ? JSON.parse(raw) : {};
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      parsed = {};
    }
    if (!parsed.env || typeof parsed.env !== 'object' || Array.isArray(parsed.env)) {
      parsed.env = {};
    }
    parsed.env.ANTHROPIC_MODEL = model;
    fs.writeFileSync(CLAUDE_SETTINGS_PATH, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    result.updatedClaudeSettings = true;
  } catch (error: any) {
    result.errors.push(`~/.claude/settings.json: ${error?.message || 'write failed'}`);
  }

  try {
    let nextContent = '';
    if (fs.existsSync(CODEPILOT_RUNTIME_ENV_PATH)) {
      const raw = fs.readFileSync(CODEPILOT_RUNTIME_ENV_PATH, 'utf8');
      const lines = raw.split('\n');
      let replaced = false;
      const nextLines = lines.map((line) => {
        if (line.startsWith('ANTHROPIC_MODEL=')) {
          replaced = true;
          return `ANTHROPIC_MODEL=${model}`;
        }
        return line;
      });
      if (!replaced) {
        nextLines.push(`ANTHROPIC_MODEL=${model}`);
      }
      nextContent = nextLines.join('\n');
      if (!nextContent.endsWith('\n')) nextContent += '\n';
    } else {
      nextContent = `ANTHROPIC_MODEL=${model}\n`;
    }

    fs.writeFileSync(CODEPILOT_RUNTIME_ENV_PATH, nextContent, 'utf8');
    result.updatedRuntimeEnv = true;
  } catch (error: any) {
    result.errors.push(`codepilot.env: ${error?.message || 'write failed'}`);
  }

  return result;
}

interface HumanGateConfig {
  reminderDelayMs: number;
  timeoutMs: number;
  manualBrowserReminderDelayMs: number;
  manualBrowserTimeoutMs: number;
}

/** Default stream config per channel type. */
const STREAM_DEFAULTS: Record<string, StreamConfig> = {
  telegram: { intervalMs: 700, minDeltaChars: 20, maxChars: 3900 },
  discord: { intervalMs: 1500, minDeltaChars: 40, maxChars: 1900 },
};

const SPARSE_STATUS_DEFAULTS: Record<string, SparseStatusConfig> = {
  feishu: {
    firstDelayMs: 8000,
    minIntervalMs: 18000,
    longRunningThresholdMs: 30000,
    longRunningRepeatMs: 45000,
    maxUpdates: 5,
  },
};

const HUMAN_GATE_DEFAULTS: Record<string, HumanGateConfig> = {
  feishu: {
    reminderDelayMs: 12000,
    timeoutMs: 300000,
    manualBrowserReminderDelayMs: 6000,
    manualBrowserTimeoutMs: 120000,
  },
};

const HUMAN_GATE_PATTERNS: RegExp[] = [
  /登录/,
  /登陆/,
  /扫码/,
  /二维码/,
  /验证码/,
  /短信验证码/,
  /授权登录/,
  /账号绑定/,
  /二次验证/,
  /人机验证/,
  /滑块/,
  /\blogin\b/i,
  /\blog in\b/i,
  /\bsign in\b/i,
  /\bauth(?:enticate|entication)?\b/i,
  /\bqr(?:\s*code)?\b/i,
  /\bscan\b/i,
  /\b2fa\b/i,
  /\botp\b/i,
  /\bcaptcha\b/i,
  /\bsms\b/i,
];

const HUMAN_GATE_INTENT_PATTERNS: RegExp[] = [
  /(?:帮我|请|麻烦|需要|继续|开始|打开|处理|完成|进行|操作|检查|验证|获取|发送|查看).{0,16}(?:登录|登陆|扫码|二维码|验证码|授权登录|账号绑定|二次验证|人机验证|滑块)/,
  /(?:登录|登陆|扫码|二维码|验证码|授权登录|账号绑定|二次验证|人机验证|滑块).{0,16}(?:帮我|请|麻烦|处理|完成|继续|开始|查看|验证|获取|发送)/,
  /(?:please|help me|need to|continue|start|open|handle|finish|check|verify|get|send).{0,24}(?:login|log in|sign in|qr(?:\s*code)?|scan|captcha|otp|2fa|sms)/i,
  /(?:login|log in|sign in|qr(?:\s*code)?|scan|captcha|otp|2fa|sms).{0,24}(?:please|help me|need to|continue|start|open|handle|finish|check|verify|get|send)/i,
  /^(?:登录|登陆|扫码|二维码|验证码|授权登录|账号绑定|二次验证|人机验证|滑块)/,
  /^(?:login|log in|sign in|qr(?:\s*code)?|scan|captcha|otp|2fa|sms)\b/i,
];

const HUMAN_GATE_FALSE_POSITIVE_PATTERNS: RegExp[] = [
  /npx\s+skills?\s+add/i,
  /\bskill\b/gi,
  /根据这个帖子/,
  /安装命令/,
  /不是它们功能最全/,
  /最刚需的其实就这\d+个/,
];

const MANUAL_BROWSER_PATTERNS: RegExp[] = [
  /浏览器/,
  /虚拟桌面/,
  /桌面/,
  /我来登录/,
  /我帮你登录/,
  /我帮你完成登录/,
  /我来操作/,
  /我来处理/,
  /\bbrowser\b/i,
  /\bdesktop\b/i,
  /\bvisible\b/i,
  /\bx\.com\b/i,
  /\btwitter\b/i,
];

const NATURAL_STOP_PATTERNS: RegExp[] = [
  /停止(?:这个)?任务/,
  /先停止/,
  /取消(?:这个)?任务/,
  /结束(?:这个)?任务/,
  /别执行了/,
  /不用继续了/,
  /先别继续/,
  /停一下/,
  /\bstop(?:\s+this)?(?:\s+task)?\b/i,
  /\bcancel(?:\s+this)?(?:\s+task)?\b/i,
  /\babort(?:\s+this)?(?:\s+task)?\b/i,
];

function resolveBridgeModelAlias(input: string): string | null {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return null;
  return BRIDGE_MODEL_ALIASES[normalized] || null;
}

function getStreamConfig(channelType = 'telegram'): StreamConfig {
  const defaults = STREAM_DEFAULTS[channelType] || STREAM_DEFAULTS.telegram;
  const prefix = `bridge_${channelType}_stream_`;
  const intervalMs = parseInt(getSetting(`${prefix}interval_ms`) || '', 10) || defaults.intervalMs;
  const minDeltaChars = parseInt(getSetting(`${prefix}min_delta_chars`) || '', 10) || defaults.minDeltaChars;
  const maxChars = parseInt(getSetting(`${prefix}max_chars`) || '', 10) || defaults.maxChars;
  return { intervalMs, minDeltaChars, maxChars };
}

function getSparseStatusConfig(channelType = 'feishu'): SparseStatusConfig {
  const defaults = SPARSE_STATUS_DEFAULTS[channelType] || SPARSE_STATUS_DEFAULTS.feishu;
  const prefix = `bridge_${channelType}_status_`;

  return {
    firstDelayMs: parseInt(getSetting(`${prefix}first_delay_ms`) || '', 10) || defaults.firstDelayMs,
    minIntervalMs: parseInt(getSetting(`${prefix}min_interval_ms`) || '', 10) || defaults.minIntervalMs,
    longRunningThresholdMs: parseInt(getSetting(`${prefix}long_running_threshold_ms`) || '', 10) || defaults.longRunningThresholdMs,
    longRunningRepeatMs: parseInt(getSetting(`${prefix}long_running_repeat_ms`) || '', 10) || defaults.longRunningRepeatMs,
    maxUpdates: parseInt(getSetting(`${prefix}max_updates`) || '', 10) || defaults.maxUpdates,
  };
}

function getHumanGateConfig(channelType = 'feishu'): HumanGateConfig {
  const defaults = HUMAN_GATE_DEFAULTS[channelType] || HUMAN_GATE_DEFAULTS.feishu;
  const prefix = `bridge_${channelType}_human_gate_`;

  return {
    reminderDelayMs: parseInt(getSetting(`${prefix}reminder_delay_ms`) || '', 10) || defaults.reminderDelayMs,
    timeoutMs: parseInt(getSetting(`${prefix}timeout_ms`) || '', 10) || defaults.timeoutMs,
    manualBrowserReminderDelayMs: parseInt(getSetting(`${prefix}manual_browser_reminder_delay_ms`) || '', 10) || defaults.manualBrowserReminderDelayMs,
    manualBrowserTimeoutMs: parseInt(getSetting(`${prefix}manual_browser_timeout_ms`) || '', 10) || defaults.manualBrowserTimeoutMs,
  };
}

function formatElapsedDuration(elapsedSeconds: number): string {
  const totalSeconds = Math.max(1, Math.round(elapsedSeconds));
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}分` : `${minutes}分${seconds}秒`;
}

function mapToolNameToPhase(toolName: string): string {
  const normalized = toolName.toLowerCase();
  if (normalized.includes('websearch') || normalized.includes('webfetch') || normalized.includes('search')) return '检索资料';
  if (normalized.includes('read') || normalized.includes('glob') || normalized.includes('grep') || normalized.includes('ls')) return '读取和检查文件';
  if (normalized.includes('write') || normalized.includes('edit')) return '修改文件';
  if (normalized.includes('bash') || normalized.includes('shell') || normalized.includes('exec')) return '执行系统操作';
  if (normalized.includes('todo')) return '整理执行计划';
  if (normalized.includes('image') || normalized.includes('screenshot')) return '处理图片或截图';
  return `调用 ${toolName} 工具`;
}

function mapNotificationToStatusText(update: Extract<ProgressUpdate, { kind: 'notification' }>): string | null {
  const title = (update.title || '').toLowerCase();
  const message = (update.message || '').toLowerCase();

  if (title.includes('session fallback') || message.includes('starting fresh conversation')) {
    return '任务进展：会话上下文已重置，正在继续执行';
  }
  return null;
}

function summarizeToolPayload(value: unknown, maxLen = 220): string {
  if (value == null) return '';
  try {
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    const normalized = raw.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLen) return normalized;
    return `${normalized.slice(0, maxLen - 1)}…`;
  } catch {
    return '';
  }
}

function appendToolTimeline(tool: ToolCallInfo, label: string, at = Date.now()): void {
  const normalized = label.replace(/\s+/g, ' ').trim();
  if (!normalized) return;

  const timeline = tool.timeline || [];
  const lastEntry = timeline[timeline.length - 1];
  if (lastEntry?.label === normalized) {
    return;
  }

  const nextEntry: ToolTimelineEntry = { label: normalized, at };
  timeline.push(nextEntry);
  tool.timeline = timeline.slice(-8);
}

function isHumanGateTask(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;

  const hasKeyword = HUMAN_GATE_PATTERNS.some((pattern) => pattern.test(normalized));
  if (!hasKeyword) return false;

  const hasIntent = HUMAN_GATE_INTENT_PATTERNS.some((pattern) => pattern.test(normalized));
  if (hasIntent) return true;

  const falsePositiveScore = HUMAN_GATE_FALSE_POSITIVE_PATTERNS.reduce((score, pattern) => {
    if (pattern.global) {
      const matches = normalized.match(pattern);
      return score + (matches ? matches.length : 0);
    }
    return score + (pattern.test(normalized) ? 1 : 0);
  }, 0);

  if (falsePositiveScore >= 2) {
    return false;
  }

  return normalized.length <= 32;
}

function isManualBrowserAssistTask(text: string): boolean {
  const normalized = text.trim();
  return normalized ? MANUAL_BROWSER_PATTERNS.some((pattern) => pattern.test(normalized)) : false;
}

function isNaturalStopRequest(text: string): boolean {
  const normalized = text.trim();
  return normalized ? NATURAL_STOP_PATTERNS.some((pattern) => pattern.test(normalized)) : false;
}

/** Fire-and-forget: send a preview draft. Only degrades on permanent failure. */
function flushPreview(
  adapter: BaseChannelAdapter,
  state: StreamingPreviewState,
  config: StreamConfig,
): void {
  if (state.degraded || !adapter.sendPreview) return;

  const text = state.pendingText.length > config.maxChars
    ? state.pendingText.slice(0, config.maxChars) + '...'
    : state.pendingText;

  state.lastSentText = text;
  state.lastSentAt = Date.now();

  adapter.sendPreview(state.chatId, text, state.draftId).then(result => {
    if (result === 'degrade') state.degraded = true;
    // 'skip' — transient failure, next flush will retry naturally
  }).catch(() => {
    // Network error — transient, don't degrade
  });
}

// ── Channel-aware rendering dispatch ──────────────────────────

import type { ChannelAddress, SendResult } from './types';

/**
 * Render response text and deliver via the appropriate channel format.
 * Telegram: Markdown → HTML chunks via deliverRendered.
 * Other channels: plain text via deliver (no HTML).
 */
async function deliverResponse(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  responseText: string,
  sessionId: string,
  replyToMessageId?: string,
): Promise<SendResult> {
  if (adapter.channelType === 'telegram') {
    const chunks = markdownToTelegramChunks(responseText, 4096);
    if (chunks.length > 0) {
      return deliverRendered(adapter, address, chunks, { sessionId, replyToMessageId });
    }
    return { ok: true };
  }
  if (adapter.channelType === 'discord') {
    // Discord: native markdown, chunk at 2000 chars with fence repair
    const chunks = markdownToDiscordChunks(responseText, 2000);
    for (let i = 0; i < chunks.length; i++) {
      const result = await deliver(adapter, {
        address,
        text: chunks[i].text,
        parseMode: 'Markdown',
        replyToMessageId,
      }, { sessionId });
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  if (adapter.channelType === 'feishu') {
    // Feishu: pass markdown through for adapter to format as post/card
    return deliver(adapter, {
      address,
      text: responseText,
      parseMode: 'Markdown',
      replyToMessageId,
    }, { sessionId });
  }
  if (adapter.channelType === 'qq') {
    // QQ passive replies have a limited budget per msg_id (typically 5).
    // Limit chunks to avoid exhausting the budget and failing mid-response.
    const QQ_MAX_CHUNKS = 3;
    const limit = limits.qq || 2000;
    const fullText = responseText;
    const chunks = chunkText(fullText, limit);

    const effectiveChunks = chunks.length > QQ_MAX_CHUNKS
      ? [...chunks.slice(0, QQ_MAX_CHUNKS - 1), chunks.slice(QQ_MAX_CHUNKS - 1).join('\n').slice(0, limit - 30) + '\n\n[... response truncated]']
      : chunks;

    for (let i = 0; i < effectiveChunks.length; i++) {
      const result = await deliver(adapter, {
        address,
        text: effectiveChunks[i],
        parseMode: 'plain',
        replyToMessageId,
      }, { sessionId });
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  // Generic fallback: deliver as plain text
  return deliver(adapter, {
    address,
    text: responseText,
    parseMode: 'plain',
    replyToMessageId,
  }, { sessionId });
}

async function sendFeishuStartupGreeting(adapter: BaseChannelAdapter): Promise<void> {
  if (adapter.channelType !== 'feishu') return;

  const binding = router.listBindings('feishu').find((item) => item.active);
  if (!binding) {
    console.log('[bridge-manager] No active Feishu binding found for startup greeting');
    return;
  }

  const result = await deliver(adapter, {
    address: {
      channelType: 'feishu',
      chatId: binding.chatId,
    },
    text: FEISHU_STARTUP_GREETING,
    parseMode: 'plain',
  }, {
    sessionId: binding.codepilotSessionId,
  });

  if (!result.ok) {
    console.warn('[bridge-manager] Failed to send Feishu startup greeting:', result.error || 'send failed');
  }
}

interface HumanGateWatchdog {
  finish(): void;
}

function createHumanGateWatchdog(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  sessionId: string,
  taskAbort: AbortController,
  userText: string,
): HumanGateWatchdog | null {
  if (adapter.channelType !== 'feishu' || !isHumanGateTask(userText)) {
    return null;
  }

  const config = getHumanGateConfig(adapter.channelType);
  const manualBrowserAssist = isManualBrowserAssistTask(userText);
  let finished = false;
  let reminderTimer: ReturnType<typeof setTimeout> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  const reminderDelayMs = manualBrowserAssist ? config.manualBrowserReminderDelayMs : config.reminderDelayMs;
  const timeoutMs = manualBrowserAssist ? config.manualBrowserTimeoutMs : config.timeoutMs;
  const timeoutText = formatElapsedDuration(timeoutMs / 1000);

  const sendPlain = (text: string): void => {
    deliver(adapter, { address, text, parseMode: 'plain' }, { sessionId }).catch((err) => {
      console.warn('[bridge-manager] Failed to send human-gate message:', err instanceof Error ? err.message : err);
    });
  };

  reminderTimer = setTimeout(() => {
    reminderTimer = null;
    if (finished) return;
    if (manualBrowserAssist) {
      sendPlain(`任务提示：这是人工接管浏览器登录任务。我会优先使用现有浏览器或普通可见浏览器给你手动完成登录，不会继续长时间挂着自动化浏览器等待。请完成登录后回复“继续”或“已完成”。如果等待超过约${timeoutText}，任务会自动暂停。`);
      return;
    }
    sendPlain(`任务提示：这是登录/扫码/验证码类任务。我会优先回传二维码、登录界面截图或明确操作提示；如需你人工完成，请在完成后回复“继续”或“已完成”。如果等待超过约${timeoutText}，任务会自动暂停。`);
  }, reminderDelayMs);

  timeoutTimer = setTimeout(() => {
    timeoutTimer = null;
    if (finished) return;
    finished = true;
    if (manualBrowserAssist) {
      sendPlain(`任务已暂停：人工接管浏览器登录任务等待超过约${timeoutText}。这类站点通常会拦截自动化浏览器；请先在可见浏览器中完成登录，再回复“继续”或重新发送任务。`);
      taskAbort.abort();
      return;
    }
    sendPlain(`任务已暂停：登录/扫码/验证码类任务等待超过约${timeoutText}，可能卡在扫码、验证码、授权确认或风控页面。请先完成该步骤，再回复“继续”或重新发送任务。`);
    taskAbort.abort();
  }, timeoutMs);

  return {
    finish(): void {
      finished = true;
      if (reminderTimer) clearTimeout(reminderTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
    },
  };
}

interface SparseStatusReporter {
  note(update: ProgressUpdate): void;
  finish(): void;
}

function createSparseStatusReporter(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  sessionId: string,
): SparseStatusReporter {
  const config = getSparseStatusConfig(adapter.channelType);
  const startedAt = Date.now();
  let finished = false;
  let sentCount = 0;
  let lastSentAt = 0;
  let lastSentText = '';
  let currentPhase = '分析任务';
  let lastLongRunningNoticeAtSeconds = 0;
  let firstTimer: ReturnType<typeof setTimeout> | null = null;

  const sendStatus = (text: string): void => {
    if (finished || sentCount >= config.maxUpdates || !text || text === lastSentText) return;
    sentCount += 1;
    lastSentAt = Date.now();
    lastSentText = text;
    deliver(adapter, { address, text, parseMode: 'plain' }, { sessionId }).catch((err) => {
      console.warn('[bridge-manager] Failed to send sparse status update:', err instanceof Error ? err.message : err);
    });
  };

  const maybeSendPhaseUpdate = (nextPhase: string, previousPhase?: string): void => {
    const now = Date.now();
    if (sentCount === 0) {
      if (now - startedAt < config.firstDelayMs) return;
    } else if (now - lastSentAt < config.minIntervalMs) {
      return;
    }

    const text = previousPhase && previousPhase !== nextPhase
      ? `任务进展：已完成${previousPhase}，正在${nextPhase}`
      : `任务进展：正在${nextPhase}`;
    sendStatus(text);
  };

  firstTimer = setTimeout(() => {
    firstTimer = null;
    if (finished || sentCount > 0) return;
    sendStatus(`任务进展：正在${currentPhase}`);
  }, config.firstDelayMs);

  return {
    note(update: ProgressUpdate): void {
      if (finished) return;
      switch (update.kind) {
        case 'session_initialized':
          break;
        case 'tool_started': {
          const nextPhase = mapToolNameToPhase(update.toolName);
          if (nextPhase === currentPhase) return;
          const previousPhase = currentPhase;
          currentPhase = nextPhase;
          lastLongRunningNoticeAtSeconds = 0;
          maybeSendPhaseUpdate(nextPhase, sentCount > 0 ? previousPhase : undefined);
          break;
        }
        case 'tool_progress': {
          const nextPhase = mapToolNameToPhase(update.toolName);
          if (nextPhase !== currentPhase) {
            const previousPhase = currentPhase;
            currentPhase = nextPhase;
            lastLongRunningNoticeAtSeconds = 0;
            maybeSendPhaseUpdate(nextPhase, sentCount > 0 ? previousPhase : undefined);
          }
          if (update.elapsedSeconds * 1000 < config.longRunningThresholdMs || sentCount >= config.maxUpdates) return;

          const now = Date.now();
          const minRepeatSeconds = Math.floor(config.longRunningRepeatMs / 1000);
          if (sentCount === 0) {
            if (now - startedAt < config.firstDelayMs) return;
          } else if (now - lastSentAt < config.longRunningRepeatMs) {
            return;
          }
          if (update.elapsedSeconds < lastLongRunningNoticeAtSeconds + minRepeatSeconds) return;

          lastLongRunningNoticeAtSeconds = update.elapsedSeconds;
          sendStatus(`任务进展：正在${currentPhase}，已持续约${formatElapsedDuration(update.elapsedSeconds)}`);
          break;
        }
        case 'notification': {
          const text = mapNotificationToStatusText(update);
          if (!text) return;
          const now = Date.now();
          if (sentCount > 0 && now - lastSentAt < config.minIntervalMs) return;
          sendStatus(text);
          break;
        }
      }
    },
    finish(): void {
      finished = true;
      if (firstTimer) clearTimeout(firstTimer);
    },
  };
}

function shouldSendExecutionClosure(
  _adapter: BaseChannelAdapter,
  _result: engine.ConversationResult,
): boolean {
  return false;
}

function buildFinalResponseText(
  responseText: string,
  artifactCount: number,
  _includeClosure: boolean,
): string {
  const trimmed = responseText.trim();

  if (trimmed) {
    return trimmed;
  }

  if (artifactCount <= 0) return '';
  return artifactCount > 0
    ? (artifactCount === 1 ? '相关结果已通过附件发送。' : `相关结果已通过附件发送，共 ${artifactCount} 个附件。`)
    : '';
}

function resolveArtifactPath(artifactPath: string, workingDirectory: string): string {
  if (path.isAbsolute(artifactPath)) return artifactPath;
  const baseDir = workingDirectory || process.env.HOME || process.cwd();
  return path.resolve(baseDir, artifactPath);
}

function summarizeArtifactFailures(failures: string[]): string {
  return failures.length === 1
    ? `Attachment send failed: ${failures[0]}`
    : `Some attachments could not be sent:\n- ${failures.join('\n- ')}`;
}

async function deliverArtifacts(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  artifacts: BridgeArtifact[],
  workingDirectory: string,
  sessionId: string,
): Promise<void> {
  if (artifacts.length === 0) return;

  const failures: string[] = [];
  for (const artifact of artifacts) {
    const resolvedPath = resolveArtifactPath(artifact.path, workingDirectory);
    try {
      const stat = fs.statSync(resolvedPath);
      if (!stat.isFile()) {
        failures.push(`${path.basename(resolvedPath)} (not a regular file)`);
        continue;
      }
    } catch {
      failures.push(`${path.basename(resolvedPath)} (not found)`);
      continue;
    }

    const result = artifact.type === 'image'
      ? await adapter.sendLocalImage(address.chatId, resolvedPath)
      : await adapter.sendLocalFile(address.chatId, resolvedPath);
    if (!result.ok) {
      failures.push(`${path.basename(resolvedPath)} (${result.error || 'send failed'})`);
    }
  }

  if (failures.length > 0) {
    await deliver(adapter, {
      address,
      text: summarizeArtifactFailures(failures),
      parseMode: 'plain',
    }, { sessionId });
  }
}

interface AdapterMeta {
  lastMessageAt: string | null;
  lastError: string | null;
}

interface BridgeManagerState {
  adapters: Map<string, BaseChannelAdapter>;
  adapterMeta: Map<string, AdapterMeta>;
  running: boolean;
  startedAt: string | null;
  loopAborts: Map<string, AbortController>;
  activeTasks: Map<string, AbortController>;
  /** Per-session processing chains for concurrency control */
  sessionLocks: Map<string, Promise<void>>;
  autoStartChecked: boolean;
}

function getState(): BridgeManagerState {
  const g = globalThis as unknown as Record<string, BridgeManagerState>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      adapters: new Map(),
      adapterMeta: new Map(),
      running: false,
      startedAt: null,
      loopAborts: new Map(),
      activeTasks: new Map(),
      sessionLocks: new Map(),
      autoStartChecked: false,
    };
  }
  // Backfill sessionLocks for states created before this field existed
  if (!g[GLOBAL_KEY].sessionLocks) {
    g[GLOBAL_KEY].sessionLocks = new Map();
  }
  return g[GLOBAL_KEY];
}

/**
 * Process a function with per-session serialization.
 * Different sessions run concurrently; same-session requests are serialized.
 */
function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const state = getState();
  const prev = state.sessionLocks.get(sessionId) || Promise.resolve();
  const current = prev.then(fn, fn);
  state.sessionLocks.set(sessionId, current);
  // Cleanup when the chain completes
  current.finally(() => {
    if (state.sessionLocks.get(sessionId) === current) {
      state.sessionLocks.delete(sessionId);
    }
  });
  return current;
}

/**
 * Start the bridge system.
 * Checks feature flags, registers enabled adapters, starts polling loops.
 */
export async function start(): Promise<void> {
  const state = getState();
  if (state.running) return;

  const bridgeEnabled = getSetting('remote_bridge_enabled') === 'true';
  if (!bridgeEnabled) {
    console.log('[bridge-manager] Bridge not enabled (remote_bridge_enabled != true)');
    return;
  }

  // Iterate all registered adapter types and create those that are enabled
  for (const channelType of getRegisteredTypes()) {
    const settingKey = `bridge_${channelType}_enabled`;
    if (getSetting(settingKey) !== 'true') continue;

    const adapter = createAdapter(channelType);
    if (!adapter) continue;

    const configError = adapter.validateConfig();
    if (!configError) {
      registerAdapter(adapter);
    } else {
      console.warn(`[bridge-manager] ${channelType} adapter not valid:`, configError);
    }
  }

  // Start all registered adapters, track how many succeeded
  let startedCount = 0;
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.start();
      console.log(`[bridge-manager] Started adapter: ${type}`);
      startedCount++;
    } catch (err) {
      console.error(`[bridge-manager] Failed to start adapter ${type}:`, err);
    }
  }

  // Only mark as running if at least one adapter started successfully
  if (startedCount === 0) {
    console.warn('[bridge-manager] No adapters started successfully, bridge not activated');
    state.adapters.clear();
    state.adapterMeta.clear();
    return;
  }

  // Mark running BEFORE starting consumer loops — runAdapterLoop checks
  // state.running in its while-condition, so it must be true first.
  state.running = true;
  state.startedAt = new Date().toISOString();

  // Suppress notification bot polling to avoid conflicts
  setBridgeModeActive(true);

  // Now start the consumer loops (state.running is already true)
  for (const [, adapter] of state.adapters) {
    if (adapter.isRunning()) {
      runAdapterLoop(adapter);
    }
  }

  for (const [, adapter] of state.adapters) {
    try {
      await sendFeishuStartupGreeting(adapter);
    } catch (err) {
      console.warn(
        `[bridge-manager] ${adapter.channelType} startup greeting failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log(`[bridge-manager] Bridge started with ${startedCount} adapter(s)`);
}

/**
 * Stop the bridge system gracefully.
 */
export async function stop(): Promise<void> {
  const state = getState();
  if (!state.running) return;

  state.running = false;

  // Abort all event loops
  for (const [, abort] of state.loopAborts) {
    abort.abort();
  }
  state.loopAborts.clear();

  // Stop all adapters
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.stop();
      console.log(`[bridge-manager] Stopped adapter: ${type}`);
    } catch (err) {
      console.error(`[bridge-manager] Error stopping adapter ${type}:`, err);
    }
  }

  state.adapters.clear();
  state.adapterMeta.clear();
  state.sessionLocks.clear();
  state.activeTasks.clear();
  state.startedAt = null;

  // Re-enable notification bot polling
  setBridgeModeActive(false);

  console.log('[bridge-manager] Bridge stopped');
}

/**
 * Lazy auto-start: checks bridge_auto_start setting once and starts if enabled.
 * Called from POST /api/bridge with action 'auto-start' (triggered by Electron on startup).
 */
export function tryAutoStart(): void {
  const state = getState();
  if (state.autoStartChecked) return;
  state.autoStartChecked = true;

  if (state.running) return;

  const autoStart = getSetting('bridge_auto_start');
  if (autoStart !== 'true') return;

  start().catch(err => {
    console.error('[bridge-manager] Auto-start failed:', err);
  });
}

/**
 * Get the current bridge status.
 */
export function getStatus(): BridgeStatus {
  const state = getState();
  return {
    running: state.running,
    startedAt: state.startedAt,
    adapters: Array.from(state.adapters.entries()).map(([type, adapter]) => {
      const meta = state.adapterMeta.get(type);
      return {
        channelType: adapter.channelType,
        running: adapter.isRunning(),
        connectedAt: state.startedAt,
        lastMessageAt: meta?.lastMessageAt ?? null,
        error: meta?.lastError ?? null,
      };
    }),
  };
}

/**
 * Register a channel adapter.
 */
export function registerAdapter(adapter: BaseChannelAdapter): void {
  const state = getState();
  state.adapters.set(adapter.channelType, adapter);
}

/**
 * Get a running adapter by channel type.
 * Returns null if the adapter is not registered.
 */
export function getAdapter(channelType: string): BaseChannelAdapter | null {
  const state = getState();
  return state.adapters.get(channelType) ?? null;
}

/**
 * Run the event loop for a single adapter.
 * Messages for different sessions are dispatched concurrently;
 * messages for the same session are serialized via session locks.
 */
function runAdapterLoop(adapter: BaseChannelAdapter): void {
  const state = getState();
  const abort = new AbortController();
  state.loopAborts.set(adapter.channelType, abort);

  (async () => {
    while (state.running && adapter.isRunning()) {
      try {
        const msg = await adapter.consumeOne();
        if (!msg) continue; // Adapter stopped

        // Callback queries and commands are lightweight — process inline.
        // Regular messages use per-session locking for concurrency.
        if (msg.callbackData || msg.text.trim().startsWith('/')) {
          await handleMessage(adapter, msg);
        } else {
          const binding = router.resolve(msg.address);
          // Fire-and-forget into session lock — loop continues to accept
          // messages for other sessions immediately.
          processWithSessionLock(binding.codepilotSessionId, () =>
            handleMessage(adapter, msg),
          ).catch(err => {
            console.error(`[bridge-manager] Session ${binding.codepilotSessionId.slice(0, 8)} error:`, err);
          });
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[bridge-manager] Error in ${adapter.channelType} loop:`, err);
        // Track last error per adapter
        const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
        meta.lastError = errMsg;
        state.adapterMeta.set(adapter.channelType, meta);
        // Brief delay to prevent tight error loops
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  })().catch(err => {
    if (!abort.signal.aborted) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[bridge-manager] ${adapter.channelType} loop crashed:`, err);
      const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
      meta.lastError = errMsg;
      state.adapterMeta.set(adapter.channelType, meta);
    }
  });
}

/**
 * Handle a single inbound message.
 */
async function handleMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
): Promise<void> {
  // Update lastMessageAt for this adapter
  const adapterState = getState();
  const meta = adapterState.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
  meta.lastMessageAt = new Date().toISOString();
  adapterState.adapterMeta.set(adapter.channelType, meta);

  // Acknowledge the update offset after processing completes (or fails).
  // This ensures the adapter only advances its committed offset once the
  // message has been fully handled, preventing message loss on crash.
  const ack = () => {
    if (msg.updateId != null && adapter.acknowledgeUpdate) {
      adapter.acknowledgeUpdate(msg.updateId);
    }
  };

  // Handle callback queries
  if (msg.callbackData) {
    if (msg.callbackData.startsWith('card:')) {
      const targetMessageId = msg.callbackMessageId || msg.messageId;
      const controller = adapter.getCardStreamController?.() ?? null;
      const handled = !!(targetMessageId && controller?.handleCallback
        && await controller.handleCallback(targetMessageId, msg.callbackData));
      if (handled) {
        ack();
        return;
      }
    }

    // CWD switch button callback
    if (msg.callbackData.startsWith('cwd:')) {
      const targetDir = msg.callbackData.slice(4);
      const validated = validateWorkingDirectory(targetDir);
      if (validated) {
        const binding = router.resolve(msg.address);
        router.updateBinding(binding.id, { workingDirectory: validated, sdkSessionId: '' });
        await deliver(adapter, {
          address: msg.address,
          text: `Working directory switched to <code>${escapeHtml(validated)}</code>\n(Next message starts fresh context)`,
          parseMode: 'HTML',
          replyToMessageId: msg.messageId,
        });
      }
      ack();
      return;
    }

    // Permission buttons
    const handled = broker.handlePermissionCallback(msg.callbackData, msg.address.chatId, msg.callbackMessageId);
    if (handled) {
      const confirmMsg: OutboundMessage = {
        address: msg.address,
        text: 'Permission response recorded.',
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      };
      await deliver(adapter, confirmMsg);
    }
    ack();
    return;
  }

  const rawText = msg.text.trim();
  const hasAttachments = msg.attachments && msg.attachments.length > 0;
  if (!rawText && !hasAttachments) { ack(); return; }

  const binding = router.resolve(msg.address);
  const state = getState();

  if (!rawText.startsWith('/') && isNaturalStopRequest(rawText)) {
    const taskAbort = state.activeTasks.get(binding.codepilotSessionId);
    if (taskAbort) {
      taskAbort.abort();
      state.activeTasks.delete(binding.codepilotSessionId);
      await deliver(adapter, {
        address: msg.address,
        text: '已停止当前任务。',
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
      ack();
      return;
    }
  }

  // Check for IM commands (before sanitization — commands are validated individually)
  if (rawText.startsWith('/')) {
    await handleCommand(adapter, msg, rawText, msg.messageId);
    ack();
    return;
  }

  // Sanitize general message text before routing to conversation engine
  const { text, truncated } = sanitizeInput(rawText);
  if (truncated) {
    console.warn(`[bridge-manager] Input truncated from ${rawText.length} to ${text.length} chars for chat ${msg.address.chatId}`);
    insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[TRUNCATED] Input truncated from ${rawText.length} chars`,
    });
  }

  if (!text && !hasAttachments) { ack(); return; }

  // Notify adapter that message processing is starting (e.g., typing indicator)
  adapter.onMessageStart?.(msg.address.chatId);

  // Create an AbortController so /stop can cancel this task externally
  const taskAbort = new AbortController();
  state.activeTasks.set(binding.codepilotSessionId, taskAbort);
  const humanGateWatchdog = createHumanGateWatchdog(
    adapter,
    msg.address,
    binding.codepilotSessionId,
    taskAbort,
    rawText,
  );

  // ── Streaming preview setup ──────────────────────────────────
  let previewState: StreamingPreviewState | null = null;
  const caps = adapter.getPreviewCapabilities?.(msg.address.chatId) ?? null;
  if (caps?.supported) {
    previewState = {
      draftId: generateDraftId(),
      chatId: msg.address.chatId,
      lastSentText: '',
      lastSentAt: 0,
      degraded: false,
      throttleTimer: null,
      pendingText: '',
    };
  }

  // ── Card streaming setup (Feishu) ──────────────────────────────
  let cardController: import('../channels/types').CardStreamController | null = null;
  let cardMessageId: string | null = null;
  let cardCreating = false;
  let cardBufferedText = '';
  let cardFinalized = false;
  /** Promise that resolves when card creation completes — await before finalize. */
  let cardCreatePromise: Promise<void> | null = null;
  /** Track tool calls for card progress display */
  const cardToolCalls: ToolCallInfo[] = [];

  if (!previewState && adapter.getCardStreamController) {
    cardController = adapter.getCardStreamController();
    console.log('[bridge-manager] Card stream controller:', cardController ? 'available' : 'null');
  }

  const streamCfg = previewState ? getStreamConfig(adapter.channelType) : null;
  // Feishu now relies on streaming cards only.
  // Keep the sparse reporter implementation on disk for future rollback,
  // but do not emit legacy "任务进展：..." text updates anymore.
  const sparseStatusReporter = null;

  const pushCardToolUpdate = () => {
    if (cardMessageId && cardController?.updateToolCalls) {
      cardController.updateToolCalls(cardMessageId, cardToolCalls);
    }
  };

  const findToolById = (toolId?: string) => {
    if (!toolId) return undefined;
    return cardToolCalls.find((tool) => tool.id === toolId);
  };

  const findLatestToolByName = (toolName: string) => {
    for (let index = cardToolCalls.length - 1; index >= 0; index -= 1) {
      const tool = cardToolCalls[index];
      if (tool.name === toolName) {
        return tool;
      }
    }
    return undefined;
  };

  // Build the onPartialText callback — preview streaming OR card streaming
  let onPartialText: ((fullText: string) => void) | undefined;

  if (previewState && streamCfg) {
    // Preview-based streaming (Telegram, etc.)
    const ps = previewState;
    const cfg = streamCfg;
    onPartialText = (fullText: string) => {
      if (ps.degraded) return;

      const previewText = stripArtifactMarkers(fullText);
      ps.pendingText = previewText.length > cfg.maxChars
        ? previewText.slice(0, cfg.maxChars) + '...'
        : previewText;

      const delta = ps.pendingText.length - ps.lastSentText.length;
      const elapsed = Date.now() - ps.lastSentAt;

      if (delta < cfg.minDeltaChars && ps.lastSentAt > 0) {
        if (!ps.throttleTimer) {
          ps.throttleTimer = setTimeout(() => {
            ps.throttleTimer = null;
            if (!ps.degraded) flushPreview(adapter, ps, cfg);
          }, cfg.intervalMs);
        }
        return;
      }

      if (elapsed < cfg.intervalMs && ps.lastSentAt > 0) {
        if (!ps.throttleTimer) {
          ps.throttleTimer = setTimeout(() => {
            ps.throttleTimer = null;
            if (!ps.degraded) flushPreview(adapter, ps, cfg);
          }, cfg.intervalMs - elapsed);
        }
        return;
      }

      if (ps.throttleTimer) {
        clearTimeout(ps.throttleTimer);
        ps.throttleTimer = null;
      }
      flushPreview(adapter, ps, cfg);
    };
  } else if (cardController) {
    // Card-based streaming (Feishu)
    onPartialText = (fullText: string) => {
      const strippedText = stripArtifactMarkers(fullText);
      if (cardCreating) {
        cardBufferedText = strippedText;
        return;
      }

      if (!cardMessageId) {
        // First call — create the card
        cardCreating = true;
        cardBufferedText = strippedText;
        cardCreatePromise = cardController!.create(msg.address.chatId, strippedText, msg.messageId).then((msgId) => {
          cardCreating = false;
          cardMessageId = msgId || null;
          // Flush any buffered text that arrived during creation
          if (cardMessageId && cardBufferedText && cardBufferedText !== strippedText) {
            cardController!.update(cardMessageId, cardBufferedText).catch(() => {});
          }
        }).catch(() => {
          cardCreating = false;
        });
        return;
      }

      cardController!.update(cardMessageId, strippedText).catch(() => {});
    };
  }

  // Build onToolEvent callback for card tool progress
  let onToolEvent: ((event: any) => void) | undefined;
  if (cardController) {
    onToolEvent = (event: any) => {
      if (event.type === 'tool_use') {
        let tool = findToolById(event.id);
        if (!tool) {
          tool = {
            id: event.id,
            name: event.name,
            status: 'running',
            inputSummary: summarizeToolPayload(event.input, 220),
            startedAt: Date.now(),
            timeline: [],
          };
          cardToolCalls.push(tool);
        }
        tool.name = event.name;
        tool.status = 'running';
        tool.inputSummary = summarizeToolPayload(event.input, 220) || tool.inputSummary;
        tool.startedAt = tool.startedAt || Date.now();
        appendToolTimeline(tool, '开始调用');
        if (tool.inputSummary) {
          appendToolTimeline(tool, `输入：${tool.inputSummary}`);
        }
      } else if (event.type === 'tool_result') {
        const tc = findToolById(event.tool_use_id);
        if (tc) {
          tc.status = event.is_error ? 'error' : 'complete';
          tc.finishedAt = Date.now();
          const summary = summarizeToolPayload(event.content, 240);
          tc.elapsedSeconds = tc.startedAt
            ? Math.max(1, Math.round((tc.finishedAt - tc.startedAt) / 1000))
            : tc.elapsedSeconds;
          if (event.is_error) {
            tc.errorSummary = summary || '工具调用失败';
            appendToolTimeline(tc, tc.errorSummary);
          } else {
            tc.resultSummary = summary || '工具调用完成';
            appendToolTimeline(tc, tc.resultSummary);
          }
        }
      }

      // Bootstrap card if tool event arrives before any text (tool-first turns).
      // Without this, tool progress has nowhere to render.
      if (!cardMessageId && !cardCreating) {
        cardCreating = true;
        cardCreatePromise = cardController!.create(msg.address.chatId, '', msg.messageId).then((msgId) => {
          cardCreating = false;
          cardMessageId = msgId || null;
          pushCardToolUpdate();
          // Flush any text that arrived while creating
          if (cardMessageId && cardBufferedText) {
            cardController!.update(cardMessageId, cardBufferedText).catch(() => {});
          }
        }).catch(() => { cardCreating = false; });
        return;
      }

      // Update card display if we have a message ID
      pushCardToolUpdate();
    };
  }

  let onProgressUpdate: ((update: ProgressUpdate) => void) | undefined;
  if (cardController) {
    onProgressUpdate = (update: ProgressUpdate) => {
      if (update.kind !== 'tool_progress') return;

      const tool = findToolById(update.toolUseId) || findLatestToolByName(update.toolName);
      if (!tool) return;

      tool.elapsedSeconds = Math.max(tool.elapsedSeconds || 0, update.elapsedSeconds);
      tool.latestProgress = `已运行 ${formatElapsedDuration(update.elapsedSeconds)}`;

      const roundedSeconds = Math.max(1, Math.round(update.elapsedSeconds));
      const milestone = roundedSeconds >= 60
        ? (roundedSeconds % 30 === 0)
        : roundedSeconds >= 20
          ? (roundedSeconds % 10 === 0)
          : roundedSeconds >= 10
            ? (roundedSeconds % 5 === 0)
            : roundedSeconds === 1;

      if (milestone) {
        appendToolTimeline(tool, tool.latestProgress);
      }

      pushCardToolUpdate();
    };
  }

  try {
    // Pass permission callback so requests are forwarded to IM immediately
    // during streaming (the stream blocks until permission is resolved).
    // Use text or empty string for image-only messages (prompt is still required by streamClaude)
    const promptText = text || (hasAttachments ? 'Describe this image.' : '');

    const result = await engine.processMessage(binding, promptText, async (perm) => {
      await broker.forwardPermissionRequest(
        adapter,
        msg.address,
        perm.permissionRequestId,
        perm.toolName,
        perm.toolInput,
        binding.codepilotSessionId,
        perm.suggestions,
        msg.messageId,
      );
    }, taskAbort.signal, hasAttachments ? msg.attachments : undefined, onPartialText, onToolEvent, onProgressUpdate);

    // Await any in-flight card creation before checking cardMessageId,
    // preventing race where processMessage() returns before create() resolves.
    if (cardCreatePromise) {
      await cardCreatePromise;
    }

    const includeExecutionClosure = shouldSendExecutionClosure(adapter, result);
    const baseResponseText = result.responseText || result.lastToolResultSummary;
    const finalResponseText = buildFinalResponseText(
      baseResponseText,
      result.artifacts.length,
      includeExecutionClosure,
    );

    if (cardController && cardMessageId) {
      await deliverArtifacts(
        adapter,
        msg.address,
        result.artifacts,
        binding.workingDirectory,
        binding.codepilotSessionId,
      );

      if (finalResponseText) {
        await cardController.finalize(cardMessageId, finalResponseText, result.hasError ? 'error' : 'completed');
        cardFinalized = true;
      } else if (result.hasError) {
        await cardController.finalize(cardMessageId, `❌ Error: ${result.errorMessage}`, 'error');
        cardFinalized = true;
      } else {
        await cardController.finalize(cardMessageId, '任务已完成。', 'completed');
        cardFinalized = true;
      }
    } else if (adapter.channelType === 'feishu' && finalResponseText) {
      await deliverArtifacts(
        adapter,
        msg.address,
        result.artifacts,
        binding.workingDirectory,
        binding.codepilotSessionId,
      );
      await deliverResponse(adapter, msg.address, finalResponseText, binding.codepilotSessionId, msg.messageId);
    } else {
      if (finalResponseText) {
        await deliverResponse(adapter, msg.address, finalResponseText, binding.codepilotSessionId, msg.messageId);
      }
      await deliverArtifacts(
        adapter,
        msg.address,
        result.artifacts,
        binding.workingDirectory,
        binding.codepilotSessionId,
      );
    }

    if (!finalResponseText && result.artifacts.length === 0 && result.hasError) {
      const errorResponse: OutboundMessage = {
        address: msg.address,
        text: `<b>Error:</b> ${escapeHtml(result.errorMessage)}`,
        parseMode: 'HTML',
        replyToMessageId: msg.messageId,
      };
      await deliver(adapter, errorResponse);
    }

    // Persist the actual SDK session ID for future resume.
    // On error, ALWAYS clear — the SDK may emit a session_id before crashing,
    // and saving that broken ID would cause all subsequent messages to fail
    // by repeatedly trying to resume a corrupted session.
    if (binding.id) {
      try {
        if (result.hasError) {
          updateChannelBinding(binding.id, { sdkSessionId: '' });
        } else if (result.sdkSessionId) {
          updateChannelBinding(binding.id, { sdkSessionId: result.sdkSessionId });
        }
      } catch { /* best effort */ }
    }
  } finally {
    humanGateWatchdog?.finish();
    // Clean up preview state
    if (previewState) {
      if (previewState.throttleTimer) {
        clearTimeout(previewState.throttleTimer);
        previewState.throttleTimer = null;
      }
      adapter.endPreview?.(msg.address.chatId, previewState.draftId);
    }

    // Clean up card streaming state — await creation if still in flight
    if (cardController && !cardFinalized) {
      const pending = cardCreatePromise as Promise<void> | null;
      if (pending) await pending.catch(() => {});
      if (cardMessageId) {
        cardController.finalize(cardMessageId, '⚠️ Response interrupted.', 'interrupted').catch(() => {});
      }
    }

    state.activeTasks.delete(binding.codepilotSessionId);
    // Notify adapter that message processing ended
    adapter.onMessageEnd?.(msg.address.chatId);
    // Commit the offset only after full processing (success or failure)
    ack();
  }
}

/**
 * Handle IM slash commands.
 */
async function handleCommand(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
  replyToMessageId?: string,
): Promise<void> {
  // Extract command and args (handle /command@botname format)
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();

  // Run dangerous-input detection on the full command text
  const dangerCheck = isDangerousInput(text);
  if (dangerCheck.dangerous) {
    insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[BLOCKED] Dangerous input detected: ${dangerCheck.reason}`,
    });
    console.warn(`[bridge-manager] Blocked dangerous command input from chat ${msg.address.chatId}: ${dangerCheck.reason}`);
    await deliver(adapter, {
      address: msg.address,
      text: `Command rejected: invalid input detected.`,
      parseMode: 'plain',
      replyToMessageId,
    });
    return;
  }

  let response = '';

  switch (command) {
    case '/start':
      response = [
        '<b>CodePilot Bridge</b>',
        '',
        'Send any message to interact with Claude.',
        'Type /help for available commands.',
      ].join('\n');
      break;

    case '/new': {
      let workDir: string | undefined;
      if (args) {
        const validated = validateWorkingDirectory(args);
        if (!validated) {
          response = 'Invalid path. Must be an absolute path without traversal sequences.';
          break;
        }
        workDir = validated;
      } else {
        // No path specified — inherit CWD from current binding
        const current = router.resolve(msg.address);
        if (current.workingDirectory) {
          workDir = current.workingDirectory;
        }
      }
      const binding = router.createBinding(msg.address, workDir);
      response = `New session created.\nSession: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>\nCWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`;
      break;
    }

    case '/bind': {
      if (!args) {
        response = 'Usage: /bind &lt;session_id&gt;';
        break;
      }
      if (!validateSessionId(args)) {
        response = 'Invalid session ID format. Expected a 32-64 character hex/UUID string.';
        break;
      }
      const binding = router.bindToSession(msg.address, args);
      if (binding) {
        response = `Bound to session <code>${args.slice(0, 8)}...</code>`;
      } else {
        response = 'Session not found.';
      }
      break;
    }

    case '/cwd': {
      if (args) {
        // Direct path specified
        const validatedPath = validateWorkingDirectory(args);
        if (!validatedPath) {
          response = 'Invalid path. Must be an absolute path without traversal sequences or special characters.';
          break;
        }
        const binding = router.resolve(msg.address);
        router.updateBinding(binding.id, { workingDirectory: validatedPath, sdkSessionId: '' });
        response = `Working directory set to <code>${escapeHtml(validatedPath)}</code>\n(SDK session reset — next message starts fresh context)`;
        break;
      }

      // No args — show project selector card with buttons.
      // Design decision: /cwd picker is a "recent projects quick-switch" for
      // a single-operator desktop app. It intentionally shows all active
      // directories across this channel type (not isolated per chat).
      // If multi-user / chat-level isolation is needed in the future,
      // this should be scoped by userId or chatId instead.
      const bindings = router.listBindings(msg.address.channelType as any);
      const uniqueDirs = [...new Set(
        bindings
          .filter((b) => b.active)
          .map((b) => b.workingDirectory)
          .filter((d): d is string => !!d && d !== '~')
      )].slice(0, 8); // Max 8 options

      if (uniqueDirs.length === 0) {
        response = 'No project directories found.\nUsage: /cwd /path/to/directory';
        break;
      }

      // Send as interactive card with buttons (Feishu) or text list (other channels)
      const currentBinding = router.resolve(msg.address);
      const currentCwd = currentBinding.workingDirectory || '~';

      // Build inline buttons for project selection
      const inlineButtons = uniqueDirs.map((dir) => {
        const label = dir === currentCwd ? `📍 ${dir.split('/').pop() || dir}` : (dir.split('/').pop() || dir);
        return [{
          text: label,
          callbackData: `cwd:${dir}`,
        }];
      });

      const cardMsg: OutboundMessage = {
        address: msg.address,
        text: `<b>Switch Working Directory</b>\n\nCurrent: <code>${escapeHtml(currentCwd)}</code>\n\nSelect a project:`,
        parseMode: 'HTML',
        replyToMessageId,
        inlineButtons,
      };
      await deliver(adapter, cardMsg);
      return; // Don't send response — card is already sent
    }

    case '/mode': {
      if (!validateMode(args)) {
        response = 'Usage: /mode plan|code|ask';
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { mode: args });
      response = `Mode set to <b>${args}</b>`;
      break;
    }

    case '/model': {
      const binding = router.resolve(msg.address);
      const currentModel = binding.model || getSetting('bridge_default_model') || getSetting('default_model') || 'unset';

      if (!args) {
        response = [
          '<b>Bridge Model</b>',
          '',
          `Current: <code>${escapeHtml(currentModel)}</code>`,
          '',
          '<b>Available aliases</b>',
          '<code>code</code> = doubao-seed-2.0-code',
          '<code>pro</code> = doubao-seed-2.0-pro',
          '<code>kimi</code> = kimi-k2.5',
          '',
          '<b>Usage</b>',
          '/model code',
          '/model pro',
          '/model kimi',
        ].join('\n');
        break;
      }

      const resolvedModel = resolveBridgeModelAlias(args);
      if (!resolvedModel) {
        response = `Unknown model: <code>${escapeHtml(args)}</code>\n\n${BRIDGE_MODEL_HELP}`;
        break;
      }

      router.updateBinding(binding.id, { model: resolvedModel, sdkSessionId: '' });
      updateSessionModel(binding.codepilotSessionId, resolvedModel);
      setSetting('bridge_default_model', resolvedModel);
      setSetting('default_model', resolvedModel);
      const syncResult = syncClaudeModelDefaults(resolvedModel);

      response = [
        '<b>Bridge Model Updated</b>',
        '',
        `Current session: <code>${escapeHtml(resolvedModel)}</code>`,
        `New bridge sessions: <code>${escapeHtml(resolvedModel)}</code>`,
        `Claude default: <code>${escapeHtml(resolvedModel)}</code>`,
        '',
        '<b>Synced targets</b>',
        `- chat session: <code>${escapeHtml(binding.codepilotSessionId)}</code>`,
        `- bridge default: <code>${escapeHtml(resolvedModel)}</code>`,
        `- ~/.claude/settings.json: ${syncResult.updatedClaudeSettings ? 'updated' : 'failed'}`,
        `- codepilot.env: ${syncResult.updatedRuntimeEnv ? 'updated' : 'failed'}`,
      ].join('\n');
      if (syncResult.errors.length > 0) {
        response += `\n\n<b>Warnings</b>\n${syncResult.errors.map((item) => `- ${escapeHtml(item)}`).join('\n')}`;
      }
      break;
    }

    case '/status': {
      const binding = router.resolve(msg.address);
      response = [
        '<b>Bridge Status</b>',
        '',
        `Session: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>`,
        `CWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`,
        `Mode: <b>${binding.mode}</b>`,
        `Model: <code>${binding.model || 'default'}</code>`,
      ].join('\n');
      break;
    }

    case '/sessions': {
      const bindings = router.listBindings(adapter.channelType);
      if (bindings.length === 0) {
        response = 'No sessions found.';
      } else {
        const lines = ['<b>Sessions:</b>', ''];
        for (const b of bindings.slice(0, 10)) {
          const active = b.active ? 'active' : 'inactive';
          lines.push(`<code>${b.codepilotSessionId.slice(0, 8)}...</code> [${active}] ${escapeHtml(b.workingDirectory || '~')}`);
        }
        response = lines.join('\n');
      }
      break;
    }

    case '/stop': {
      const binding = router.resolve(msg.address);
      const st = getState();
      const taskAbort = st.activeTasks.get(binding.codepilotSessionId);
      if (taskAbort) {
        taskAbort.abort();
        st.activeTasks.delete(binding.codepilotSessionId);
        response = 'Stopping current task...';
      } else {
        response = 'No task is currently running.';
      }
      break;
    }

    case '/perm': {
      // Text-based permission approval fallback (for channels without inline buttons)
      // Usage: /perm allow <id> | /perm allow_session <id> | /perm deny <id>
      const permParts = args.split(/\s+/);
      const permAction = permParts[0];
      const permId = permParts.slice(1).join(' ');
      if (!permAction || !permId || !['allow', 'allow_session', 'deny'].includes(permAction)) {
        response = 'Usage: /perm allow|allow_session|deny &lt;permission_id&gt;';
        break;
      }
      const callbackData = `perm:${permAction}:${permId}`;
      const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
      if (handled) {
        response = `Permission ${permAction}: recorded.`;
      } else {
        response = `Permission not found or already resolved.`;
      }
      break;
    }

    case '/history': {
      // Fetch recent messages from the current chat (or thread)
      if (!(adapter instanceof ChannelPluginAdapter)) {
        response = 'History is not supported for this channel type.';
        break;
      }
      const plugin = adapter.getPlugin();
      if (!plugin.getCardStreamController && !(plugin as any).meta?.channelType) {
        response = 'History is not available.';
        break;
      }
      // Use message-actions if the plugin has Feishu-type capabilities
      try {
        const { readMessages, readThreadMessages } = await import('../channels/feishu/message-actions');
        const restClient = (plugin as any).gateway?.getRestClient?.();
        if (!restClient) {
          response = 'Channel not connected.';
          break;
        }
        const pageSize = parseInt(args, 10) || 10;
        const chatIdRaw = msg.address.chatId;
        const threadIdx = chatIdRaw.indexOf(':thread:');

        let result;
        if (threadIdx >= 0) {
          // Thread history: extract thread ID and use readThreadMessages
          const threadId = chatIdRaw.slice(threadIdx + ':thread:'.length);
          result = await readThreadMessages(restClient, threadId, { pageSize });
        } else {
          const realChatId = extractRealChatId(chatIdRaw);
          result = await readMessages(restClient, realChatId, { pageSize });
        }

        if (result.items.length === 0) {
          response = 'No messages found.';
        } else {
          const lines = [`<b>Recent ${result.items.length} messages:</b>`, ''];
          for (const item of result.items) {
            const time = item.createTime ? new Date(parseInt(item.createTime, 10) * 1000).toLocaleString() : '?';
            let content = '';
            try {
              const parsed = JSON.parse(item.content);
              content = (parsed.text ?? '').slice(0, 80);
            } catch {
              content = item.content.slice(0, 80);
            }
            lines.push(`[${time}] ${escapeHtml(content)}`);
          }
          if (result.hasMore) lines.push('\n<i>(more messages available)</i>');
          response = lines.join('\n');
        }
      } catch (err) {
        response = `Failed to fetch history: ${err instanceof Error ? escapeHtml(err.message) : 'unknown error'}`;
      }
      break;
    }

    case '/search': {
      // Simplified local search — lists recent messages and filters client-side.
      // This is NOT equivalent to OpenClaw's server-side search (search.message.create API
      // with user_access_token). Results are limited to recent messages in the current chat.
      if (!args) {
        response = 'Usage: /search &lt;keyword&gt;';
        break;
      }
      if (!(adapter instanceof ChannelPluginAdapter)) {
        response = 'Search is not supported for this channel type.';
        break;
      }
      try {
        const { searchMessages } = await import('../channels/feishu/message-actions');
        const plugin = adapter.getPlugin();
        const restClient = (plugin as any).gateway?.getRestClient?.();
        if (!restClient) {
          response = 'Channel not connected.';
          break;
        }
        const realChatId = extractRealChatId(msg.address.chatId);
        const result = await searchMessages(restClient, realChatId, args, { pageSize: 10 });
        if (result.items.length === 0) {
          response = `No messages matching "<b>${escapeHtml(args)}</b>".`;
        } else {
          const lines = [`<b>${result.items.length} result(s) for "${escapeHtml(args)}":</b>`, ''];
          for (const item of result.items) {
            const time = item.createTime ? new Date(parseInt(item.createTime, 10) * 1000).toLocaleString() : '?';
            let content = '';
            try {
              const parsed = JSON.parse(item.content);
              content = (parsed.text ?? '').slice(0, 100);
            } catch {
              content = item.content.slice(0, 100);
            }
            lines.push(`[${time}] ${escapeHtml(content)}`);
          }
          response = lines.join('\n');
        }
      } catch (err) {
        response = `Search failed: ${err instanceof Error ? escapeHtml(err.message) : 'unknown error'}`;
      }
      break;
    }

    case '/feishu': {
      const subArgs = args.split(/\s+/);
      const subcommand = subArgs[0]?.toLowerCase() || 'help';

      switch (subcommand) {
        case 'start': {
          // Validate Feishu config
          if (!(adapter instanceof ChannelPluginAdapter)) {
            response = 'This command is only available in Feishu channels.';
            break;
          }
          const plugin = adapter.getPlugin();
          const config = (plugin as any).getConfig?.();
          if (!config) {
            response = '❌ Feishu plugin not configured.\n\nPlease set App ID and App Secret in CodePilot settings, or use /feishu auth.';
            break;
          }
          const validationError = plugin.validateConfig();
          if (validationError) {
            response = `❌ Configuration error: ${validationError}`;
            break;
          }
          const capabilities = plugin.getCapabilities();
          const lines = [
            '✅ Feishu Bridge is running',
            '',
            `Streaming: ${capabilities.streaming ? '✅ Enabled' : '❌ Disabled'}`,
            `Thread Reply: ${capabilities.threadReply ? '✅' : '❌'}`,
            `Search: ${capabilities.search ? '✅' : '❌'}`,
            `History: ${capabilities.history ? '✅' : '❌'}`,
          ];
          response = lines.join('\n');
          break;
        }

        case 'auth': {
          // Show auth status and guidance
          if (!(adapter instanceof ChannelPluginAdapter)) {
            response = 'This command is only available in Feishu channels.';
            break;
          }
          const plugin = adapter.getPlugin();
          const config = (plugin as any).getConfig?.();
          if (!config) {
            response = '❌ App credentials not configured.\n\nPlease configure App ID and App Secret in CodePilot Settings → Bridge → Feishu.';
            break;
          }
          // Note: CodePilot currently uses app-level bot tokens (no user OAuth)
          // This is a simplified version compared to OpenClaw's full OAuth Device Flow
          response = [
            '🔐 Feishu Auth Status',
            '',
            `App ID: ${config.appId}`,
            `DM Policy: ${config.dmPolicy}`,
            `Allow From: ${(config.allowFrom || []).join(', ') || '(all)'}`,
            '',
            'ℹ️ CodePilot uses app-level bot tokens.',
            'User-level OAuth (user_access_token) is not yet supported.',
            'Some features requiring user identity (cross-chat search, sending as user) are unavailable.',
          ].join('\n');
          break;
        }

        case 'doctor': {
          // Run diagnostics
          if (!(adapter instanceof ChannelPluginAdapter)) {
            response = 'This command is only available in Feishu channels.';
            break;
          }
          const plugin = adapter.getPlugin();
          const config = (plugin as any).getConfig?.();
          const lines = ['🔍 Feishu Doctor', ''];

          // Config check
          if (!config) {
            lines.push('❌ Configuration: Not configured');
          } else {
            lines.push('✅ Configuration: OK');
            lines.push(`   App ID: ${config.appId}`);
            lines.push(`   DM Policy: ${config.dmPolicy}`);
            lines.push(`   Thread Session: ${config.threadSession ? 'Yes' : 'No'}`);
            lines.push(`   Streaming: Enabled`);
          }

          // Connection check
          if (plugin.isRunning()) {
            lines.push('✅ Connection: WebSocket connected');
          } else {
            lines.push('❌ Connection: Not running');
          }

          // Capabilities
          const caps = plugin.getCapabilities();
          lines.push('');
          lines.push('Capabilities:');
          lines.push(`   Streaming Cards: ${caps.streaming ? '✅' : '❌'}`);
          lines.push(`   Thread Reply: ${caps.threadReply ? '✅' : '❌'}`);
          lines.push(`   Message Search: ${caps.search ? '✅' : '❌ (requires user_access_token)'}`);
          lines.push(`   Message History: ${caps.history ? '✅' : '❌'}`);

          // Known limitations
          lines.push('');
          lines.push('Known Limitations (CodePilot vs OpenClaw):');
          lines.push('   • No user_access_token / OAuth Device Flow');
          lines.push('   • No cross-chat search (search.message.create requires UAT)');
          lines.push('   • No "send as user" capability');
          lines.push('   • Simplified card streaming (no reasoning phase display)');

          response = lines.join('\n');
          break;
        }

        default: {
          // /feishu help or unknown subcommand
          response = [
            'Feishu Bridge Commands',
            '',
            '/feishu start — Check plugin status and configuration',
            '/feishu auth — View auth status and guidance',
            '/feishu doctor — Run diagnostics',
            '/feishu help — Show this help',
          ].join('\n');
          break;
        }
      }
      break;
    }

    case '/help':
      response = [
        '<b>CodePilot Bridge Commands</b>',
        '',
        '<b>Session:</b>',
        '/new [path] - Create new session (optional: specify CWD)',
        '/cwd /path - Change CWD, reset context',
        '/bind &lt;session_id&gt; - Bind to existing session',
        '/model code|pro|kimi - Change model',
        '/mode plan|code|ask - Change mode',
        '/status - Show session / CWD / mode / model',
        '/sessions - List recent sessions',
        '/stop - Stop current task',
        '',
        '<b>Messages:</b>',
        '/history [count] - Show recent messages',
        '/search &lt;keyword&gt; - Search in current chat',
        '/perm allow|deny &lt;id&gt; - Permission response',
        '',
        '<b>Feishu:</b>',
        '/feishu doctor - Run diagnostics',
        '/feishu auth - View auth status',
      ].join('\n');
      break;

    default:
      response = `Unknown command: ${escapeHtml(command)}\nType /help for available commands.`;
  }

  if (response) {
    await deliver(adapter, {
      address: msg.address,
      text: response,
      parseMode: 'HTML',
      replyToMessageId,
    });
  }
}
