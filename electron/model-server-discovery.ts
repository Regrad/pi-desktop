import type {
  ConfiguredModelInfo,
  ConfiguredModelServer,
  ModelServerDiscoveryInput,
  ModelServerDiscoveryResult,
  ThinkingLevel,
} from "../shared/types.js";

type JsonObject = Record<string, unknown>;

export interface DiscoveredProviderConfiguration {
  baseUrl: string;
  propertiesAvailable: boolean;
  suggestedId: string;
  provider: JsonObject;
  publicResult: Omit<ModelServerDiscoveryResult, "server" | "addedModels" | "updatedModels">;
}

const PI_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const SAMPLING_KEYS = [
  "temperature",
  "top_k",
  "top_p",
  "min_p",
  "typical_p",
  "repeat_last_n",
  "repeat_penalty",
  "presence_penalty",
  "frequency_penalty",
  "dry_multiplier",
  "dry_base",
  "dry_allowed_length",
  "dry_penalty_last_n",
] as const;

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

export function normalizeServer(input: ModelServerDiscoveryInput): { rootUrl: string; baseUrl: string } {
  const address = input.address.trim();
  if (!address) throw new Error("Введите адрес сервера");
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(address) ? address : `http://${address}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("Некорректный адрес сервера");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Поддерживаются только HTTP и HTTPS");
  const port = input.port.trim();
  if (port) {
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Порт должен быть числом от 1 до 65535");
    url.port = port;
  }
  const pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
  const rootUrl = `${url.origin}${pathname}`.replace(/\/+$/, "");
  return { rootUrl, baseUrl: `${rootUrl}/v1` };
}

async function fetchJson(url: string, apiKey?: string, required = false): Promise<JsonObject | undefined> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: apiKey?.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      if (!required) return undefined;
      throw new Error(`${response.status} ${response.statusText}`.trim());
    }
    const value = objectValue(await response.json());
    if (!value && required) throw new Error("Ожидался JSON-объект с описанием моделей");
    return value;
  } catch (error) {
    if (!required) return undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Сервер не ответил на ${url}: ${message}`);
  }
}

function serverModels(response: JsonObject): JsonObject[] {
  const data = Array.isArray(response.data) ? response.data.map(objectValue).filter(Boolean) as JsonObject[] : [];
  const legacy = Array.isArray(response.models) ? response.models.map(objectValue).filter(Boolean) as JsonObject[] : [];
  const merged = new Map<string, JsonObject>();
  for (const item of [...legacy, ...data]) {
    const id = String(item.id ?? item.model ?? item.name ?? "").trim();
    if (!id) continue;
    merged.set(id, { ...(merged.get(id) ?? {}), ...item, id });
  }
  return [...merged.values()];
}

function detectedThinkingLevels(template: string, reasoning: boolean): ThinkingLevel[] {
  if (!reasoning) return ["off"];
  const supportedSentence = template.match(/Supported types are ([^.]+)/i)?.[1] ?? "";
  const explicit = PI_THINKING_LEVELS.filter((level) => new RegExp(`\\b${level}\\b`, "i").test(supportedSentence));
  const levels = explicit.length ? explicit : (["low", "medium", "high"] as ThinkingLevel[]);
  if (/enable_thinking/i.test(template)) levels.unshift("off");
  return [...new Set(levels)];
}

function thinkingLevelMap(levels: ThinkingLevel[]): Record<string, string | null> | undefined {
  if (levels.length === 1 && levels[0] === "off") return undefined;
  return Object.fromEntries(PI_THINKING_LEVELS.map((level) => [level, levels.includes(level) ? (level === "off" ? "none" : level) : null]));
}

