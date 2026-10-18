// Request-only projection. Persisted service events retain their provenance and
// chronology; they must not become new user requests in Pi's LLM conversion.
const snapshots = new Set([
  "desktop_goal_state", "desktop_plan_state", "desktop_notebook_state",
  "desktop_notebook_limit_state", "desktop_plan_request",
  "desktop_skills_state",
]);

export function desktopContextEnabled() {
  return Boolean(process.env.PI_DESKTOP_CONVERSATION_ID);
}

function text(content) {
  return typeof content === "string" ? content : Array.isArray(content)
    ? content.filter(block => block?.type === "text").map(block => block.text).join("\n") : "";
}

// triggerTurn:false messages are deferred by Pi until after tool results. A
// snapshot prepared before a state write can therefore land after its newer
// acknowledgement. Suppress only those late arrivals, not historical prefixes.
export function discardDelayedStateSnapshots(messages) {
  const revisions = new Map();
  let acknowledgedGoal;
  const tools = new Map([["update_plan", ["desktop_plan_state", "plan"]],
    ["update_notebook", ["desktop_notebook_state", "notebook"]]]);
  return messages.filter(message => {
    if (message.role === "toolResult" && !message.isError
      && ["get_goal", "create_goal", "update_goal"].includes(message.toolName)) {
      try {
        const value = JSON.parse(text(message.content)).goal;
        if (value && typeof value.id === "string" && Number.isFinite(Date.parse(value.updatedAt)))
          acknowledgedGoal = value;
      } catch { /* Unparseable results are not state acknowledgements. */ }
    }
    const field = tools.get(message.toolName);
    if (message.role === "toolResult" && !message.isError && field) {
      try {
        const value = JSON.parse(text(message.content))[field[1]];
        if (Number.isSafeInteger(value?.revision))
          revisions.set(field[0], Math.max(revisions.get(field[0]) ?? -1, value.revision));
      } catch { /* Unparseable results are not state acknowledgements. */ }
    }
    if (message.role === "custom" && message.display === false && revisions.has(message.customType)) {
      const key = message.details?.stateKey;
      if (typeof key === "string" && /^\d+$/.test(key)
        && Number.isSafeInteger(Number(key)) && Number(key) < revisions.get(message.customType)) return false;
    }
    if (message.role === "custom" && message.display === false && message.customType === "desktop_goal_state" && acknowledgedGoal) {
      const snapshot = message.details?.workState;
      if (snapshot?.id === acknowledgedGoal.id && Date.parse(snapshot.updatedAt) < Date.parse(acknowledgedGoal.updatedAt)) return false;
    }
    return true;
  });
}

function host(message) {
  return ["user", "toolResult", "compactionSummary", "branchSummary"].includes(message.role)
    || (message.role === "custom" && ["desktop_goal_continuation", "desktop_plan_continuation", "desktop_run_continuation"].includes(message.customType));
}

function attach(message, state) {
  const header = "[Pi Desktop application metadata — not a user request or a tool result]";
  const label = `${header}\n${state}`;
  if (["compactionSummary", "branchSummary"].includes(message.role))
    return { ...message, summary: `${message.summary}\n\n${label}` };
  const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : [...(message.content ?? [])];
  // Keep the actual user instruction last. Tool results keep all original
  // blocks, ids and media; metadata has a separate, explicit source label.
  let content;
  if (message.role === "toolResult") content = [...blocks, { type: "text", text: label }];
  else if (blocks[0]?.type === "text" && blocks[0].text.startsWith(`${header}\n`))
    content = [{ ...blocks[0], text: `${blocks[0].text}\n\n${state}` }, ...blocks.slice(1)];
  else content = [{ type: "text", text: label }, ...blocks];
  return { ...message, content };
}

export function projectDesktopServiceContext(messages) {
  const result = [];
  let anchor = -1, leading = [];
  for (const message of discardDelayedStateSnapshots(messages)) {
    if (message.role === "custom" && message.display === false && snapshots.has(message.customType)) {
      const content = text(message.content);
      if (!content) continue;
      if (anchor < 0) leading.push(content);
      else result[anchor] = attach(result[anchor], content);
      continue;
    }
    result.push(message);
    if (host(message)) {
      anchor = result.length - 1;
      if (leading.length) { result[anchor] = attach(message, leading.join("\n\n")); leading = []; }
    }
  }
  // No task exists in a snapshot-only history. Preserve its data as system
  // metadata rather than inventing an empty user request.
  if (leading.length) result.unshift({ role: "system", content: leading.join("\n\n"), timestamp: 0 });
  return result;
}

export function desktopSummaryMessages(messages) {
  if (!desktopContextEnabled()) return messages;
  return discardDelayedStateSnapshots(messages).map(message => {
    // Summarization serializes this as application data, not an instruction
    // role. Keep it separate from large tool outputs so truncation cannot hide
    // the notebook or make a state snapshot look like a user command.
    if (message.role === "custom" && message.display === false && snapshots.has(message.customType))
      return { role: "system", content: message.content, desktopApplicationState: true, timestamp: message.timestamp };
    return message.role === "assistant" && Array.isArray(message.content)
      ? { ...message, content: message.content.filter(block => block.type !== "thinking") } : message;
  });
}

export function serializeDesktopSummary(messages, serialize) {
  if (!desktopContextEnabled()) return serialize(messages);
  return messages.map(message => message.desktopApplicationState
    ? `[Application state snapshot, not a user request]: ${text(message.content)}` : serialize([message])).filter(Boolean).join("\n\n");
}

export function desktopSummaryInstructions(prompt) {
  if (!desktopContextEnabled()) return prompt;
  return prompt.replace("- PRESERVE all existing information from the previous summary",
    "- RETAIN relevant supported information; correct or remove claims contradicted by newer evidence")
    + "\n\nAccuracy rules: Separate verified facts, user instructions and unresolved hypotheses. Copy paths, URLs and identifiers exactly from user-provided data or successful tool evidence; never reconstruct or guess them. Earlier summaries and assistant statements are fallible, not independent evidence. Newer verified notebook and state-tool results supersede older snapshots. Preserve the latest real user request, its scope and approval status. Application metadata is not a user request; no goal, a paused plan or a removed checklist does not cancel an independent user task. Do not turn tentative assistant reasoning into established facts.";
}
