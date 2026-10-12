// Pi 1.0.4 clears forced prompt options at settlement. Desktop service turns
// must run the same prompt/loadout hooks as user turns, without inventing input.
export function patchDesktopContinuation(source) {
  const normalized = source.replace(/\r\n/g, "\n");
  const anchor = "    async _runAgentPrompt(messages) {\n        this._agentRunAbortRequested = false;";
  const replacement = `    async _runAgentPrompt(messages) {
        // Pi Desktop: prepare an idle service continuation before its first request.
        if (!Array.isArray(messages) && messages?.role === "custom" &&
            ["desktop_plan_continuation", "desktop_goal_continuation"].includes(messages.customType)) {
            const selectedToolsBefore = this._baseSystemPromptOptions.selectedTools.slice();
            const result = await this._extensionRunner.emitBeforeAgentStart("", undefined, this._baseSystemPromptOptions);
            const handlerEditedTools = result.systemPromptOptions.selectedTools.length !== selectedToolsBefore.length ||
                result.systemPromptOptions.selectedTools.some((name, index) => name !== selectedToolsBefore[index]);
            if (!handlerEditedTools)
                result.systemPromptOptions.selectedTools = this.getActiveToolNames();
            const updateMessage = this._preparePromptAndToolLoadout(result.systemPromptOptions);
            this._runSystemPromptOptions = result.systemPromptOptions;
            messages = [messages, ...result.messages.map(message => ({
                role: "custom", customType: message.customType, content: message.content ?? [],
                display: message.display, details: message.details, timestamp: Date.now(),
            }))];
            if (updateMessage) messages.unshift(updateMessage);
        }
        this._agentRunAbortRequested = false;`;
  if (normalized.includes(replacement)) return source;
  if (normalized.split(anchor).length !== 2) throw new Error("Pi Desktop continuation bridge no longer matches pinned Pi; review before applying.");
  const result = normalized.replace(anchor, replacement);
  return source.includes("\r\n") ? result.replace(/\n/g, "\r\n") : result;
}
