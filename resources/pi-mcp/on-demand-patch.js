// Desktop connections are demand-driven; native trust, auth, cancellation and
// per-server tool execution remain the adapter's responsibility.
const indexMarker = "// Pi Desktop MCP on-demand lifecycle v1\n";
const initMarker = "// Pi Desktop MCP on-demand discovery v1\n";
function replaceOnce(source, from, to) {
  if (source.split(from).length !== 2) throw new Error("Unsupported MCP adapter on-demand anchor: " + from.slice(0, 80));
  return source.replace(from, to);
}

export function patchMcpOnDemandIndex(source, version = "5.1.0") {
  if (source.includes(indexMarker.trim())) return patchMcpCatalog(source);
  const crlf = source.includes("\r\n");
  let result = source.replace(/\r\n/g, "\n");
  result = replaceOnce(result, "withConfigInfo, diagnosticError }", "withConfigInfo, diagnosticError, withDeferredServers }");
  result = replaceOnce(result, "  startLoadTimeInitialization();", "  // Connections start only from an explicit MCP operation.");
  const signInStart = result.indexOf("    // Before any connection, so an imported sign-in");
  const signInEnd = result.indexOf("    // Recorded only after previous-session cleanup", signInStart);
  if (signInStart < 0 || signInEnd < signInStart) throw new Error("Unsupported pi-mcp-adapter 5.1.0 sign-in hook");
  const signIn = result.slice(signInStart, signInEnd)
    .replace("if (generation !== lifecycleGeneration || !owner.isActive()) return;", "owner.throwIfInactive();");
  result = result.slice(0, signInStart) + result.slice(signInEnd);
  result = replaceOnce(result, "      const initialization = core.initializeMcp(pi, ctx, owner, {",
    signIn + "      const initialization = core.initializeMcp(pi, ctx, owner, {");
  const sessionStart = result.indexOf("    sessionCtx = ctx;\n    if (state) return;");
  const sessionEnd = result.indexOf("\n  });\n\n  // Other extensions can reactivate", sessionStart);
  if (sessionStart < 0 || sessionEnd < sessionStart) throw new Error("Unsupported pi-mcp-adapter 5.1.0 session hook");
  result = result.slice(0, sessionStart) + `    sessionCtx = ctx;
    // Cached definitions were registered at load time. Cold discovery, project
    // approval and sign-in import wait for an actual MCP operation.
    const definitions = Object.values(earlyConfig.mcpServers);
    const enabled = definitions.filter(definition => !isServerDisabled(definition)).length;
    ctx.ui?.setStatus("mcp", formatMcpFooterStatus(earlyConfig, enabled, definitions.length - enabled, 0));` + result.slice(sessionEnd);
  const inputStart = result.indexOf('  pi.on("input", async () => {');
  const inputEnd = result.indexOf('  pi.on("session_shutdown",', inputStart);
  if (inputStart < 0 || inputEnd < inputStart) throw new Error("Unsupported pi-mcp-adapter 5.1.0 input hook");
  result = result.slice(0, inputStart) + "  // Ordinary user input never waits for MCP initialization or reconnection.\n\n" + result.slice(inputEnd);
  result = replaceOnce(result, 'if (lifecycleMode === "keep-alive") targetState.lifecycle.markKeepAlive(name, definition);',
    'if (lifecycleMode === "keep-alive" && targetState.manager.getConnection(name)?.status === "connected") targetState.lifecycle.markKeepAlive(name, definition);');
  const gateway = "        const proxyModes = await loadForRuntime(loadProxyModes, proxyGuard);";
  result = replaceOnce(result, gateway, gateway + `
        const requestedServer = params.server ?? params.instructions;
        if (!params.action && !params.connect && requestedServer && !proxyState.toolMetadata.has(requestedServer)) {
          const discovery = await connectAndReport(proxyState, requestedServer, signal, _ctx);
          assertRuntimeGuard(proxyGuard);
          if (discovery.details?.error) return withConfigInfo(discovery, info());
        }`);
  const search = `proxyModes.executeSearch(proxyState, params.search, params.regex, params.server, params.includeSchemas, params.limit, params.offset, params.searchMode, signal${version === "7.0.1" ? ", _ctx?.modelRegistry" : ""})`;
  result = replaceOnce(result, `const result = await ${search};`, `const result = withDeferredServers(await ${search}, proxyState);`);
  result = indexMarker + result;
  return patchMcpCatalog(crlf ? result.replace(/\n/g, "\r\n") : result);
}

