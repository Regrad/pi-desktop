const STATUS_KEY = "tokenSpeed";
const UPDATE_INTERVAL_MS = 250;
const CURRENT_SPEED_WINDOW_MS = 3_000;
const SLOT_POLL_MS = 750;
const FALLBACK_DELAY_MS = 1_000;
const SLOT_TIMEOUT_MS = 1_500;
const METRICS_CAPABILITY_TTL_MS = 60_000;
const PREFILL_BAR_WIDTH = 20;

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

// Telemetry routes need no body: only authentication is forwarded, never POST
// length or stream headers. llama.cpp and its forks mount them either next to the
// completion route (/v1/slots) or at the server root (/slots), so both candidates
// are offered and the caller keeps whichever one answered.
function telemetryEndpoints(input, init, route) {
  try {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (!/^https?:$/.test(url.protocol) || !url.pathname.endsWith("/chat/completions")) return;
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    const auth = new Headers();
    for (const name of ["authorization", "api-key", "x-api-key"]) if (headers.has(name)) auth.set(name, headers.get(name));
    const base = url.pathname.slice(0, -"/chat/completions".length);
    const urls = [];
    for (const pathname of [`${base}/${route}`, `/${route}`]) {
      const candidate = new URL(url);
      candidate.pathname = pathname;
      candidate.search = ""; candidate.hash = "";
      if (!urls.includes(candidate.href)) urls.push(candidate.href);
    }
    return { urls, url: urls[0], headers: auth };
  } catch { return; }
}

const slotsRequest = (input, init) => telemetryEndpoints(input, init, "slots");
const metricsRequest = (input, init) => telemetryEndpoints(input, init, "metrics");

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChatCompletionRequest(input) {
  const url = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
  return typeof url === "string" && url.includes("/chat/completions");
}

function countValue(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function formatPrefillDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 1) return "";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

// One layout for every source, so the line keeps its shape when prompt_progress,
// web telemetry or a proxy is what produced the numbers.
function prefillProgressLine({ total, processed, elapsedMs, rateTps }) {
  const done = countValue(processed) ?? 0;
  const hasTotal = Number.isFinite(total) && total > 0;
  if (!hasTotal) {
    const parts = [`${done} tokens`];
    const duration = formatPrefillDuration(elapsedMs / 1000);
    if (duration) parts.push(duration);
    return `Prefilling... ${parts.join(" · ")}`;
  }
  const ratio = Math.min(1, done / total);
  const filled = Math.round(ratio * PREFILL_BAR_WIDTH);
  const rate = finitePositive(rateTps);
  const suffix = [];
  if (rate) {
    const duration = formatPrefillDuration((total - done) / rate);
    if (duration) suffix.push(duration);
    suffix.push(`${rate.toFixed(1)} tok/s`);
  } else {
    const duration = formatPrefillDuration(elapsedMs / 1000);
    if (duration) suffix.push(duration);
  }
  const bar = "█".repeat(filled) + "░".repeat(PREFILL_BAR_WIDTH - filled);
  return `Prefilling... ${bar} ${(ratio * 100).toFixed(0).padStart(3)}%${suffix.length ? ` · ${suffix.join(" · ")}` : ""}`;
}

function prefillPhaseLine(phase, elapsedMs) {
  const label = typeof phase === "string" && phase.trim() ? phase.trim() : "reading the prompt";
  const duration = formatPrefillDuration(elapsedMs / 1000);
  return `Prefilling... ${label}${duration ? ` · ${duration}` : ""}`;
}

// The retired llama.cpp Stats add-on sent these alongside stream:true: without
// return_progress llama.cpp hides prompt_progress, and include_usage keeps the
// final accounting chunk arriving. Taking over the flags preserves what servers
// were asked for before this telemetry moved here.
function enableStreamTelemetry(init) {
  if (!init || typeof init.body !== "string") return init;
  try {
    const body = JSON.parse(init.body);
    if (!isRecord(body) || body.stream !== true) return init;
    body.timings_per_token = true;
    if (body.return_progress === undefined) body.return_progress = true;
    const options = isRecord(body.stream_options) ? body.stream_options : {};
    if (options.include_usage === undefined) options.include_usage = true;
    body.stream_options = options;
    return { ...init, body: JSON.stringify(body) };
  } catch {
    return init;
  }
}

function finitePositive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function serverTokenRecords(chunk) {
  const choice = chunk.choices?.find(value => value.index === 0) ?? chunk.choices?.[0];
  const entries = choice?.logprobs?.content;
  return Array.isArray(entries) ? entries.filter(entry => isRecord(entry) && typeof entry.token === "string").length : 0;
}

