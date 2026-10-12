// Only used by supervisor tests. Never runs shell commands or reads project data.
process.on("message", ({ id, payload }) => {
  process.send({ id, started: true });
  if (payload.mode === "busy") {
    const until = Date.now() + Math.min(payload.durationMs ?? 10_000, 10_000);
    while (Date.now() < until) { /* deliberately block the CHILD event loop */ }
  }
  if (payload.mode === "crash") process.exit(42);
  process.send({ id, result: { evaluated: true, diagnostics: [], observations: [], logs: [], unsupportedLanguages: [], value: payload.value, retire: payload.retire } });
});
process.on("disconnect", () => process.exit(0));
