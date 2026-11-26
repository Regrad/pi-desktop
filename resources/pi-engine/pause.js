// Pause at a completed tool batch, or cancel the unfinished provider response.
// Tool results reach Pi's session history before the awaited turn_end listener.
export function createRunPause(session, publish) {
    let state;
    let toolsPending = false;
    let responseComplete = false;
    let stopping;
    const setState = (value) => {
        if (state === value) return;
        state = value;
        publish({ type: "desktop_pause_state", pause: state ?? null });
    };
    const stop = () => {
        stopping ??= session.abort().finally(() => { stopping = undefined; });
        return stopping;
    };
    return {
        get state() { return state; },
        request() {
            if ((!session.isStreaming && !session.isCompacting) || (responseComplete && !session.isCompacting)) {
                publish({ type: "desktop_pause_state", pause: null });
                return;
            }
            setState("requested");
            if (!toolsPending) return stop();
        },
        clear() { setState(undefined); },
        async prepareInput() {
            if (stopping) await stopping;
            else if (state === "requested") setState(undefined);
        },
        observe(event) {
            if (event.type === "agent_start") {
                toolsPending = false;
                responseComplete = false;
                if (state !== "requested") setState(undefined);
            }
            if (event.type === "message_start" && event.message?.role === "assistant") responseComplete = false;
            if (event.type === "message_end" && event.message?.role === "assistant") {
                toolsPending = event.message.content?.some(part => part.type === "toolCall" || part.type === "tool_call") ?? false;
                responseComplete = !toolsPending && event.message.stopReason === "stop";
            }
            if (event.type === "tool_execution_start") toolsPending = true;
            if (event.type === "agent_end" && state === "requested") session.desktopDiscardPausedResponse();
            if (event.type === "turn_end") {
                toolsPending = false;
                if (state === "requested") {
                    if (responseComplete) setState(undefined);
                    else void stop();
                }
            }
            if (event.type === "agent_settled" && state === "requested") setState("paused");
        },
    };
}
