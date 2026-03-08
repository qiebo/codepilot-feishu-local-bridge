import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface ToolResultArtifactPayload {
  type: 'image' | 'file';
  mimeType?: string;
  base64?: string;
  filePath?: string;
  suggestedName?: string;
}

export interface MaterializedToolResultArtifact {
  type: 'image' | 'file';
  path: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sanitizeBase64(value: string): string {
  return value
    .replace(/^data:[^,]+,/, '')
    .replace(/\s+/g, '');
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function extensionFromMimeType(mimeType?: string, artifactType: 'image' | 'file' = 'file'): string {
  const normalized = (mimeType || '').toLowerCase();

  switch (normalized) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    case 'application/pdf':
      return '.pdf';
    case 'application/json':
      return '.json';
    case 'text/plain':
      return '.txt';
    default:
      return artifactType === 'image' ? '.png' : '.bin';
  }
}

function inferArtifactFromItem(item: unknown): ToolResultArtifactPayload | null {
  if (!isRecord(item)) return null;

  const rawType = stringValue(item.type)?.toLowerCase();
  const source = isRecord(item.source) ? item.source : undefined;
  const file = isRecord(item.file) ? item.file : undefined;
  const mimeType = stringValue(item.mime_type)
    || stringValue(item.mimeType)
    || stringValue(source?.media_type)
    || stringValue(file?.type)
    || stringValue(file?.mimeType);
  const base64 = stringValue(source?.data)
    || stringValue(file?.base64)
    || stringValue(item.data);
  const filePath = stringValue(file?.filePath)
    || stringValue(item.filePath)
    || stringValue(item.path);
  const suggestedName = stringValue(item.name) || stringValue(file?.name);

  if (rawType === 'image' && (base64 || filePath)) {
    return {
      type: 'image',
      ...(mimeType ? { mimeType } : {}),
      ...(base64 ? { base64 } : {}),
      ...(filePath ? { filePath } : {}),
      ...(suggestedName ? { suggestedName } : {}),
    };
  }

  if (
    rawType
    && ['file', 'document', 'pdf', 'audio', 'video', 'notebook', 'parts'].includes(rawType)
    && (base64 || filePath)
  ) {
    return {
      type: 'file',
      ...(mimeType ? { mimeType } : {}),
      ...(base64 ? { base64 } : {}),
      ...(filePath ? { filePath } : {}),
      ...(suggestedName ? { suggestedName } : {}),
    };
  }

  return null;
}

function summarizeArtifacts(artifacts: ToolResultArtifactPayload[]): string {
  return artifacts
    .map((artifact) => artifact.type === 'image' ? '[Tool returned image]' : '[Tool returned file]')
    .join('\n');
}

function pickOutputDirectory(sessionId: string, workingDirectory?: string): string {
  const candidates = [
    workingDirectory ? path.join(workingDirectory, '.codepilot-bridge-artifacts', sessionId) : '',
    path.join(os.homedir(), '.codepilot', 'bridge-artifacts', sessionId),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      return candidate;
    } catch {
      continue;
    }
  }

  const fallbackPath = path.join(os.tmpdir(), 'codepilot-bridge-artifacts', sessionId);
  fs.mkdirSync(fallbackPath, { recursive: true });
  return fallbackPath;
}

function materializeInlineArtifact(
  artifact: ToolResultArtifactPayload,
  sessionId: string,
  workingDirectory?: string,
): MaterializedToolResultArtifact | null {
  if (!artifact.base64) return null;

  const base64 = sanitizeBase64(artifact.base64);
  if (!base64) return null;

  let buffer: Buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    return null;
  }
  if (buffer.length === 0) return null;

  const digest = crypto.createHash('sha1').update(buffer).digest('hex');
  const configuredName = artifact.suggestedName ? sanitizeFileName(path.basename(artifact.suggestedName)) : '';
  const configuredExt = configuredName ? path.extname(configuredName) : '';
  const extension = configuredExt || extensionFromMimeType(artifact.mimeType, artifact.type);
  const baseName = configuredName || `${artifact.type}-${digest.slice(0, 16)}${extension}`;
  const outputPath = path.join(pickOutputDirectory(sessionId, workingDirectory), baseName);

  if (!fs.existsSync(outputPath)) {
    try {
      fs.writeFileSync(outputPath, buffer);
    } catch {
      return null;
    }
  }

  return { type: artifact.type, path: outputPath };
}

export function extractToolResultArtifacts(content: unknown): {
  summary: string;
  artifacts: ToolResultArtifactPayload[];
} {
  if (typeof content === 'string') {
    return { summary: content, artifacts: [] };
  }

  if (!Array.isArray(content)) {
    return {
      summary: content == null ? '' : String(content),
      artifacts: [],
    };
  }

  const textParts: string[] = [];
  const artifacts: ToolResultArtifactPayload[] = [];

  for (const item of content) {
    if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') {
      textParts.push(item.text);
      continue;
    }

    const artifact = inferArtifactFromItem(item);
    if (artifact) {
      artifacts.push(artifact);
    }
  }

  const summary = textParts
    .join('\n')
    .trim() || summarizeArtifacts(artifacts);

  return { summary, artifacts };
}

export function materializeToolResultArtifacts(
  artifacts: ToolResultArtifactPayload[],
  sessionId: string,
  workingDirectory?: string,
): MaterializedToolResultArtifact[] {
  const results: MaterializedToolResultArtifact[] = [];
  const seen = new Set<string>();

  for (const artifact of artifacts) {
    let materialized: MaterializedToolResultArtifact | null = null;

    if (artifact.filePath) {
      materialized = { type: artifact.type, path: artifact.filePath };
    } else if (artifact.base64) {
      materialized = materializeInlineArtifact(artifact, sessionId, workingDirectory);
    }

    if (!materialized) continue;

    const key = `${materialized.type}:${materialized.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(materialized);
  }

  return results;
}
