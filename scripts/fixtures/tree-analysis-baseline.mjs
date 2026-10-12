// Executes the original, file-local algorithms in a disposable process. No Pi
// session or site commands run here. Used only for IPC/result parity tests.
globalThis[Symbol.for("pi.desktop.analysis.worker")] = true;
const { serialize, deserialize } = await import("node:v8");
const { runTreeOperation } = await import("../../node_modules/pi-lens/dist/desktop-analysis/tree-operations.mjs");
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const results = [];
for (const payload of deserialize(Buffer.concat(chunks))) {
  const result = await runTreeOperation(payload);
  if (result.error) throw new Error(result.error);
  results.push({ value: result.value });
}
process.stdout.write(serialize(results));
