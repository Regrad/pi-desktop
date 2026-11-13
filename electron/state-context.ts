import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";

/** Append-only snapshots and short reminders. Writes acknowledge revisions without repeating full state. */
export function stateContext(pi: ExtensionAPI, customType: string, toolNames: string[], stateField?: string) {
  return (messages: any[], state: unknown, content: string | undefined, key: (state: any) => string, reminder = false, reminderContent?: string,
    options: { refreshTurns?: number; changeContent?: string } = {}) => {
    const identifyUser = (count: number, message: unknown) => createHash("sha256").update(JSON.stringify([count, message])).digest("hex");
    const user = messages.filter(message => message.role === "user");
    const userKey = user.length ? identifyUser(user.length, user.at(-1)) : undefined;
    let previous: string | undefined;
    let hadState = messages.some(message => message.role === "compactionSummary"
      || (message.role === "custom" && message.customType === customType.replace("_state", "_continuation")));
    let lastReminder: string | undefined;
    let seenUsers = 0;
    let seenUserKey: string | undefined;
    let toolTurns = 0;
    const documentState = stateField === "notebook" || stateField === "planning" || customType === "desktop_plan_state";
    let hasSnapshot = !documentState;
    let acknowledgedGoal: { id: string; updatedAt: string } | undefined;
    for (const message of messages) {
      if (message.role === "user") seenUserKey = identifyUser(++seenUsers, message);
      if (message.role === "assistant" && Array.isArray(message.content)
        && message.content.some((part: any) => part.type === "toolCall")) toolTurns++;
      if (message.role === "custom" && message.customType === customType) {
        // Deferred service messages may arrive after a newer tool acknowledgement.
        // Do not let an older numeric revision erase that acknowledgement.
        const incoming = message.details?.stateKey;
        if (["desktop_plan_state", "desktop_notebook_state", "desktop_implementation_plan_state"].includes(customType)
          && typeof previous === "string" && typeof incoming === "string"
          && /^\d+$/.test(previous) && /^\d+$/.test(incoming)
          && Number(incoming) < Number(previous)) continue;
        const snapshot = message.details?.workState;
        if (customType === "desktop_goal_state" && acknowledgedGoal && snapshot?.id === acknowledgedGoal.id
          && Date.parse(snapshot.updatedAt) < Date.parse(acknowledgedGoal.updatedAt)) continue;
        previous = message.details?.stateKey;
        hadState = true;
        lastReminder = message.details?.userKey;
        toolTurns = 0;
        if (!message.details?.summary) hasSnapshot = true;
      } else if (message.role === "toolResult" && !message.isError && toolNames.includes(message.toolName)) {
        try {
          const result = JSON.parse(message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join(""));
          const field = stateField ?? (customType === "desktop_plan_state" ? "plan" : "goal");
          if (Object.hasOwn(result, field)) {
            previous = key(result[field]); hadState = true; lastReminder = seenUserKey;
            toolTurns = 0;
            if (typeof result[field]?.content === "string" || Array.isArray(result[field]?.steps)) hasSnapshot = true;
            if (customType === "desktop_goal_state" && result[field]?.id && result[field]?.updatedAt) acknowledgedGoal = result[field];
          }
        } catch { /* Non-state tool results are not acknowledgements. */ }
      }
    }
    const current = key(state);
    const refresh = reminder && ((userKey && lastReminder !== userKey)
      || (options.refreshTurns && toolTurns >= options.refreshTurns));
    if (!content || (previous === current && !refresh && hasSnapshot) || (!hadState && state === undefined)) return messages;
    const summary = hasSnapshot && (previous === current ? reminderContent : options.changeContent);
    const message = { role: "custom", customType, display: false,
      content: summary || content,
      details: { stateKey: current, userKey, ...(summary ? { summary: true } : {}),
        ...(["desktop_plan_state", "desktop_goal_state"].includes(customType) ? { workState: state ?? null } : {}) }, timestamp: Date.now() };
    // Pi persists after the current tool results while streaming; this projection
    // supplies the state to the current request without starting another turn.
    pi.sendMessage(message, { triggerTurn: false });
    return [...messages, message];
  };
}