function samplingParams(props: JsonObject | undefined): Record<string, number | boolean | string> | undefined {
  const settings = objectValue(props?.default_generation_settings);
  const params = objectValue(settings?.params);
  if (!params) return undefined;
  const result: Record<string, number | boolean | string> = {};
  for (const key of SAMPLING_KEYS) {
    const value = params[key];
    if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
    else if (typeof value === "boolean" || typeof value === "string") result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

function sanitizeProviderId(value: string): string {
  const normalized = value.toLocaleLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "local-openai";
}

export async function discoverProvider(input: ModelServerDiscoveryInput): Promise<DiscoveredProviderConfiguration> {
  const { rootUrl, baseUrl } = normalizeServer(input);
  const apiKey = input.apiKey?.trim();
  const [modelsResponse, props, health] = await Promise.all([
    fetchJson(`${rootUrl}/v1/models`, apiKey, true),
    fetchJson(`${rootUrl}/props`, apiKey),
    fetchJson(`${rootUrl}/health`, apiKey),
  ]);
  const discoveredModels = serverModels(modelsResponse!);
  if (!Array.isArray(modelsResponse?.data) && !Array.isArray(modelsResponse?.models))
    throw new Error("Сервер не вернул список моделей через /v1/models");
  if (!discoveredModels.length && [...(Array.isArray(modelsResponse.data) ? modelsResponse.data : []),
    ...(Array.isArray(modelsResponse.models) ? modelsResponse.models : [])].length)
    throw new Error("Сервер вернул некорректные идентификаторы моделей через /v1/models");

  const template = typeof props?.chat_template === "string" ? props.chat_template : "";
  const templateCaps = objectValue(props?.chat_template_caps);
  const modalities = objectValue(props?.modalities);
  const supportsReasoningEffort = templateCaps?.supports_reasoning_effort === true || /reasoning_effort|enable_thinking|<think>/i.test(template);
  const supportsPreserveThinking = templateCaps?.supports_preserve_reasoning === true || /preserve_thinking/i.test(template);
  const supportsDeveloperRole = /developer/i.test(template);
  const propsContext = finitePositive(objectValue(props?.default_generation_settings)?.n_ctx);
  const currentAlias = typeof props?.model_alias === "string" ? props.model_alias : undefined;
  const defaultSampling = samplingParams(props);
  const capabilities = [
    modalities?.vision === true ? "image" : undefined,
    modalities?.video === true ? "video" : undefined,
    modalities?.audio === true ? "audio" : undefined,
    supportsReasoningEffort ? "reasoning" : undefined,
    templateCaps?.supports_tools === true ? "tools" : undefined,
    templateCaps?.supports_parallel_tool_calls === true ? "parallel-tools" : undefined,
    supportsPreserveThinking ? "preserve-thinking" : undefined,
  ].filter((item): item is string => Boolean(item));

  const models = discoveredModels.map((entry) => {
    const id = String(entry.id);
    const meta = objectValue(entry.meta);
    const entryCapabilities = Array.isArray(entry.capabilities) ? entry.capabilities.map(String) : [];
    const isCurrent = discoveredModels.length === 1 || id === currentAlias;
    const contextWindow = finitePositive(meta?.n_ctx) ?? (isCurrent ? propsContext : undefined);
    const vision = entryCapabilities.includes("multimodal") || (isCurrent && modalities?.vision === true);
    const reasoning = isCurrent ? supportsReasoningEffort : /reason|think/i.test(id);
    const levels = detectedThinkingLevels(isCurrent ? template : "", reasoning);
    const levelMap = thinkingLevelMap(levels);
    const compat = reasoning ? {
      thinkingFormat: "chat-template",
      chatTemplateKwargs: {
        enable_thinking: { $var: "thinking.enabled" },
        ...(supportsPreserveThinking ? { preserve_thinking: true } : {}),
        ...(supportsReasoningEffort ? { reasoning_effort: { $var: "thinking.effort" } } : {}),
      },
    } : undefined;
    return {
      id,
      name: String(entry.name ?? entry.model ?? id),
      reasoning,
      ...(levelMap ? { thinkingLevelMap: levelMap } : {}),
      input: vision ? ["text", "image"] : ["text"],
      ...(contextWindow ? { contextWindow, maxTokens: contextWindow } : {}),
      ...(isCurrent && defaultSampling ? { samplingParams: defaultSampling } : {}),
      ...(compat ? { compat } : {}),
    };
  });

  const serverKind = props?.build_info ? "llama.cpp" : "OpenAI-совместимый";
  const host = new URL(rootUrl).hostname;
  return {
    baseUrl,
    propertiesAvailable: props !== undefined,
    suggestedId: sanitizeProviderId(serverKind === "llama.cpp" ? "llama-cpp" : `local-${host}`),
    provider: {
      baseUrl,
      api: "openai-completions",
      apiKey: apiKey || "local-server",
      compat: {
        supportsDeveloperRole,
        supportsReasoningEffort: false,
        supportsUsageInStreaming: true,
        maxTokensField: "max_tokens",
      },
      models,
    },
    publicResult: {
      serverKind,
      ...(typeof props?.build_info === "string" ? { buildInfo: props.build_info } : {}),
      ...(typeof health?.status === "string" ? { health: health.status } : {}),
      capabilities,
    },
  };
}

export function configuredServerView(id: string, provider: JsonObject): ConfiguredModelServer {
  const models = Array.isArray(provider.models) ? provider.models.map(objectValue).filter(Boolean) as JsonObject[] : [];
  return {
    id,
    baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : "",
    api: typeof provider.api === "string" ? provider.api : "openai-completions",
    apiKeyConfigured: typeof provider.apiKey === "string" && provider.apiKey.length > 0 && provider.apiKey !== "local-server",
    models: models.map((model): ConfiguredModelInfo => {
      const map = objectValue(model.thinkingLevelMap);
      const levels: ThinkingLevel[] = map
        ? PI_THINKING_LEVELS.filter((level) => map[level] !== null && map[level] !== undefined)
        : model.reasoning === true ? ["low", "medium", "high"] : ["off"];
      const rawSampling = objectValue(model.samplingParams);
      const visibleSampling = rawSampling ? Object.fromEntries(Object.entries(rawSampling).filter((entry): entry is [string, number | boolean | string] => ["number", "boolean", "string"].includes(typeof entry[1]))) : undefined;
      return {
        id: String(model.id ?? ""),
        ...(typeof model.name === "string" ? { name: model.name } : {}),
        ...(finitePositive(model.contextWindow) ? { contextWindow: finitePositive(model.contextWindow) } : {}),
        ...(finitePositive(model.maxTokens) ? { maxTokens: finitePositive(model.maxTokens) } : {}),
        reasoning: model.reasoning === true,
        input: Array.isArray(model.input) ? model.input.map(String) : ["text"],
        thinkingLevels: levels,
        ...(visibleSampling && Object.keys(visibleSampling).length ? { samplingParams: visibleSampling } : {}),
      };
    }).filter((model) => model.id),
  };
}
