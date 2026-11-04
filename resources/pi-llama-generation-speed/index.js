const STATUS_KEY = "tokenSpeed";
const UPDATE_INTERVAL_MS = 250;
const CURRENT_SPEED_WINDOW_MS = 3_000;
const SLOT_POLL_MS = 750;
const FALLBACK_DELAY_MS = 1_000;
const SLOT_TIMEOUT_MS = 1_500;

// Counts are supplied by the server, not estimated from characters or SSE chunks.
// Without a shared request identifier, only a single execution slot is usable.
export class SlotSpeedWindow {
  task;
  samples = [];
  stopped = false;

  sample(slots, now) {
    if (this.stopped) return;
    const slot = Array.isArray(slots) && slots.length === 1 ? slots[0] : undefined;
    const task = slot?.id_task ?? slot?.task_id;
    const tokens = slot?.next_token?.[0]?.n_decoded;
    if (!slot || slot.is_processing !== true || !Number.isSafeInteger(task) || task < 0
      || !Number.isSafeInteger(tokens) || tokens < 0) {
      this.stopped = true;
      return;
    }
    if (this.task !== undefined && this.task !== task) {
      this.stopped = true;
      return;
    }
    this.task = task;
    const last = this.samples.at(-1);
    if (last && (tokens < last.tokens || now <= last.ms)) {
      this.stopped = true;
      return;
    }
    this.samples.push({ tokens, ms: now });
    const cutoff = now - CURRENT_SPEED_WINDOW_MS;
    while (this.samples.length > 1 && this.samples[1].ms <= cutoff) this.samples.shift();
    const first = this.samples[0];
    if (now > first.ms) return 1000 * (tokens - first.tokens) / (now - first.ms);
  }
}

