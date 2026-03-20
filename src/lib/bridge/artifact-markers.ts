export interface BridgeArtifact {
  type: 'image' | 'file';
  path: string;
}

const FEISHU_ARTIFACT_MARKER_RE = /<<FEISHU_(IMAGE|FILE):([\s\S]*?)>>/g;

function normalizeArtifactPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
    || (trimmed.startsWith('`') && trimmed.endsWith('`'))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function cleanupMarkerWhitespace(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractArtifactMarkers(text: string): { text: string; artifacts: BridgeArtifact[] } {
  const artifacts: BridgeArtifact[] = [];
  const seen = new Set<string>();

  const cleanedText = text.replace(FEISHU_ARTIFACT_MARKER_RE, (_match, kind: string, rawPath: string) => {
    const artifactPath = normalizeArtifactPath(rawPath);
    if (!artifactPath) return '';

    const type = kind === 'IMAGE' ? 'image' : 'file';
    const dedupKey = `${type}:${artifactPath}`;
    if (!seen.has(dedupKey)) {
      seen.add(dedupKey);
      artifacts.push({ type, path: artifactPath });
    }
    return '';
  });

  return {
    text: cleanupMarkerWhitespace(cleanedText),
    artifacts,
  };
}

export function stripArtifactMarkers(text: string): string {
  return extractArtifactMarkers(text).text;
}
