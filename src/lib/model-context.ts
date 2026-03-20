export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'sonnet': 200000,
  'opus': 200000,
  'haiku': 200000,
  'claude-sonnet-4-20250514': 200000,
  'claude-opus-4-20250514': 200000,
  'claude-haiku-4-5-20251001': 200000,
};

export function getContextWindow(model: string): number | null {
  return MODEL_CONTEXT_WINDOWS[model]
    ?? MODEL_CONTEXT_WINDOWS[Object.keys(MODEL_CONTEXT_WINDOWS).find(k => model.includes(k)) ?? '']
    ?? null;
}
