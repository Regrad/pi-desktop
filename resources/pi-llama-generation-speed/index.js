const STATUS_KEY = "tokenSpeed";
const UPDATE_INTERVAL_MS = 250;

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

  const showIdle = () => {
    if (ui && hasUi) ui.setStatus(STATUS_KEY, "⚡ TPS: —");
  };

  const showSpeed = (tps, prefix = "⚡ TPS:") => {
    if (ui && hasUi) ui.setStatus(STATUS_KEY, `${prefix} ${tps.toFixed(1)} tok/s`);
  };

  const acceptChunk = (chunk, responseState) => {
    if (!isRecord(chunk) || !isRecord(chunk.timings)) return;
    const timings = chunk.timings;
    const tps = finitePositive(timings.predicted_per_second);
    if (!tps) return;

    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const isFinal = isRecord(chunk.usage)
      || choices.some((choice) => isRecord(choice) && choice.finish_reason != null);
    const now = Date.now();
    if (isFinal || now - lastUiUpdate >= UPDATE_INTERVAL_MS) {
      lastUiUpdate = now;
      showSpeed(tps);
    }

    if (!isFinal || responseState.finalRecorded) return;
    const predictedTokens = finitePositive(timings.predicted_n);
    const predictedMs = finitePositive(timings.predicted_ms);
    if (predictedTokens && predictedMs) {
      generatedTokens += predictedTokens;
      generationMs += predictedMs;
      responseState.finalRecorded = true;
    }
  };

  const captureTimings = (body) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const responseState = { finalRecorded: false };
    let buffer = "";

    const consumeLine = (line) => {
      const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!normalized.startsWith("data:")) return;
      const payload = normalized.slice(5).trimStart();
      if (!payload || payload === "[DONE]") return;
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
        } finally {
          if (agentRunning) showIdle();
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
  };

  wrappedFetch = async (input, init) => {
    if (!isChatCompletionRequest(input)) return originalFetch(input, init);
    const response = await originalFetch(input, enablePerTokenTimings(init));
    if (!response.ok || !response.body) return response;
    return new Response(captureTimings(response.body), {
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
    ui = ctx.ui;
    hasUi = ctx.hasUI;
    agentRunning = true;
    generatedTokens = 0;
    generationMs = 0;
    lastUiUpdate = 0;
    showIdle();
  });

  pi.on("agent_end", (_event, ctx) => {
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
    if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch;
    ui = undefined;
    hasUi = false;
    agentRunning = false;
    delete globalState["pi-llama-generation-speed/loaded"];
  });
}
