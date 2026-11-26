// Keep context-only continuation inside Pi's normal run/settlement lifecycle.
// Applied to generated SDK output, leaving the imported upstream sources intact.
export function patchDesktopContinuation(source) {
  const normalized = source.replace(/\r\n/g, "\n");
  if (normalized.includes("desktopDiscardPausedResponse() {")) return source;
  for (const anchor of [
    "async _startRun(trigger, onStarted)",
    "messages = await this._prepareRun(trigger);",
    "emitBeforeAgentStart(trigger, this._baseSystemPromptOptions)",
    'if (trigger.messageType === "custom")',
    'await this._startRun({ messageType: "custom", message: appMessage });',
    "await this.agent.prompt(messages);",
    "_omitRecoveryAttempt(message)",
    "_findLastAssistantMessage()",
  ]) {
    if (!normalized.includes(anchor)) {
      throw new Error("Pi Desktop continuation bridge no longer matches pinned Pi; review before applying.");
    }
  }
  return source
    .replace("async _startRun(trigger, onStarted)", "async _startRun(trigger, onStarted, contextOnly = false)")
    .replace("messages = await this._prepareRun(trigger);", "messages = contextOnly ? [] : await this._prepareRun(trigger);")
    .replace("await this.agent.prompt(messages);", "if (contextOnly) await this.agent.continue();\n            else await this.agent.prompt(messages);")
    .replace("async _startRun(trigger, onStarted, contextOnly = false) {", `desktopDiscardPausedResponse() {
        const last = this._findLastAssistantMessage();
        if (last?.role === "assistant" && (last.stopReason === "aborted" || last.stopReason === "error")) {
            this._omitRecoveryAttempt(last);
        }
    }
    async desktopContinue() {
        if (this.isStreaming || this.isCompacting) throw new Error("Thread is not idle");
        this.desktopDiscardPausedResponse();
        await this._startRun(undefined, undefined, true);
    }
    async _startRun(trigger, onStarted, contextOnly = false) {`);
}