// Gufo 0.29+ exposes standard per-generated-token records without changing MTP
// or sampling. Other servers retain their existing timings/slot telemetry.
async function supportsTokenRecords(fetch, endpoint, model, signal) {
  const timeout = AbortSignal.any([AbortSignal.timeout(SLOT_TIMEOUT_MS), ...(signal ? [signal] : [])]);
  try {
    const models = new URL(endpoint.url), props = new URL(endpoint.url);
    models.pathname = models.pathname.replace(/\/slots$/, "/models");
    props.pathname = props.pathname.replace(/(?:\/v1)?\/slots$/, "/props");
    const values = await Promise.all([models, props].map(async url => {
      const response = await fetch(url.href, { headers: endpoint.headers, signal: timeout, redirect: "error" });
      if (!response.ok) { await response.body?.cancel(); return; }
      return response.json();
    }));
    const entry = values[0]?.data?.find(value => value.id === model);
    const version = typeof values[1]?.build_info === "string" && values[1].build_info.match(/^(\d+)\.(\d+)\./);
    return entry?.owned_by === "gufo" && Boolean(version && (+version[1] > 0 || +version[2] >= 29));
  } catch { return false; }
}

// llama.cpp forks that dropped the per-slot counters (Strata reports neither
// next_token nor per-token timings) still publish the same live figures their own
// web page uses: GET /metrics -> live.state / live.tok_s. The shape is probed, not
// guessed from a version string, so an unrelated server keeps its own telemetry.
function liveTelemetry(body) {
  const live = body?.live;
  // tok_s is null while the engine idles and absent while it reads a prompt, so the
  // phase field counts as a second proof that this is the live section.
  if (!isRecord(live)) return;
  return "tok_s" in live || typeof live.state === "string" ? live : undefined;
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
  const tokenRecordCapabilities = new Map();
  const metricsCapabilities = new Map();
  // A route that answered once is tried first afterwards; a missing one is probed
  // again after this interval, because a restarted server may mount it differently.
  const routeHealth = new Map();
  const ROUTE_RETRY_MS = 5 * 60_000;
  const telemetrySignal = signal => AbortSignal.any([AbortSignal.timeout(SLOT_TIMEOUT_MS), ...(signal ? [signal] : [])]);
  const fetchTelemetry = async (endpoints, signal) => {
    const order = [...endpoints.urls]
      .sort((a, b) => (routeHealth.get(b) === "ok" ? 1 : 0) - (routeHealth.get(a) === "ok" ? 1 : 0));
    for (const url of order) {
      const failed = routeHealth.get(url);
      if (typeof failed === "number" && Date.now() - failed < ROUTE_RETRY_MS) continue;
      const response = await originalFetch(url, { headers: endpoints.headers, signal, redirect: "error" });
      if (response.ok) { routeHealth.set(url, "ok"); return { url, response }; }
      await response.body?.cancel();
      routeHealth.set(url, Date.now());
    }
  };

  const observeGeneratedTokens = async (init, state) => {
    if (!state.endpoint || typeof init?.body !== "string") return init;
    let body;
    try { body = JSON.parse(init.body); } catch { return init; }
    if (body.stream !== true || typeof body.model !== "string" || body.logprobs !== undefined || body.top_logprobs !== undefined) return init;
    const key = `${state.endpoint.url}\n${body.model}`;
    let capability = tokenRecordCapabilities.get(key);
    if (!capability || Date.now() > capability.expires) {
      capability = { expires: Date.now() + 60_000,
        supported: supportsTokenRecords(originalFetch, state.endpoint, body.model, state.signal) };
      tokenRecordCapabilities.set(key, capability);
    }
    state.gufoSlots = await capability.supported;
    if (!state.gufoSlots) return init;
    return { ...init, body: JSON.stringify({ ...body, logprobs: true, top_logprobs: 0 }) };
  };

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
    clearTimeout(state.metricsTimer);
    state.metricsTimer = undefined;
    state.metricsAbort?.abort();
    state.metricsAbort = undefined;
  };
  const stopResponses = () => {
    for (const state of responses) stopPolling(state);
    responses.clear();
  };
  const clearSlotSpeed = state => {
    if (!state.slotSpeedDisplayed && !state.metricsLed) return;
    state.slotSpeedDisplayed = false;
    if (current(state) && !state.native) showIdle();
  };
  const clearWorking = () => { if (ui && hasUi) ui.setWorkingMessage(); };
  const showPrefillLine = (state, line) => {
    if (!current(state) || !ui || !hasUi) return;
    state.prefill.shown = true;
    ui.setWorkingMessage(line);
  };
  // The bar belongs to prefill only. As soon as this request produces anything, the
  // default working line owns the field again - that is what kept the bar from
  // sticking to generation.
  const clearPrefill = state => {
    if (!state.prefill.shown) return;
    state.prefill.shown = false;
    if (current(state)) clearWorking();
  };
  const reportStreamPrefill = (state, progress) => {
    const prefill = state.prefill;
    const total = countValue(progress.total) ?? prefill.total;
    const processed = countValue(progress.processed) ?? prefill.processed;
    const timeMs = countValue(progress.time_ms) ?? prefill.timeMs;
    const deltaTokens = processed - prefill.processed;
    const deltaMs = timeMs - prefill.timeMs;
    const measured = deltaTokens > 0 && deltaMs > 0 ? (deltaTokens / deltaMs) * 1_000 : prefill.rateTps;
    prefill.total = total;
    prefill.processed = processed;
    prefill.timeMs = timeMs;
    prefill.rateTps = Number.isFinite(measured) && measured > 0 ? measured : prefill.rateTps;
    prefill.fromStream = true;
    showPrefillLine(state, prefillProgressLine({
      total, processed, elapsedMs: timeMs, rateTps: prefill.rateTps,
    }));
  };
  // Web telemetry describes whichever request the server is running, so it speaks
  // only while the stream itself stayed silent about prefill.
  const reportLivePrefill = (state, live) => {
    const elapsedMs = (finitePositive(live.elapsed_s) ?? 0) * 1_000;
    const total = countValue(live.prompt_total) ?? countValue(live.prompt_tokens);
    const read = countValue(live.prompt_read);
    if (read !== undefined && total !== undefined) {
      state.prefill.total = total;
      state.prefill.processed = read;
      showPrefillLine(state, prefillProgressLine({
        total, processed: read, elapsedMs, rateTps: finitePositive(live.prefill_tok_s_mean),
      }));
    } else {
      showPrefillLine(state, prefillPhaseLine(live.phase, elapsedMs));
    }
  };
  // Gufo exposes Prometheus /metrics rather than Strata's JSON live section.
  // During cache preparation its stream can be silent; slots still report work.
  // This is explicitly server telemetry, and only one active task is usable.
  const startSlotPrefill = state => {
    if (!state.gufoSlots || state.sawOutput || state.prefill.fromStream) return;
    state.metricsTimer = setTimeout(() => void pollSlotPrefill(state), SLOT_POLL_MS);
  };
  const pollSlotPrefill = async state => {
    state.metricsTimer = undefined;
    if (!current(state) || state.final || state.sawOutput || state.prefill.fromStream || responses.size !== 1) return;
    const controller = new AbortController();
    state.metricsAbort = controller;
    try {
      const signal = AbortSignal.any([controller.signal, ...(state.signal ? [state.signal] : [])]);
      const found = await fetchTelemetry(state.endpoint, telemetrySignal(signal));
      const slots = found ? await found.response.json() : undefined;
      if (!current(state) || state.final || state.sawOutput || state.prefill.fromStream || responses.size !== 1) return;
      const active = Array.isArray(slots) ? slots.filter(slot => slot.is_processing === true) : [];
      if (active.length > 1) { clearPrefill(state); return; }
      if (active.length === 1) {
        const slot = active[0], task = countValue(slot.id_task ?? slot.task_id);
        if (task === undefined || (state.prefill.slotTask !== undefined && state.prefill.slotTask !== task)) {
          clearPrefill(state); return;
        }
        state.prefill.slotTask = task;
        const total = countValue(slot.n_prompt_tokens);
        const cached = countValue(slot.n_prompt_tokens_cache);
        const processed = countValue(slot.n_prompt_tokens_processed);
        const decoded = countValue(slot.next_token?.[0]?.n_decoded);
        if (decoded === undefined || decoded > 0) { clearPrefill(state); return; }
        state.prefill.fromSlots = true;
        // A fully accounted prompt with no token yet includes preparation and
        // first-token work. Calling it 100% would falsely imply that work ended.
        const line = total > 0 && cached !== undefined && processed !== undefined && cached + processed < total
          ? prefillProgressLine({ total, processed: cached + processed, elapsedMs: 0 }).replace("Prefilling...", "Server prompt processing...")
          : "Server: preparing context…";
        showPrefillLine(state, line);
      } else clearPrefill(state);
      state.metricsTimer = setTimeout(() => void pollSlotPrefill(state), SLOT_POLL_MS);
    } catch { if (!state.prefill.fromStream) clearPrefill(state); }
    finally { if (state.metricsAbort === controller) state.metricsAbort = undefined; }
  };
  // The server metric describes whichever request it is running, so it may only
  // be taken when this process holds the single request.
  const startMetrics = state => {
    if (!state.metrics || state.metricsStarted || state.metricsOff) return;
    state.metricsStarted = true;
    void pollMetrics(state);
  };
  const pollMetrics = async state => {
    state.metricsTimer = undefined;
    if (!current(state) || state.native || state.tokenRecords || state.final || state.metricsOff || !state.metrics) return;
    if (responses.size !== 1) { state.metricsOff = true; clearSlotSpeed(state); return; }
    if ((unavailableUntil.get(state.metrics.url) ?? 0) > Date.now()) { startSlotPrefill(state); return; }
    // Bound to no single response: the shared probe must not inherit one abort.
    const readMetrics = async signal => {
      try {
        const found = await fetchTelemetry(state.metrics, telemetrySignal(signal));
        if (!found) return;
        return liveTelemetry(await found.response.json());
      } catch {
        // Telemetry must never fail, retry or modify a generation request.
        return;
      }
    };
    let capability = metricsCapabilities.get(state.metrics.url);
    if (!capability || Date.now() > capability.expires) {
      capability = { expires: Date.now() + METRICS_CAPABILITY_TTL_MS, live: readMetrics() };
      metricsCapabilities.set(state.metrics.url, capability);
    }
    let live = await capability.live;
    if (live === undefined) { state.metricsOff = true; startSlotPrefill(state); return; }
    const controller = new AbortController();
    state.metricsAbort = controller;
    try {
      const signal = AbortSignal.any([controller.signal, ...(state.signal ? [state.signal] : [])]);
      if (capability.probed) live = await readMetrics(signal);
      capability.probed = true;
      if (!current(state) || state.native || state.tokenRecords || state.final || responses.size !== 1) return;
      if (live === undefined) {
        unavailableUntil.set(state.metrics.url, Date.now() + 60_000);
        state.metricsOff = true;
        clearSlotSpeed(state);
        startSlotPrefill(state);
        return;
      }
      if (live.state === "reading" && !state.sawOutput && !state.prefill.fromStream) reportLivePrefill(state, live);
      if (live.state === "generating" && typeof live.tok_s === "number" && live.tok_s > 0) {
        // Whichever telemetry channel answers first keeps the status field.
        state.metricsLed = true;
        state.slotsOff = true;
        if (Date.now() - lastUiUpdate >= UPDATE_INTERVAL_MS) {
          lastUiUpdate = Date.now();
          showSpeed(live.tok_s);
        }
      }
      state.metricsTimer = setTimeout(() => void pollMetrics(state), SLOT_POLL_MS);
    } finally {
      if (state.metricsAbort === controller) state.metricsAbort = undefined;
    }
  };
  const pollSlots = async state => {
    state.timer = undefined;
    if (!current(state) || state.slotsOff || state.native || state.tokenRecords || state.final || !state.endpoint) return;
    // A route that is missing or exposes no usable counters will not start to work
    // on a later poll, so hand the status field to /metrics instead of retrying.
    if (state.window.stopped) { clearSlotSpeed(state); startMetrics(state); return; }
    if (responses.size !== 1) { state.window.stopped = true; clearSlotSpeed(state); return; }
    if (state.endpoint.urls.every(url => (unavailableUntil.get(url) ?? 0) > Date.now())) { startMetrics(state); return; }
    const controller = new AbortController();
    state.pollAbort = controller;
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(SLOT_TIMEOUT_MS), ...(state.signal ? [state.signal] : [])]);
      const started = performance.now();
      const found = await fetchTelemetry(state.endpoint, signal);
      if (!found) {
        for (const url of state.endpoint.urls) unavailableUntil.set(url, Date.now() + 60_000);
        clearSlotSpeed(state);
        startMetrics(state);
        return;
      }
      // Parsing remains under the timeout, including a server that stalls mid-body.
      const slots = await found.response.json();
      if (!current(state) || state.native || state.tokenRecords || state.final || responses.size !== 1 || signal.aborted) return;
      const tps = state.window.sample(slots, (started + performance.now()) / 2);
      if (state.window.stopped) { clearSlotSpeed(state); startMetrics(state); return; }
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
    if (isRecord(chunk.prompt_progress) && !responseState.sawOutput) reportStreamPrefill(responseState, chunk.prompt_progress);
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const isFinal = isRecord(chunk.usage)
      || choices.some((choice) => isRecord(choice) && choice.finish_reason != null);
    if (isFinal) { responseState.final = true; clearPrefill(responseState); stopPolling(responseState); }
    const hasOutput = choices.some(choice => isRecord(choice?.delta) && (
      (typeof choice.delta.content === "string" && choice.delta.content.length > 0)
      || (typeof choice.delta.reasoning_content === "string" && choice.delta.reasoning_content.length > 0)
      || (Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length > 0)));
    const records = serverTokenRecords(chunk);
    if (records && !responseState.native && !isRecord(chunk.timings)) {
      responseState.tokenRecords = true;
      stopPolling(responseState);
      responseState.observedTokens += records;
      const now = performance.now(), samples = responseState.tokenSamples;
      samples.push({ tokens: responseState.observedTokens, ms: now });
      while (samples.length > 1 && samples[1].ms <= now - CURRENT_SPEED_WINDOW_MS) samples.shift();
      const first = samples[0], elapsed = now - first.ms;
      // Multiple model calls within one agent have one status field. Separate
      // chats run in separate Pi processes and each owns its own status.
      if (responses.size === 1 && elapsed >= UPDATE_INTERVAL_MS && Date.now() - lastUiUpdate >= UPDATE_INTERVAL_MS) {
        lastUiUpdate = Date.now();
        showSpeed(1000 * (responseState.observedTokens - first.tokens) / elapsed);
      }
    }
    if (hasOutput && !responseState.sawOutput) {
      responseState.sawOutput = true;
      clearPrefill(responseState);
      if (!responseState.native && !responseState.tokenRecords && !responseState.final && responseState.endpoint) responseState.timer = setTimeout(() => void pollSlots(responseState), FALLBACK_DELAY_MS);
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
    if (responses.size === 1 && (isFinal || now - lastUiUpdate >= UPDATE_INTERVAL_MS)) {
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
      if (responseState.prefill.shown) {
        responseState.prefill.shown = false;
        if (owned) clearWorking();
      }
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
      tokenRecords: false, observedTokens: 0, tokenSamples: [],
      finalRecorded: false, samples: [{ tokens: 0, ms: 0 }], window: new SlotSpeedWindow(),
      slotsOff: false, metrics: metricsRequest(input, init), metricsStarted: false,
      metricsOff: false, metricsLed: false, metricsTimer: undefined, metricsAbort: undefined,
      endpoint: slotsRequest(input, init), signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
      prefill: { total: 0, processed: 0, timeMs: 0, rateTps: 0, shown: false, fromStream: false } };
    state.onAbort = () => {
      stopPolling(state); state.final = true;
      // Aborted requests never emit their first token, so the bar is dropped here
      // instead of waiting for output that will not arrive. Only this epoch may
      // touch the field, to keep an old run from wiping a new run's line.
      if (state.prefill.shown && state.epoch === epoch && agentRunning) {
        state.prefill.shown = false;
        clearWorking();
      }
      if (state.epoch === epoch && agentRunning && responses.size === 1) showIdle();
    };
    if (current(state)) {
      responses.add(state);
      state.signal?.addEventListener("abort", state.onAbort, { once: true });
      if (responses.size > 1) for (const active of responses) {
        stopPolling(active); active.window.stopped = true; active.metricsOff = true; clearSlotSpeed(active);
        if (active.prefill.fromSlots) clearPrefill(active);
        if ((active.tokenRecords || active.metricsLed) && !active.native) showIdle();
      }
    }
    let response;
    const discardPending = () => {
      clearPrefill(state);
      stopPolling(state);
      responses.delete(state); state.closed = true;
      state.signal?.removeEventListener("abort", state.onAbort);
    };
    try {
      const request = originalFetch(input, await observeGeneratedTokens(enableStreamTelemetry(init), state));
      // Some servers flush completion headers only after prefill. Their live
      // telemetry must be observed while fetch is still waiting for those headers.
      if (current(state) && state.metrics) startMetrics(state);
      response = await request;
    } catch (error) {
      discardPending();
      throw error;
    }
    if (!response.ok || !response.body) {
      discardPending();
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
    // A new run starts from the default working line even if the previous one ended
    // mid-prefill (aborted request, server error).
    clearWorking();
    showIdle();
  });

  pi.on("turn_end", (_event, ctx) => {
    ui = ctx.ui;
    hasUi = ctx.hasUI;
    for (const state of responses) clearPrefill(state);
  });

  pi.on("agent_end", (_event, ctx) => {
    stopResponses();
    ui = ctx.ui;
    hasUi = ctx.hasUI;
    agentRunning = false;
    clearWorking();
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
