// Shipped with the desktop so runtime updates retain the same MCP fixes.
export function patchMcpIndex(source) {
  if (source.includes('// Pi Desktop MCP configuration access v5')) {
    source = source.replace('const initialized = await initPromise;', 'const initialized = state;');
    const anchor = '              const fresh = loadMcpConfig(earlyConfigPath, _ctx.cwd);\n              if (JSON.stringify';
    return source.replace(anchor, '              const fresh = loadMcpConfig(earlyConfigPath, _ctx.cwd);\n              const definition = fresh.mcpServers[params.connect];\n              if (definition && [definition.command, definition.url, definition.socket].filter(Boolean).length !== 1) throw new Error("MCP server must configure exactly one transport");\n              if (JSON.stringify');
  }
  const replacements = [
    ['import { cloneMcpConfig,', 'import { getConfigDiscoveryPaths, cloneMcpConfig,'],
    ['const description = buildProxyDescription(config, scriptTool);', 'const description = desktopMcpDescription;'],
    ['description: "Server name to connect (lazy connect + metadata refresh)"', 'description: "Server name to connect: reread configuration, then reconnect with normal trust and approval checks"'],
    ["Action: 'install', 'ui-messages', 'auth-start', or 'auth-complete'", "Action: 'config' (configuration paths and safe endpoints), 'install', 'ui-messages', 'auth-start', or 'auth-complete'"],
    ['        let executeOwner = currentOwner;\n        const parseArgs =', `        let executeOwner = currentOwner;
        const configPaths = programmaticConfig ? [] : getConfigDiscoveryPaths(earlyConfigPath, _ctx.cwd);
        const info = () => configInfo(state?.config ?? earlyConfig, configPaths, getPiGlobalConfigPath(earlyConfigPath), params.connect ?? params.server, programmaticConfig);
        if (params.action === "config") {
          try {
            if (!programmaticConfig) validateConfigFiles(configPaths);
            const fresh = programmaticConfig ? (state?.config ?? earlyConfig) : loadMcpConfig(earlyConfigPath, _ctx.cwd);
            return withConfigInfo({ content: [], details: { mode: "config" } }, configInfo(fresh, configPaths, getPiGlobalConfigPath(earlyConfigPath), params.server, programmaticConfig));
          } catch (error) {
            return withConfigInfo({ content: [{ type: "text", text: diagnosticError(error) }], details: { mode: "config", error: "config_invalid" } }, info());
          }
        }
        const parseArgs =`],
    ['          return connectAndReport(proxyState, params.connect, signal, _ctx as ExtensionContext);', `          try {
            if (!programmaticConfig) {
              validateConfigFiles(configPaths);
              const fresh = loadMcpConfig(earlyConfigPath, _ctx.cwd);
              const definition = fresh.mcpServers[params.connect];
              if (definition && [definition.command, definition.url, definition.socket].filter(Boolean).length !== 1) throw new Error("MCP server must configure exactly one transport");
              if (JSON.stringify(fresh.mcpServers[params.connect]) !== JSON.stringify(proxyState.config.mcpServers[params.connect])) {
                // Reinitialize through the native trust/approval pipeline, never inject
                // a disk definition directly into an already-approved runtime.
                const previousOwner = currentOwner;
                const previousOAuthRuntime = currentOAuthRuntime;
                const generation = ++lifecycleGeneration;
                const owner = createMcpRuntimeOwner();
                currentOwner = owner;
                currentOAuthRuntime = null;
                state = null;
                initPromise = null;
                initStartedPromise = null;
                clearRetainedInitFailure();
                await Promise.all([
                  previousOwner?.stop("MCP configuration changed"),
                  shutdownState(proxyState, "config_reload"),
                  previousOAuthRuntime ? loadOAuthRuntime().then(({ shutdownOAuth }) => shutdownOAuth(previousOAuthRuntime)) : Promise.resolve(),
                ]);
                signal?.throwIfAborted();
                owner.throwIfInactive();
                await startInitialization(_ctx, owner, generation, "config_reload_stale");
                const initialized = state;
                owner.throwIfInactive();
                if (!initialized) throw new Error("MCP configuration reload failed");
                return withConfigInfo(await connectAndReport(initialized, params.connect, signal, _ctx), info());
              }
            }
            return withConfigInfo(await connectAndReport(proxyState, params.connect, signal, _ctx), info());
          } catch (error) {
            if (signal?.aborted) throw error;
            return withConfigInfo({ content: [{ type: "text", text: diagnosticError(error, state?.config.mcpServers[params.connect]) }], details: { mode: "connect", error: "config_reload_failed", server: params.connect } }, info());
          }`],
    ['        return proxyModes.executeStatus(proxyState);', '        return withConfigInfo(proxyModes.executeStatus(proxyState), info());'],
  ];
  for (const [from,to] of replacements) {
    if (source.split(from).length !== 2) throw new Error(`Unsupported pi-mcp-adapter 5.1.0: missing or ambiguous patch anchor ${from.slice(0,80)}`);
    source = source.replace(from,to);
  }
  return '// Pi Desktop MCP configuration access v5\nimport { desktopMcpDescription, configInfo, validateConfigFiles, withConfigInfo, diagnosticError } from "./desktop-config.js";\n' + source;
}

export function patchMcpProxy(source) {
  if (source.includes('// Pi Desktop MCP error cause diagnostics')) return source;
  const start=source.indexOf('export async function executeConnect(state:');
  const end=source.indexOf('\n/** Whether executeCall',start);
  if(start<0||end<0) throw new Error('Unsupported pi-mcp-adapter 5.1.0 proxy-modes.ts');
  const body=source.slice(start,end);
  const from='const message = error instanceof Error ? error.message : String(error);';
  if(body.split(from).length!==2) throw new Error('MCP connect error handler changed');
  return '// Pi Desktop MCP error cause diagnostics\nimport { diagnosticError } from "./desktop-config.js";\n'+source.slice(0,start)+body.replace(from,'const message = diagnosticError(error, definition);')+source.slice(end);
}
