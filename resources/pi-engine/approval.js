// Bind approval to the visible proposal already persisted by Pi, never to a
// second model-written copy or to private thinking blocks.
export function getApprovalMessage(sessionManager, toolCallId) {
    if (typeof toolCallId !== "string" || !toolCallId.trim()) throw new Error("Missing approval tool call.");
    const branch = sessionManager.getBranch();
    const user = branch.findLast(entry => entry.type === "message" && entry.message.role === "user");
    const assistant = branch.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
    const calls = assistant?.message.content.filter(part => part.type === "toolCall") ?? [];
    if (!user || !assistant || branch.indexOf(assistant) < branch.indexOf(user) ||
        !calls.some(call => toolCallId === call.id || toolCallId.startsWith(`${call.id}/`))) {
        throw new Error("The approval request no longer belongs to the current reply.");
    }
    const text = assistant.message.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim();
    if (!text) throw new Error("Explain the proposed changes in the chat before calling request_changes with {}.");
    return { messageId: assistant.id, userMessageId: user.id, toolCallId, text };
}

// Extension turn_end.continue=false does not end Pi's tool loop. Use the public
// agent boundary, after the SDK has persisted tool results and dispatched hooks.
export function installApprovalBoundary(session, readAccess, publish) {
    const previous = session.agent.finishTurn;
    const finishTurn = async (turn, signal) => {
        const decision = await previous?.(turn, signal);
        if (signal?.aborted) return decision;
        const access = readAccess();
        const source = access?.proposal?.source;
        if (access?.mode === "confirm" && access.phase === "review" && source &&
            turn.message.content.some(part => part.type === "toolCall" &&
                (part.id === source.toolCallId || source.toolCallId.startsWith(`${part.id}/`)))) {
            let current;
            try { current = getApprovalMessage(session.sessionManager, source.toolCallId); }
            catch { return decision; } // A newer message or history selection invalidates the request.
            if (current.messageId === source.messageId && current.userMessageId === source.userMessageId) {
                publish({ type: "desktop_approval_wait", revision: access.revision });
                return { action: "end" };
            }
        }
        return decision;
    };
    session.agent.finishTurn = finishTurn;
    return () => { if (session.agent.finishTurn === finishTurn) session.agent.finishTurn = previous; };
}
