// Application-owned SDK host, intentionally independent of Pi's CLI options,
// update notifications, executable discovery and terminal startup lifecycle.
import { randomUUID } from "node:crypto";
import {
  createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime,
  SessionManager, SettingsManager, resolveCliModel, initTheme,
} from "@earendil-works/pi-coding-agent";
import {
  builtInExtensions, takeOverStdout, applyHttpProxySettings,
  configureHttpDispatcher, resolveModelScope, initializeThemeValidation,
} from "./bindings.mjs";
import { runRpcMode } from "./protocol.js";

process.title = 'Pi Desktop Engine';
process.env.PI_CODING_AGENT = 'true';
process.env.AI_AGENT = 'pi';
process.env.PI_SKIP_VERSION_CHECK = '1';
takeOverStdout();
configureHttpDispatcher();
try {
  initializeThemeValidation();
  const options = JSON.parse(process.env.PI_DESKTOP_ENGINE_OPTIONS || "{}");
  delete process.env.PI_DESKTOP_ENGINE_OPTIONS;
  const cwd = options.cwd || process.cwd();
  const agentDir = options.agentDir || process.env.PI_CODING_AGENT_DIR;
  if (!agentDir || !options.sessionsDir) throw new Error("Embedded engine requires agentDir and sessionsDir");
  const sessionFile = options.sessionFile || (options.sessionId && SessionManager.findById(cwd, options.sessionId, options.sessionsDir));
  const sessionManager = sessionFile
    ? SessionManager.open(sessionFile, options.sessionsDir, cwd)
    : SessionManager.create(cwd, options.sessionsDir, { id: options.sessionId || randomUUID() });
  const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const services = await createAgentSessionServices({
      cwd, agentDir, settingsManager,
      modelRuntimeSignal: AbortSignal.timeout(15_000),
      extensionFlagValues: new Map(Object.entries(options.extensionFlags || {})),
      resourceLoaderOptions: {
        additionalExtensionPaths: options.extensions || [],
        disabledBuiltinExtensions: ["mcp"],
        extensionFactories: builtInExtensions,
        noExtensions: options.isolated, noSkills: options.isolated,
        noPromptTemplates: options.isolated, noThemes: options.isolated,
        noContextFiles: options.isolated,
        appendSystemPrompt: options.appendSystemPrompt ? [options.appendSystemPrompt] : [],
      },
    });
    const selection = resolveCliModel({ cliProvider: options.provider, cliModel: options.model,
      cliThinking: options.thinkingLevel, modelRuntime: services.modelRuntime });
    if (selection.error) throw new Error(selection.error);
    const patterns = settingsManager.getEnabledModels();
    const scopedModels = patterns?.length
      ? await resolveModelScope(patterns, services.modelRuntime, { signal: AbortSignal.timeout(15_000) }) : [];
    const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
      model: selection.model, thinkingLevel: options.thinkingLevel || selection.thinkingLevel,
      scopedModels, noTools: options.isolated ? "builtin" : undefined });
    if (created.session.model && (options.thinkingLevel !== undefined || selection.thinkingLevel !== undefined)) {
      created.session.setThinkingLevel(created.session.thinkingLevel);
    }
    const diagnostics = [...services.diagnostics,
      ...services.resourceLoader.getExtensions().errors.map(({ path, error }) => ({ type: "error", message: `Failed to load extension "${path}": ${error}` })),
      ...(selection.warning ? [{ type: "warning", message: selection.warning }] : [])];
    return { ...created, services, diagnostics };
  }, { cwd: sessionManager.getCwd(), agentDir, sessionManager });
  for (const diagnostic of runtime.diagnostics) console.error(diagnostic.message);
  if (runtime.diagnostics.some(item => item.type === "error")) throw new Error("Embedded engine initialization failed");
  const settings = runtime.services.settingsManager;
  applyHttpProxySettings(settings.getGlobalSettings().httpProxy);
  configureHttpDispatcher(settings.getHttpIdleTimeoutMs());
  initTheme(settings.getTheme(), false);
  await runRpcMode(runtime);
} catch (error) {
  console.error(error?.stack || String(error));
  process.exit(1);
}
