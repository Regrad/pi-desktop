// Pi 1.5 prepares user and idle custom-message runs through the same native
// pipeline. Keep a guarded compatibility check, not the obsolete 1.0.4 patch.
export function patchDesktopContinuation(source) {
  const normalized = source.replace(/\r\n/g, "\n");
  for (const anchor of [
    "async _startRun(trigger, onStarted)",
    "messages = await this._prepareRun(trigger);",
    "emitBeforeAgentStart(trigger, this._baseSystemPromptOptions)",
    'if (trigger.messageType === "custom")',
    'await this._startRun({ messageType: "custom", message: appMessage });',
  ]) {
    if (!normalized.includes(anchor)) {
      throw new Error("Pi Desktop continuation bridge no longer matches pinned Pi; review before applying.");
    }
  }
  return source;
}
