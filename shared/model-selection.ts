import type { ModelInfo } from "./types.js";

// A saved selection is a preference, not evidence that a model still exists.
// Never silently move an existing chat to an unrelated provider.
export function selectConfiguredModel(models: ModelInfo[], provider?: string, id?: string,
  defaultProvider?: string, defaultModel?: string): ModelInfo | null {
  const selectedProvider = provider ?? defaultProvider;
  const selectedId = id ?? defaultModel;
  return models.find(model => model.provider === selectedProvider && model.id === selectedId)
    ?? models.find(model => model.provider === selectedProvider)
    ?? (provider ? null : models[0] ?? null);
}
