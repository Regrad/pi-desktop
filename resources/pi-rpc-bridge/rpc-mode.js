/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */
import * as crypto from "node:crypto";
import { KeybindingsManager } from "../../core/keybindings.js";
import { estimateTokens } from "../../core/compaction/compaction.js";
import { flushRawStdout, takeOverStdout, waitForRawStdoutBackpressure, writeRawStdout, } from "../../core/output-guard.js";
import { killTrackedDetachedChildren } from "../../utils/shell.js";
import { theme } from "../interactive/theme/theme.js";
import { toJsonEvent } from "../json-event.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";

function toDesktopJsonEvent(event) {
    const jsonEvent = toJsonEvent(event);
    if (event.type !== "message_update" || event.message?.role !== "assistant") {
        return jsonEvent;
    }
    const delta = event.assistantMessageEvent;
    if (!delta || !["toolcall_start", "toolcall_delta", "toolcall_end"].includes(delta.type)) {
        return jsonEvent;
    }
    const contentIndex = Number(delta.contentIndex);
    const content = Array.isArray(event.message.content) ? event.message.content[contentIndex] : undefined;
    if (content?.type !== "toolCall") {
        return jsonEvent;
    }
    return {
        ...jsonEvent,
        assistantMessageEvent: {
            ...jsonEvent.assistantMessageEvent,
            toolCall: {
                type: "toolCall",
                id: content.id,
                name: content.name,
                arguments: content.arguments,
            },
        },
    };
}
/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(runtimeHost) {
    takeOverStdout();
    let session = runtimeHost.session;
    let unsubscribe;
    let unsubscribeBackpressure;
    const output = (obj) => {
        writeRawStdout(serializeJsonLine(obj));
    };
    const success = (id, command, data) => {
        if (data === undefined) {
            return { id, type: "response", command, success: true };
        }
        return { id, type: "response", command, success: true, data };
    };
    const error = (id, command, message) => {
        return { id, type: "response", command, success: false, error: message };
    };
    // Pending extension UI requests waiting for response
    const pendingExtensionRequests = new Map();
    const widgetComponents = new Map();
    const keybindings = new KeybindingsManager();
    let hostEditorText = "";
    let workingVisible = true;
    let workingIndicator;
    let hiddenThinkingLabel;
    const stripTerminalCodes = (value) => String(value)
        .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
        .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g, "")
        .replace(/\u001B[@-_]/g, "")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
        .replace(/\s+$/g, "");
    const renderComponent = (component, width = 100) => {
        try {
            return (component?.render?.(width) ?? []).map(stripTerminalCodes);
        }
        catch (renderError) {
            return [`Extension UI render error: ${renderError instanceof Error ? renderError.message : String(renderError)}`];
        }
    };
    const createHeadlessTui = (requestRender) => ({
        requestRender,
        get width() { return 100; },
        get height() { return 40; },
    });
    // Shutdown request flag
    let shutdownRequested = false;
    let shuttingDown = false;
    const signalCleanupHandlers = [];
    /** Helper for dialog methods with signal/timeout support */
    function createDialogPromise(opts, defaultValue, request, parseResponse) {
        if (opts?.signal?.aborted)
            return Promise.resolve(defaultValue);
        const id = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            let timeoutId;
            const cleanup = () => {
                if (timeoutId)
                    clearTimeout(timeoutId);
                opts?.signal?.removeEventListener("abort", onAbort);
                pendingExtensionRequests.delete(id);
            };
            const onAbort = () => {
                cleanup();
                resolve(defaultValue);
            };
            opts?.signal?.addEventListener("abort", onAbort, { once: true });
            if (opts?.timeout) {
                timeoutId = setTimeout(() => {
                    cleanup();
                    resolve(defaultValue);
                }, opts.timeout);
            }
            pendingExtensionRequests.set(id, {
                resolve: (response) => {
                    cleanup();
                    resolve(parseResponse(response));
                },
                reject,
            });
            output({ type: "extension_ui_request", id, ...request });
        });
    }
    /**
     * Create an extension UI context that uses the RPC protocol.
     */
    const createExtensionUIContext = () => ({
        select: (title, options, opts) => createDialogPromise(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) => "cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
        confirm: (title, message, opts) => createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) => "cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false),
        input: (title, placeholder, opts) => createDialogPromise(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) => "cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
        notify(message, type) {
            // Fire and forget - no response needed
            output({
                type: "extension_ui_request",
                id: crypto.randomUUID(),
                method: "notify",
                message,
                notifyType: type,
            });
        },
        onTerminalInput() {
            // Raw terminal input not supported in RPC mode
            return () => { };
        },
        setStatus(key, text) {
            // Fire and forget - no response needed
            output({
                type: "extension_ui_request",
                id: crypto.randomUUID(),
                method: "setStatus",
                statusKey: key,
                statusText: text,
            });
        },
        setWorkingMessage(message) {
            output({
                type: "extension_ui_request",
                id: crypto.randomUUID(),
                method: "setWorkingMessage",
                workingText: message,
            });
        },
        setWorkingVisible(visible) {
            workingVisible = visible;
            output({
                type: "extension_ui_request",
                id: crypto.randomUUID(),
                method: "setWorkingVisible",
                workingVisible: visible,
            });
        },
        setWorkingIndicator(options) {
            workingIndicator = options;
            output({
                type: "extension_ui_request",
                id: crypto.randomUUID(),
                method: "setWorkingIndicator",
                workingIndicator: options,
            });
        },
        setHiddenThinkingLabel(label) {
            hiddenThinkingLabel = label;
            output({
                type: "extension_ui_request",
                id: crypto.randomUUID(),
                method: "setHiddenThinkingLabel",
                hiddenThinkingLabel: label,
            });
        },
        setWidget(key, content, options) {
            const previous = widgetComponents.get(key);
            previous?.dispose?.();
            widgetComponents.delete(key);
            if (content === undefined || Array.isArray(content)) {
                output({
                    type: "extension_ui_request",
                    id: crypto.randomUUID(),
                    method: "setWidget",
                    widgetKey: key,
                    widgetLines: content,
                    widgetPlacement: options?.placement,
                });
                return;
            }
            let component;
            const emit = () => output({
                type: "extension_ui_request",
                id: crypto.randomUUID(),
                method: "setWidget",
                widgetKey: key,
                widgetLines: renderComponent(component),
                widgetPlacement: options?.placement,
            });
            try {
                component = content(createHeadlessTui(emit), theme);
                widgetComponents.set(key, component);
                emit();
            }
            catch (widgetError) {
                output({
                    type: "extension_ui_request",
                    id: crypto.randomUUID(),
                    method: "setWidget",
                    widgetKey: key,
                    widgetLines: [`Widget error: ${widgetError instanceof Error ? widgetError.message : String(widgetError)}`],
                    widgetPlacement: options?.placement,
                });
            }
        },
        setFooter(factory) {
            if (!factory) {
                output({ type: "extension_ui_request", id: crypto.randomUUID(), method: "setFooter" });
                return;
            }
            let component;
            const emit = () => output({
                type: "extension_ui_request",
                id: crypto.randomUUID(),
                method: "setFooter",
                customLines: renderComponent(component),
            });
            const footerData = {
                getStatusEntries: () => new Map(),
                getBranch: () => undefined,
            };
            component = factory(createHeadlessTui(emit), theme, footerData);
            emit();
        },
        setHeader(factory) {
            if (!factory) {
                output({ type: "extension_ui_request", id: crypto.randomUUID(), method: "setHeader" });
                return;
            }
            let component;
            const emit = () => output({
                type: "extension_ui_request",
                id: crypto.randomUUID(),
                method: "setHeader",
                customLines: renderComponent(component),
            });
            component = factory(createHeadlessTui(emit), theme);
            emit();
        },
        setTitle(title) {
            // Fire and forget - host can implement terminal title control
            output({
                type: "extension_ui_request",
                id: crypto.randomUUID(),
                method: "setTitle",
                title,
            });
        },
        async custom(factory, options) {
            const id = crypto.randomUUID();
            return new Promise(async (resolve, reject) => {
                let component;
                let completed = false;
                const cleanup = (result) => {
                    if (completed)
                        return;
                    completed = true;
                    pendingExtensionRequests.delete(id);
                    component?.dispose?.();
                    output({ type: "extension_ui_request", id, method: "customClose" });
                    resolve(result);
                };
                const emit = () => output({
                    type: "extension_ui_request",
                    id,
                    method: "custom",
                    customLines: renderComponent(component, Number(options?.overlayOptions?.width) || 100),
                    overlay: options?.overlay,
                    overlayOptions: options?.overlayOptions,
                });
                pendingExtensionRequests.set(id, {
                    persistent: true,
                    resolve: (response) => {
                        if (response.cancelled) {
                            cleanup(undefined);
                            return;
                        }
                        if (typeof response.customInput === "string") {
                            component?.handleInput?.(response.customInput);
                            emit();
                        }
                    },
                    reject,
                });
                try {
                    component = await factory(createHeadlessTui(emit), theme, keybindings, cleanup);
                    emit();
                }
                catch (customError) {
                    pendingExtensionRequests.delete(id);
                    reject(customError);
                }
            });
        },
        pasteToEditor(text) {
            // Paste handling not supported in RPC mode - falls back to setEditorText
            this.setEditorText(text);
        },
        setEditorText(text) {
            hostEditorText = text;
            // Fire and forget - host can implement editor control
            output({
                type: "extension_ui_request",
                id: crypto.randomUUID(),
                method: "set_editor_text",
                text,
            });
        },
        getEditorText() {
            return hostEditorText;
        },
        async editor(title, prefill) {
            const id = crypto.randomUUID();
            return new Promise((resolve, reject) => {
                pendingExtensionRequests.set(id, {
                    resolve: (response) => {
                        if ("cancelled" in response && response.cancelled) {
                            resolve(undefined);
                        }
                        else if ("value" in response) {
                            resolve(response.value);
                        }
                        else {
                            resolve(undefined);
                        }
                    },
                    reject,
                });
                output({ type: "extension_ui_request", id, method: "editor", title, prefill });
            });
        },
        addAutocompleteProvider() {
            // Autocomplete provider composition is not supported in RPC mode
        },
        setEditorComponent() {
            // Custom editor components not supported in RPC mode
        },
        getEditorComponent() {
            // Custom editor components not supported in RPC mode
            return undefined;
        },
        get theme() {
            return theme;
        },
        getAllThemes() {
            return [];
        },
        getTheme(_name) {
            return undefined;
        },
        setTheme(_theme) {
            // Theme switching not supported in RPC mode
            return { success: false, error: "Theme switching not supported in RPC mode" };
        },
        getToolsExpanded() {
            // Tool expansion not supported in RPC mode - no TUI
            return false;
        },
        setToolsExpanded(_expanded) {
            // Tool expansion not supported in RPC mode - no TUI
        },
    });
    runtimeHost.setRebindSession(async () => {
        await rebindSession();
    });
    const rebindSession = async () => {
        session = runtimeHost.session;
        await session.bindExtensions({
            uiContext: createExtensionUIContext(),
            mode: "rpc",
            commandContextActions: {
                waitForIdle: () => session.waitForIdle(),
                newSession: async (options) => runtimeHost.newSession(options),
                fork: async (entryId, forkOptions) => {
                    const result = await runtimeHost.fork(entryId, forkOptions);
                    return { cancelled: result.cancelled };
                },
                navigateTree: async (targetId, options) => {
                    const result = await session.navigateTree(targetId, {
                        summarize: options?.summarize,
                        customInstructions: options?.customInstructions,
                        replaceInstructions: options?.replaceInstructions,
                        label: options?.label,
                    });
                    return { cancelled: result.cancelled };
                },
                switchSession: async (sessionPath, options) => {
                    return runtimeHost.switchSession(sessionPath, options);
                },
                reload: async () => {
                    await session.reload();
                },
            },
            shutdownHandler: () => {
                shutdownRequested = true;
            },
            onError: (err) => {
                output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
            },
        });
        const activeTools = session.extensionRunner.getActiveTools();
        const uniqueActiveTools = [...new Set(activeTools)];
        if (uniqueActiveTools.length !== activeTools.length) {
            session.setActiveToolsByName(uniqueActiveTools);
        }
        unsubscribe?.();
        unsubscribeBackpressure?.();
        unsubscribe = session.subscribe((event) => {
            output(toDesktopJsonEvent(event));
            if (event.type === "agent_settled") {
                void checkShutdownRequested();
            }
        });
        unsubscribeBackpressure = session.agent.subscribe(async () => {
            await waitForRawStdoutBackpressure();
        });
    };
    const registerSignalHandlers = () => {
        const signals = ["SIGTERM"];
        if (process.platform !== "win32") {
            signals.push("SIGHUP");
        }
        for (const signal of signals) {
            const handler = () => {
                killTrackedDetachedChildren();
                void shutdown(signal === "SIGHUP" ? 129 : 143, signal);
            };
            process.on(signal, handler);
            signalCleanupHandlers.push(() => process.off(signal, handler));
        }
    };
    await rebindSession();
    registerSignalHandlers();
    // Handle a single command
    const handleCommand = async (command) => {
        const id = command.id;
        switch (command.type) {
            // =================================================================
            // Prompting
            // =================================================================
            case "prompt": {
                // Start prompt handling immediately, but emit the authoritative response only after
                // prompt preflight succeeds. Queued and immediately handled prompts also count as success.
                let preflightSucceeded = false;
                void session
                    .prompt(command.message, {
                    images: command.images,
                    streamingBehavior: command.streamingBehavior,
                    source: "rpc",
                    preflightResult: (didSucceed) => {
                        if (didSucceed) {
                            preflightSucceeded = true;
                            output(success(id, "prompt"));
                        }
                    },
                })
                    .catch((e) => {
                    if (!preflightSucceeded) {
                        output(error(id, "prompt", e.message));
                    }
                });
                return undefined;
            }
            case "steer": {
                await session.steer(command.message, command.images);
                return success(id, "steer");
            }
            case "follow_up": {
                await session.followUp(command.message, command.images);
                return success(id, "follow_up");
            }
            case "abort": {
                await session.abort();
                return success(id, "abort");
            }
            case "new_session": {
                const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
                const result = await runtimeHost.newSession(options);
                if (!result.cancelled) {
                    await rebindSession();
                }
                return success(id, "new_session", result);
            }
            // =================================================================
            // State
            // =================================================================
            case "get_state": {
                const contextUsage = session.getSessionStats().contextUsage;
                const state = {
                    model: session.model,
                    thinkingLevel: session.thinkingLevel,
                    isStreaming: session.isStreaming,
                    isCompacting: session.isCompacting,
                    steeringMode: session.steeringMode,
                    followUpMode: session.followUpMode,
                    sessionFile: session.sessionFile,
                    sessionId: session.sessionId,
                    sessionName: session.sessionName,
                    autoCompactionEnabled: session.autoCompactionEnabled,
                    messageCount: session.messages.length,
                    pendingMessageCount: session.pendingMessageCount,
                    steeringMessages: [...session.getSteeringMessages()],
                    followUpMessages: [...session.getFollowUpMessages()],
                    contextUsage,
                    workingVisible,
                    workingIndicator,
                    hiddenThinkingLabel,
                };
                return success(id, "get_state", state);
            }
            case "get_extension_state": {
                const tools = session.extensionRunner.getAllRegisteredTools().map((tool) => ({
                    name: tool.definition.name,
                    description: tool.definition.description,
                    source: tool.sourceInfo?.path,
                    active: session.extensionRunner.getActiveTools().includes(tool.definition.name),
                }));
                return success(id, "get_extension_state", {
                    extensionPaths: session.extensionRunner.getExtensionPaths(),
                    activeTools: session.extensionRunner.getActiveTools(),
                    tools,
                    commandDiagnostics: session.extensionRunner.getCommandDiagnostics(),
                    shortcutDiagnostics: session.extensionRunner.getShortcutDiagnostics(),
                });
            }
            case "get_session_entries": {
                const entries = session.sessionManager.getEntries().map((entry) => {
                    let renderedLines;
                    let estimatedTokensAfter;
                    try {
                        if (entry.type === "compaction") {
                            const context = session.sessionManager.buildSessionContext(entry.id);
                            estimatedTokensAfter = context.messages.reduce((total, message) => total + estimateTokens(message), 0);
                        }
                        if (entry.type === "custom") {
                            const renderer = session.extensionRunner.getEntryRenderer(entry.customType);
                            renderedLines = renderComponent(renderer?.(entry, { expanded: false }, theme));
                        }
                        else if (entry.type === "custom_message") {
                            const renderer = session.extensionRunner.getMessageRenderer(entry.customType);
                            const customMessage = {
                                role: "custom",
                                customType: entry.customType,
                                content: entry.content,
                                display: entry.display,
                                details: entry.details,
                                timestamp: Date.parse(entry.timestamp),
                            };
                            renderedLines = renderComponent(renderer?.(customMessage, { expanded: false, outputPad: 1 }, theme));
                        }
                    }
                    catch (renderError) {
                        renderedLines = [`Extension entry render error: ${renderError instanceof Error ? renderError.message : String(renderError)}`];
                    }
                    return { ...entry, renderedLines, estimatedTokensAfter };
                });
                return success(id, "get_session_entries", { entries });
            }
            case "set_host_editor_text": {
                hostEditorText = typeof command.text === "string" ? command.text : "";
                return success(id, "set_host_editor_text");
            }
            case "clear_queue": {
                return success(id, "clear_queue", session.clearQueue());
            }
            // =================================================================
            // Model
            // =================================================================
            case "set_model": {
                const models = session.modelRuntime.getAvailableSnapshot();
                const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
                if (!model) {
                    return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
                }
                await session.setModel(model);
                return success(id, "set_model", model);
            }
            case "cycle_model": {
                const result = await session.cycleModel();
                if (!result) {
                    return success(id, "cycle_model", null);
                }
                return success(id, "cycle_model", result);
            }
            case "get_available_models": {
                const models = session.modelRuntime.getAvailableSnapshot();
                return success(id, "get_available_models", { models });
            }
            // =================================================================
            // Thinking
            // =================================================================
            case "set_thinking_level": {
                session.setThinkingLevel(command.level);
                return success(id, "set_thinking_level");
            }
            case "cycle_thinking_level": {
                const level = session.cycleThinkingLevel();
                if (!level) {
                    return success(id, "cycle_thinking_level", null);
                }
                return success(id, "cycle_thinking_level", { level });
            }
            case "get_available_thinking_levels": {
                const levels = session.getAvailableThinkingLevels();
                return success(id, "get_available_thinking_levels", { levels });
            }
            // =================================================================
            // Queue Modes
            // =================================================================
            case "set_steering_mode": {
                session.setSteeringMode(command.mode);
                return success(id, "set_steering_mode");
            }
            case "set_follow_up_mode": {
                session.setFollowUpMode(command.mode);
                return success(id, "set_follow_up_mode");
            }
            // =================================================================
            // Compaction
            // =================================================================
            case "compact": {
                const result = await session.compact(command.customInstructions);
                return success(id, "compact", result);
            }
            case "set_auto_compaction": {
                session.setAutoCompactionEnabled(command.enabled);
                return success(id, "set_auto_compaction");
            }
            case "reload": {
                if (session.isStreaming || session.isCompacting) {
                    return error(id, "reload", "Wait for the current operation to finish before reloading");
                }
                await session.reload();
                return success(id, "reload");
            }
            // =================================================================
            // Retry
            // =================================================================
            case "set_auto_retry": {
                session.setAutoRetryEnabled(command.enabled);
                return success(id, "set_auto_retry");
            }
            case "abort_retry": {
                session.abortRetry();
                return success(id, "abort_retry");
            }
            // =================================================================
            // Bash
            // =================================================================
            case "bash": {
                const eventResult = await session.extensionRunner.emitUserBash({
                    type: "user_bash",
                    command: command.command,
                    excludeFromContext: command.excludeFromContext ?? false,
                    cwd: session.sessionManager.getCwd(),
                });
                if (eventResult?.result) {
                    session.recordBashResult(command.command, eventResult.result, {
                        excludeFromContext: command.excludeFromContext,
                    });
                    return success(id, "bash", eventResult.result);
                }
                const result = await session.executeBash(command.command, undefined, {
                    excludeFromContext: command.excludeFromContext,
                    id,
                    operations: eventResult?.operations,
                });
                return success(id, "bash", result);
            }
            case "abort_bash": {
                session.abortBash();
                return success(id, "abort_bash");
            }
            // =================================================================
            // Session
            // =================================================================
            case "get_session_stats": {
                const stats = session.getSessionStats();
                return success(id, "get_session_stats", stats);
            }
            case "export_html": {
                const path = await session.exportToHtml(command.outputPath);
                return success(id, "export_html", { path });
            }
            case "switch_session": {
                const result = await runtimeHost.switchSession(command.sessionPath);
                if (!result.cancelled) {
                    await rebindSession();
                }
                return success(id, "switch_session", result);
            }
            case "fork": {
                const result = await runtimeHost.fork(command.entryId);
                if (!result.cancelled) {
                    await rebindSession();
                }
                return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
            }
            case "clone": {
                const leafId = session.sessionManager.getLeafId();
                if (!leafId) {
                    return error(id, "clone", "Cannot clone session: no current entry selected");
                }
                const result = await runtimeHost.fork(leafId, { position: "at" });
                if (!result.cancelled) {
                    await rebindSession();
                }
                return success(id, "clone", { cancelled: result.cancelled });
            }
            case "get_fork_messages": {
                const messages = session.getUserMessagesForForking();
                return success(id, "get_fork_messages", { messages });
            }
            case "get_entries": {
                const sessionManager = session.sessionManager;
                let entries = sessionManager.getEntries();
                if (command.since !== undefined) {
                    const sinceIndex = entries.findIndex((e) => e.id === command.since);
                    if (sinceIndex === -1) {
                        return error(id, "get_entries", `Entry not found: ${command.since}`);
                    }
                    entries = entries.slice(sinceIndex + 1);
                }
                return success(id, "get_entries", { entries, leafId: sessionManager.getLeafId() });
            }
            case "get_tree": {
                const sessionManager = session.sessionManager;
                return success(id, "get_tree", { tree: sessionManager.getTree(), leafId: sessionManager.getLeafId() });
            }
            case "get_last_assistant_text": {
                const text = session.getLastAssistantText();
                return success(id, "get_last_assistant_text", { text });
            }
            case "set_session_name": {
                const name = command.name.trim();
                if (!name) {
                    return error(id, "set_session_name", "Session name cannot be empty");
                }
                session.setSessionName(name);
                return success(id, "set_session_name");
            }
            // =================================================================
            // Messages
            // =================================================================
            case "get_messages": {
                return success(id, "get_messages", { messages: session.messages });
            }
            // =================================================================
            // Commands (available for invocation via prompt)
            // =================================================================
            case "get_commands": {
                const commands = [
                    { name: "compact", description: "Сжать контекст текущей сессии", source: "builtin" },
                    { name: "reload", description: "Перезагрузить расширения, навыки, промпты и настройки Pi", source: "builtin" },
                ];
                for (const command of session.extensionRunner.getRegisteredCommands()) {
                    commands.push({
                        name: command.invocationName,
                        description: command.description,
                        source: "extension",
                        sourceInfo: command.sourceInfo,
                    });
                }
                for (const template of session.promptTemplates) {
                    commands.push({
                        name: template.name,
                        description: template.description,
                        source: "prompt",
                        sourceInfo: template.sourceInfo,
                    });
                }
                for (const skill of session.resourceLoader.getSkills().skills) {
                    commands.push({
                        name: `skill:${skill.name}`,
                        description: skill.description,
                        source: "skill",
                        sourceInfo: skill.sourceInfo,
                    });
                }
                return success(id, "get_commands", { commands });
            }
            default: {
                const unknownCommand = command;
                return error(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
            }
        }
    };
    /**
     * Check if shutdown was requested and perform shutdown if so.
     * Called after handling each command when waiting for the next command.
     */
    let detachInput = () => { };
    async function shutdown(exitCode = 0, signal) {
        if (shuttingDown) {
            process.exit(exitCode);
        }
        shuttingDown = true;
        for (const cleanup of signalCleanupHandlers) {
            cleanup();
        }
        unsubscribe?.();
        unsubscribeBackpressure?.();
        await runtimeHost.dispose();
        detachInput();
        process.stdin.pause();
        if (signal !== "SIGTERM") {
            await flushRawStdout();
        }
        process.exit(exitCode);
    }
    async function checkShutdownRequested() {
        if (!shutdownRequested)
            return;
        await shutdown();
    }
    const handleInputLine = async (line) => {
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch (parseError) {
            output(error(undefined, "parse", `Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`));
            await waitForRawStdoutBackpressure();
            return;
        }
        // Handle extension UI responses
        if (typeof parsed === "object" &&
            parsed !== null &&
            "type" in parsed &&
            parsed.type === "extension_ui_response") {
            const response = parsed;
            const pending = pendingExtensionRequests.get(response.id);
            if (pending) {
                if (!pending.persistent)
                    pendingExtensionRequests.delete(response.id);
                pending.resolve(response);
            }
            return;
        }
        const command = parsed;
        try {
            const response = await handleCommand(command);
            if (response) {
                output(response);
                await waitForRawStdoutBackpressure();
            }
            await checkShutdownRequested();
        }
        catch (commandError) {
            output(error(command.id, command.type, commandError instanceof Error ? commandError.message : String(commandError)));
            await waitForRawStdoutBackpressure();
        }
    };
    const onInputEnd = () => {
        void shutdown();
    };
    process.stdin.on("end", onInputEnd);
    detachInput = (() => {
        const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
            void handleInputLine(line);
        });
        return () => {
            detachJsonl();
            process.stdin.off("end", onInputEnd);
        };
    })();
    // Keep process alive forever
    return new Promise(() => { });
}
//# sourceMappingURL=rpc-mode.js.map
