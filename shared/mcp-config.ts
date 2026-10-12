import stripJsonComments from "strip-json-comments";

type Config = Record<string, any>;
function validateConfig(config: unknown): asserts config is Config {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("MCP configuration must be an object.");
  for (const key of ["settings", "mcpServers"]) {
    const value = (config as Config)[key];
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value)))
      throw new Error(`MCP ${key} must be an object.`);
  }
}

export function parseMcpConfiguration(text: string): Config {
  const config: unknown = JSON.parse(stripJsonComments(text.replace(/^\uFEFF/, ""), { trailingCommas: true }));
  validateConfig(config);
  return config;
}
const adapterKeys = ["settings", "imports", "claudePlugins", "mcp-servers"];
const legacyServerKeys = ["directTools", "disabled", "requestTimeoutMs", "lifecycle", "idleTimeout", "excludeTools", "toolRenames", "bearerToken", "bearerTokenEnv"];

/** Existing adapter overrides win; unrelated native Pi configuration stays native. */
export function migrateLegacyAdapterConfig(native: Config, adapter: Config = {}) {
  validateConfig(native); validateConfig(adapter);
  const nativeConfig = structuredClone(native);
  const adapterConfig = structuredClone(adapter);
  let changed = false;
  for (const key of adapterKeys) {
    if (!Object.hasOwn(nativeConfig, key)) continue;
    const old = nativeConfig[key];
    if (key === "settings") adapterConfig.settings = { ...old, ...adapterConfig.settings };
    else if (Array.isArray(old)) adapterConfig[key] = [...new Set([...old, ...(adapterConfig[key] ?? [])])];
    else adapterConfig[key] ??= old;
    delete nativeConfig[key]; changed = true;
  }
  for (const [name, server] of Object.entries(nativeConfig.mcpServers ?? {}) as [string, Config][]) {
    if (!server || !legacyServerKeys.some(key => Object.hasOwn(server, key))) continue;
    adapterConfig.mcpServers ??= {};
    const existing = adapterConfig.mcpServers[name];
    adapterConfig.mcpServers[name] = { ...server, ...existing,
      ...(server.env || existing?.env ? { env: { ...server.env, ...existing?.env } } : {}) };
    delete nativeConfig.mcpServers[name]; changed = true;
  }
  return { nativeConfig, adapterConfig, changed };
}