function slotsRequest(input, init) {
  try {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (!/^https?:$/.test(url.protocol) || !url.pathname.endsWith("/chat/completions")) return;
    url.pathname = url.pathname.slice(0, -"/chat/completions".length) + "/slots";
    url.search = ""; url.hash = "";
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    // Only authentication is needed. Never forward POST body/length or stream headers.
    const auth = new Headers();
    for (const name of ["authorization", "api-key", "x-api-key"]) if (headers.has(name)) auth.set(name, headers.get(name));
    return { url: url.href, headers: auth };
  } catch { return; }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChatCompletionRequest(input) {
  const url = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
  return typeof url === "string" && url.includes("/chat/completions");
}

function enablePerTokenTimings(init) {
  if (!init || typeof init.body !== "string") return init;
  try {
    const body = JSON.parse(init.body);
    if (!isRecord(body) || body.stream !== true) return init;
    body.timings_per_token = true;
    return { ...init, body: JSON.stringify(body) };
  } catch {
    return init;
  }
}

function finitePositive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export default function piLlamaGenerationSpeed(pi) {
  const globalState = globalThis;
  if (globalState["pi-llama-generation-speed/loaded"]) return;
  globalState["pi-llama-generation-speed/loaded"] = true;

  const originalFetch = globalThis.fetch;
  let wrappedFetch;
  let ui;
  let hasUi = false;
  let agentRunning = false;
  let generatedTokens = 0;
  let generationMs = 0;
  let lastUiUpdate = 0;
  let epoch = 0;
  const responses = new Set();
  const unavailableUntil = new Map();

  const showIdle = () => {
    if (ui && hasUi) ui.setStatus(STATUS_KEY, "⚡ TPS: —");
  };

  const showSpeed = (tps, prefix = "⚡ TPS:") => {
    if (ui && hasUi) ui.setStatus(STATUS_KEY, `${prefix} ${tps.toFixed(1)} tok/s`);
  };

  const current = state => !state.closed && !state.signal?.aborted && state.epoch === epoch && agentRunning && hasUi;
  const stopPolling = state => {
    clearTimeout(state.timer);
    state.timer = undefined;
    state.pollAbort?.abort();
    state.pollAbort = undefined;
  };
  const stopResponses = () => {
    for (const state of responses) stopPolling(state);
    responses.clear();
  };
  const clearSlotSpeed = state => {
    if (!state.slotSpeedDisplayed) return;
    state.slotSpeedDisplayed = false;
    if (current(state) && !state.native) showIdle();
  };
  const pollSlots = async state => {
    state.timer = undefined;
    if (!current(state) || state.native || state.final || state.window.stopped || !state.endpoint) return;
    if (responses.size !== 1) { state.window.stopped = true; clearSlotSpeed(state); return; }
    if ((unavailableUntil.get(state.endpoint.url) ?? 0) > Date.now()) return;
    const controller = new AbortController();
    state.pollAbort = controller;
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(SLOT_TIMEOUT_MS), ...(state.signal ? [state.signal] : [])]);
      const started = performance.now();
      const response = await originalFetch(state.endpoint.url, {
        method: "GET", headers: state.endpoint.headers, signal, redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        unavailableUntil.set(state.endpoint.url, Date.now() + 60_000);
        clearSlotSpeed(state);
        return;
      }
      // Parsing remains under the timeout, including a server that stalls mid-body.
      const slots = await response.json();
      if (!current(state) || state.native || state.final || responses.size !== 1 || signal.aborted) return;
      const tps = state.window.sample(slots, (started + performance.now()) / 2);
      if (state.window.stopped) { clearSlotSpeed(state); return; }
      if (tps !== undefined) { showSpeed(tps); state.slotSpeedDisplayed = true; }
      state.timer = setTimeout(() => void pollSlots(state), SLOT_POLL_MS);
    } catch {
      // Telemetry must never fail, retry or modify a generation request.
      clearSlotSpeed(state);
    } finally {
      if (state.pollAbort === controller) state.pollAbort = undefined;
    }
  };

  const acceptChunk = (chunk, responseState) => {
    if (!isRecord(chunk) || !current(responseState)) return;
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const isFinal = isRecord(chunk.usage)
      || choices.some((choice) => isRecord(choice) && choice.finish_reason != null);
    if (isFinal) { responseState.final = true; stopPolling(responseState); }
    const hasOutput = choices.some(choice => isRecord(choice?.delta) && (
      (typeof choice.delta.content === "string" && choice.delta.content.length > 0)
      || (typeof choice.delta.reasoning_content === "string" && choice.delta.reasoning_content.length > 0)
      || (Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length > 0)));
    if (hasOutput && !responseState.sawOutput) {
      responseState.sawOutput = true;
      if (!responseState.native && !responseState.final && responseState.endpoint) responseState.timer = setTimeout(() => void pollSlots(responseState), FALLBACK_DELAY_MS);
    }
    if (!isRecord(chunk.timings)) return;
    const timings = chunk.timings;
    const predictedTokens = finitePositive(timings.predicted_n);
    const predictedMs = finitePositive(timings.predicted_ms);
    let currentTps;
    if (predictedTokens && predictedMs) {
      const samples = responseState.samples;
      const previous = samples[samples.length - 1];
      if (previous.tokens !== predictedTokens || previous.ms !== predictedMs) {
        samples.push({ tokens: predictedTokens, ms: predictedMs });
      }
      const cutoff = predictedMs - CURRENT_SPEED_WINDOW_MS;
      while (samples.length > 1 && samples[1].ms <= cutoff) samples.shift();
      const baseline = samples[0];
      const windowTokens = predictedTokens - baseline.tokens;
      const windowMs = predictedMs - baseline.ms;
      if (windowTokens > 0 && windowMs > 0) currentTps = 1_000 * windowTokens / windowMs;
    }
    currentTps ??= finitePositive(timings.predicted_per_second);
    if (!currentTps) return;
    responseState.native = true;
    stopPolling(responseState);

    const now = Date.now();
    if (isFinal || now - lastUiUpdate >= UPDATE_INTERVAL_MS) {
      lastUiUpdate = now;
      showSpeed(currentTps);
    }

    if (!isFinal || responseState.finalRecorded) return;
    if (predictedTokens && predictedMs) {
      generatedTokens += predictedTokens;
      generationMs += predictedMs;
      responseState.finalRecorded = true;
    }
  };

  const captureTimings = (body, responseState) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const finish = () => {
      const owned = current(responseState);
      responseState.closed = true;
      stopPolling(responseState);
      responses.delete(responseState);
      responseState.signal?.removeEventListener("abort", responseState.onAbort);
      if (owned && responses.size === 0) showIdle();
    };

    const consumeLine = (line) => {
      const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!normalized.startsWith("data:")) return;
      const payload = normalized.slice(5).trimStart();
      if (!payload) return;
      if (payload === "[DONE]") { responseState.final = true; stopPolling(responseState); return; }
      try {
        acceptChunk(JSON.parse(payload), responseState);
      } catch {
        // The original stream remains untouched when an auxiliary timing event is malformed.
      }
    };

    return new ReadableStream({
      async start(controller) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) consumeLine(line);
            controller.enqueue(value);
          }
          buffer += decoder.decode();
          if (buffer) consumeLine(buffer);
          controller.close();
        } catch (error) {
          if (!responseState.closed) controller.error(error);
        } finally {
          finish();
        }
      },
      cancel(reason) {
        finish();
        return reader.cancel(reason);
      },
    });
  };

  wrappedFetch = async (input, init) => {
    if (!isChatCompletionRequest(input)) return originalFetch(input, init);
    const state = { epoch, closed: false, native: false, final: false, sawOutput: false,
      finalRecorded: false, samples: [{ tokens: 0, ms: 0 }], window: new SlotSpeedWindow(),
      endpoint: slotsRequest(input, init), signal: init?.signal ?? (input instanceof Request ? input.signal : undefined) };
    state.onAbort = () => {
      stopPolling(state); state.final = true;
      if (state.epoch === epoch && agentRunning && responses.size === 1) showIdle();
    };
    if (current(state)) {
      responses.add(state);
      state.signal?.addEventListener("abort", state.onAbort, { once: true });
      if (responses.size > 1) for (const active of responses) {
        stopPolling(active); active.window.stopped = true; clearSlotSpeed(active);
      }
    }
    let response;
    try { response = await originalFetch(input, enablePerTokenTimings(init)); }
    catch (error) {
      responses.delete(state); state.closed = true;
      state.signal?.removeEventListener("abort", state.onAbort);
      throw error;
    }
    if (!response.ok || !response.body) {
      responses.delete(state); state.closed = true;
      state.signal?.removeEventListener("abort", state.onAbort);
      return response;
    }
    return new Response(captureTimings(response.body, state), {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
  };
  globalThis.fetch = wrappedFetch;

  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui;
    hasUi = ctx.hasUI;
    showIdle();
  });

  pi.on("before_agent_start", (_event, ctx) => {
    stopResponses();
    epoch++;
    ui = ctx.ui;
    hasUi = ctx.hasUI;
    agentRunning = true;
    generatedTokens = 0;
    generationMs = 0;
    lastUiUpdate = 0;
    showIdle();
  });

  pi.on("agent_end", (_event, ctx) => {
    stopResponses();
    ui = ctx.ui;
    hasUi = ctx.hasUI;
    agentRunning = false;
    if (generatedTokens > 0 && generationMs > 0) {
      showSpeed(generatedTokens / (generationMs / 1000), "⚡ Средний TPS:");
    } else {
      showIdle();
    }
  });

  pi.on("session_shutdown", () => {
    stopResponses();
    epoch++;
    if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch;
    ui = undefined;
    hasUi = false;
    agentRunning = false;
    delete globalState["pi-llama-generation-speed/loaded"];
  });
}
