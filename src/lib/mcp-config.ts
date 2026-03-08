import fs from 'fs';
import os from 'os';
import path from 'path';
import type { MCPServerConfig } from '@/types';

const USER_CONFIG_FILES = [
  path.join(os.homedir(), '.claude.json'),
  path.join(os.homedir(), '.claude', 'settings.json'),
];

const PROJECT_CONFIG_FILES = [
  '.cursor/mcp.json',
  '.vscode/mcp.json',
];

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonFile(filePath: string): JsonRecord {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeServerConfig(value: unknown): MCPServerConfig | null {
  if (!isRecord(value)) return null;

  const type = value.type === 'stdio' || value.type === 'sse' || value.type === 'http'
    ? value.type
    : undefined;
  const command = typeof value.command === 'string' ? value.command : undefined;
  const url = typeof value.url === 'string' ? value.url : undefined;
  const resolvedType = type || (url ? 'http' : command ? 'stdio' : undefined);

  if (!resolvedType) return null;
  if (resolvedType === 'stdio' && !command) return null;
  if ((resolvedType === 'sse' || resolvedType === 'http') && !url) return null;

  const args = Array.isArray(value.args)
    ? value.args.filter((item): item is string => typeof item === 'string')
    : undefined;
  const env = normalizeStringMap(value.env);
  const headers = normalizeStringMap(value.headers);

  return {
    ...(command ? { command } : {}),
    ...(args && args.length > 0 ? { args } : {}),
    ...(env ? { env } : {}),
    type: resolvedType,
    ...(url ? { url } : {}),
    ...(headers ? { headers } : {}),
  };
}

function extractMcpServers(raw: JsonRecord): Record<string, MCPServerConfig> {
  const candidate = isRecord(raw.mcpServers)
    ? raw.mcpServers
    : isRecord(raw.servers)
      ? raw.servers
      : null;

  if (!candidate) return {};

  const normalized = Object.entries(candidate)
    .map(([name, config]) => [name, normalizeServerConfig(config)] as const)
    .filter((entry): entry is [string, MCPServerConfig] => !!entry[1]);

  return Object.fromEntries(normalized);
}

function getDirectoryChain(startDirectory?: string): string[] {
  if (!startDirectory) return [];

  const directories: string[] = [];
  let current = path.resolve(startDirectory);

  while (true) {
    directories.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return directories.reverse();
}

export function resolveEffectiveMcpServers(workingDirectory?: string): Record<string, MCPServerConfig> {
  const merged: Record<string, MCPServerConfig> = {};

  for (const configPath of USER_CONFIG_FILES) {
    Object.assign(merged, extractMcpServers(readJsonFile(configPath)));
  }

  for (const directory of getDirectoryChain(workingDirectory)) {
    for (const relativePath of PROJECT_CONFIG_FILES) {
      Object.assign(merged, extractMcpServers(readJsonFile(path.join(directory, relativePath))));
    }
  }

  return merged;
}