// Separate migration so existing installations already carrying v1 also upgrade.
function patchMcpCatalog(source) {
  const marker = "// Pi Desktop MCP capability catalog v1\n";
  if (source.includes(marker.trim())) return source;
  const crlf = source.includes("\r\n");
  let result = source.replace(/\r\n/g, "\n");
  result = replaceOnce(result, '  function registerProxyTool(description:', `  let desktopCatalog = [];
  pi.on("context", event => {
    if (!process.env.PI_DESKTOP_CONVERSATION_ID) return;
    return { messages: catalogContext(event.messages, desktopCatalog, pi) };
  });

  function registerProxyTool(description:`);
  result = replaceOnce(result, '      const description = desktopMcpDescription;', `      const description = desktopMcpDescription + (process.env.PI_DESKTOP_TOOL_ROUTING === "1" ? "\\n\\n" + catalogText(desktopCatalog) : "");`);
  result = replaceOnce(result, '  function syncProxyTool(config: McpConfig, cache: MetadataCache | null, directSpecs: DirectToolSpec[]): void {',
    `  function syncProxyTool(config: McpConfig, cache: MetadataCache | null, directSpecs: DirectToolSpec[]): void {
    const nextCatalog = mcpCatalog(config, (name, definition) => {
      const entry = cache?.servers?.[name];
      return entry && isServerCacheValid(entry, definition) ? entry.tools : undefined;
    });
    const catalogChanged = JSON.stringify(nextCatalog) !== JSON.stringify(desktopCatalog);
    desktopCatalog = nextCatalog;`);
  result = replaceOnce(result, '      name: "mcp",\n      label: "MCP",\n      description,', `      name: "mcp",
      label: "MCP",
      description,
      namespace: { name: "MCP", description: catalogText(desktopCatalog, 64000) },`);
  result = replaceOnce(result, 'if (!proxyToolRegistered || proxyToolDescription !== description)',
    'if (!proxyToolRegistered || proxyToolDescription !== description || catalogChanged)');
  result = replaceOnce(result, ', proxyState);\n          assertRuntimeGuard(proxyGuard);\n          if (lazyDirectTools', ', proxyState, params);\n          assertRuntimeGuard(proxyGuard);\n          if (lazyDirectTools');
  result = marker + 'import { mcpCatalog, catalogText, catalogContext } from "./catalog.js";\n' + result;
  return crlf ? result.replace(/\n/g, "\r\n") : result;
}

export function patchMcpOnDemandInit(source) {
  if (source.includes(initMarker.trim())) return removeColdBootstrap(source);
  const crlf = source.includes("\r\n");
  let result = source.replace(/\r\n/g, "\n");
  result = replaceOnce(result, 'return mode === "keep-alive" || mode === "eager" || needsDiscovery.has(name);',
    "return false; // Metadata discovery never connects unrelated servers.");
  result = replaceOnce(result, '    if (lifecycleMode === "keep-alive") {\n      lifecycle.markKeepAlive(name, definition);\n    }',
    "    // Keep-alive is enabled only after this server has actually been used.");
  result = replaceOnce(result, 'if ((definition.lifecycle ?? "lazy") === "lazy-keep-alive") {',
    'if (["keep-alive", "eager", "lazy-keep-alive"].includes(definition.lifecycle ?? "lazy")) {');
  result = initMarker + result;
  return removeColdBootstrap(crlf ? result.replace(/\n/g, "\r\n") : result);
}

function removeColdBootstrap(source) {
  const marker = "  // Direct-tool schemas are discovered only for a requested server.";
  if (source.includes(marker)) return source;
  const crlf = source.includes("\r\n");
  const normalized = source.replace(/\r\n/g, "\n");
  const start = normalized.indexOf("  const envDirect = process.env.MCP_DIRECT_TOOLS;");
  const end = normalized.indexOf("  lifecycle.setReconnectCallback(", start);
  if (start < 0 || end < start) throw new Error("Unsupported pi-mcp-adapter 5.1.0 direct-tool bootstrap");
  const result = normalized.slice(0, start) + marker + "\n\n" + normalized.slice(end);
  return crlf ? result.replace(/\n/g, "\r\n") : result;
}

export function patchMcpOnDemandManager(source, version = "5.1.0") {
  const marker = "// Pi Desktop MCP cancellation skips diagnostic reconnects\n";
  if (source.includes(marker.trim())) return source;
  const crlf = source.includes("\r\n");
  let result = source.replace(/\r\n/g, "\n");
  if (version === "7.0.1") {
    result = replaceOnce(result, ").catch(async error => { throw await this.enrichHttpConnectionError(definition, error); });",
      ").catch(async error => { throwIfAborted(signal); throw await this.enrichHttpConnectionError(definition, error); });");
    result = marker + result;
    return crlf ? result.replace(/\n/g, "\r\n") : result;
  }
  result = replaceOnce(result,
    "connectionAttempt.catch(async error => { throw await this.enrichHttpConnectionError(definition, error); })",
    "connectionAttempt.catch(async error => { throwIfAborted(attemptSignal); throw await this.enrichHttpConnectionError(definition, error); })");
  result = replaceOnce(result,
    "candidateAttempt.catch(async error => { throw await this.enrichHttpConnectionError(definition, error); })",
    "candidateAttempt.catch(async error => { throwIfAborted(signal); throw await this.enrichHttpConnectionError(definition, error); })");
  result = marker + result;
  return crlf ? result.replace(/\n/g, "\r\n") : result;
}
