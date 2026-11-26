import { readFileSync } from "node:fs";
import stripJsonComments from "strip-json-comments";
import { mcpCatalog, searchCatalog } from "./catalog.js";

// Direct HTTP schemas stay stable. Deferred discovery can include the catalog.
export const desktopMcpDescription = `MCP gateway: server status, discovery, configuration, URL installation, authentication, and single MCP tool calls. Use codemode for discovery and scripts, not mcpScript. Core file and shell tools remain direct.
The capability catalog describes configured programs, not a guarantee they are running. Read server instructions before using unfamiliar tools.
Connections open on demand. Status and global searches use saved metadata; mcp({server: "name"}) discovers that server when needed.
Usage:
  mcp({}) -> Current server status
  mcp({action: "config", server: "name"}) -> Actual configuration paths and safe connection parameters (server optional)
  mcp({action: "install", url: "https://example.com/mcp", target: "global"}) -> Install and connect an MCP URL through normal trust/authentication checks; only with user authorization
  mcp({server: "name"}) -> List current server tools
  mcp({search: "query"}) -> Search tools and configured server capabilities, including servers not yet connected
  mcp({describe: "tool_name", server: "name"}) -> Tool details and parameters (server optional)
  mcp({instructions: "name"}) -> Full server usage instructions
  mcp({connect: "name"}) -> Reread actual configuration, reconnect, and refresh metadata
  mcp({tool: "name", args: {key: "value"}, server: "name"}) -> Call a tool (server optional; JSON string args also accepted)
  mcp({action: "ui-messages"}) -> Messages from completed UI sessions
  mcp({action: "auth-start", server: "name"}) -> Start manual OAuth and obtain a browser URL
  mcp({action: "auth-complete", server: "name", args: {redirectUrl: "..."}}) -> Complete manual OAuth
Mode priority: action > tool > connect > describe > instructions > search > server > status`;

export function safeEndpoint(value) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return url.toString();
  } catch { return "[invalid URL]"; }
}

export function withDeferredServers(result, state, search) {
  const candidates = mcpCatalog(state.config, name => state.toolMetadata.get(name));
  const matches = search ? searchCatalog(candidates, search.search, search) : candidates;
  const servers = matches
    .filter(entry => !state.toolMetadata.has(entry.name))
    .map(({ name, description, source }) => ({ name, ...(source !== "unknown" ? { description } : {}) }));
  const serverMatches = search ? matches : undefined;
  if (!servers.length && !serverMatches?.length) return result;
  return { ...result, details: { ...result.details, ...(serverMatches ? { serverMatches } : {}), undiscoveredServers: servers }, content: [...result.content,
    { type: "text", text: `Matching MCP servers (metadata, not additional tools):\n${JSON.stringify(matches)}\nUse mcp({server: "NAME"}) to discover the server relevant to the task.` }] };
}

export function connectionSummary(definition = {}) {
  return { transport: definition.command ? "stdio" : definition.url ? "http" : definition.socket ? "socket" : "unconfigured",
    ...(definition.url ? { url: safeEndpoint(definition.url) } : {}),
    ...(definition.command ? { command: definition.command, argumentCount: definition.args?.length ?? 0 } : {}),
    ...(definition.socket ? { socket: definition.socket } : {}),
    ...(definition.cwd ? { cwd: definition.cwd } : {}), disabled: definition.enabled === false || definition.disabled === true };
}

export function configInfo(config, paths, globalPath, server, programmatic = false) {
  return { globalConfigPath: programmatic ? null : globalPath, sources: programmatic ? [] : paths,
    programmatic, precedence: "Later configuration sources override earlier ones; definitions may merge field by field.",
    servers: Object.fromEntries(Object.entries(config.mcpServers ?? {}).filter(([name]) => !server || name === server)
      .map(([name, definition]) => [name, connectionSummary(definition)])),
    instruction: programmatic ? "This configuration was supplied in memory; editing files will not replace it."
      : "Edit the actual configuration files shown here with normal file tools. Then call mcp({connect: SERVER}) to reread configuration and reconnect that server. Do not assume ~/.pi/agent is the active data directory. Connection arguments and credentials are intentionally omitted." };
}

export function validateConfigFiles(paths) {
  for (const source of paths) {
    if (!source.exists) continue;
    let config;
    try { config = JSON.parse(stripJsonComments(readFileSync(source.path, "utf8").replace(/^\uFEFF/, ""), { trailingCommas: true })); }
    catch { throw new Error(`Invalid or unreadable MCP configuration: ${source.path}. Fix this file before reconnecting; the current connection was not changed.`); }
    if (!config || typeof config !== "object" || Array.isArray(config) ||
      (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)))) {
      throw new Error(`Invalid MCP configuration structure: ${source.path}`);
    }
  }
}

export function diagnosticError(error, definition) {
  const items = []; const seen = new Set();
  function visit(value) {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (value.code) items.push(String(value.code));
    if (value.message) items.push(String(value.message));
    visit(value.cause);
    for (const child of Array.isArray(value.errors) ? value.errors : []) visit(child);
  }
  visit(error);
  let text = [...new Set(items)].join("; ") || String(error);
  const secrets = [definition?.bearerToken, ...Object.values(definition?.headers ?? {}), ...Object.values(definition?.httpHeaders ?? {}),
    ...Object.entries(definition?.env ?? {}).filter(([key]) => /token|secret|password|key|auth/i.test(key)).map(([, value]) => value)];
  if (definition?.bearerTokenEnv) secrets.push(process.env[definition.bearerTokenEnv]);
  for (const value of [...secrets]) if (typeof value === "string") for (const match of value.matchAll(/\$\{([^}]+)\}/g)) secrets.push(process.env[match[1]]);
  for (let i = 0; i < (definition?.args?.length ?? 0); i++) {
    const value = definition.args[i];
    if (typeof value === "string" && /^--?(?:token|password|secret|api[-_]key|authorization)(?:=|$)/i.test(value)) secrets.push(value.includes("=") ? value.slice(value.indexOf("=") + 1) : definition.args[i + 1]);
  }
  for (const secret of secrets) if (typeof secret === "string" && secret) text = text.split(secret).join("[redacted]");
  text = text.replace(/https?:\/\/[^\s"'<>]+/g, value => safeEndpoint(value))
    .replace(/(Bearer\s+)[^\s"'<>]+/gi, "$1[redacted]");
  if (items.includes("ECONNREFUSED")) text += "; Nothing is listening at the configured address/port; check the endpoint before investigating the protocol.";
  return text.slice(0, 4000);
}

export function withConfigInfo(result, info) {
  return { ...result, content: [...result.content, { type: "text", text: `Pi Desktop MCP configuration:\n${JSON.stringify(info, null, 2)}` }],
    details: { ...result.details, desktopConfig: info } };
}
