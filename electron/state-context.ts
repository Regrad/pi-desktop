import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";

/** Append-only service events. Tool acknowledgements already carry current state. */
export function stateContext(pi: ExtensionAPI, customType: string, toolNames: string[], stateField?: string) {
  return (messages: any[], state: unknown, content: string | undefined, key: (state: any) => string, reminder = false, reminderContent?: string) => {
    const identifyUser = (count: number, message: unknown) => createHash("sha256").update(JSON.stringify([count, message])).digest("hex");
    const user = messages.filter(message => message.role === "user");
    const userKey = user.length ? identifyUser(user.length, user.at(-1)) : undefined;
    let previous: string | undefined;
    let hadState = messages.some(message => message.role === "compactionSummary"
      || (message.role === "custom" && message.customType === customType.replace("_state", "_continuation")));
    let lastReminder: string | undefined;
    let seenUsers = 0;
    let seenUserKey: string | undefined;
    let acknowledgedGoal: { id: string; updatedAt: string } | undefined;
    for (const message of messages) {
      if (message.role === "user") seenUserKey = identifyUser(++seenUsers, message);
      if (message.role === "custom" && message.customType === customType) {
        // Deferred service messages may arrive after a newer tool acknowledgement.
        // Do not let an older numeric revision erase that acknowledgement.
        const incoming = message.details?.stateKey;
        if (["desktop_plan_state", "desktop_notebook_state"].includes(customType)
          && typeof previous === "string" && typeof incoming === "string"
          && /^\d+$/.test(previous) && /^\d+$/.test(incoming)
          && Number(incoming) < Number(previous)) continue;
        const snapshot = message.details?.workState;
        if (customType === "desktop_goal_state" && acknowledgedGoal && snapshot?.id === acknowledgedGoal.id
          && Date.parse(snapshot.updatedAt) < Date.parse(acknowledgedGoal.updatedAt)) continue;
        previous = message.details?.stateKey;
        hadState = true;
        lastReminder = message.details?.userKey;
      } else if (message.role === "toolResult" && !message.isError && toolNames.includes(message.toolName)) {
        try {
          const result = JSON.parse(message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join(""));
          const field = stateField ?? (customType === "desktop_plan_state" ? "plan" : "goal");
          if (Object.hasOwn(result, field)) {
            previous = key(result[field]); hadState = true; lastReminder = seenUserKey;
            if (customType === "desktop_goal_state" && result[field]?.id && result[field]?.updatedAt) acknowledgedGoal = result[field];
          }
        } catch { /* Non-state tool results are not acknowledgements. */ }
      }
    }
    const current = key(state);
    if (!content || (previous === current && (!reminder || !userKey || lastReminder === userKey)) || (!hadState && state === undefined)) return messages;
    const message = { role: "custom", customType, display: false,
      content: previous === current && reminder ? reminderContent ?? content : content,
      details: { stateKey: current, userKey,
        ...(["desktop_plan_state", "desktop_goal_state"].includes(customType) ? { workState: state ?? null } : {}) }, timestamp: Date.now() };
    // Pi persists after the current tool results while streaming; this projection
    // supplies the state to the current request without starting another turn.
    pi.sendMessage(message, { triggerTurn: false });
    return [...messages, message];
  };
}
