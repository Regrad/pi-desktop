import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import http from "node:http";

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const source = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(source))) return next(source.href, context);
  }
  return next(specifier, context);
} });
const catalog = await import("../resources/pi-comfyui/lib/workflow-catalog.ts");
const jobs = await import("../resources/pi-comfyui/lib/workflow-jobs.ts");
const { saveComfySettings } = await import("../resources/pi-comfyui/lib/comfy-client.ts");
const { DEFAULT_COMFY_SETTINGS } = await import("../shared/comfy.ts");
const { generatedMediaResponse } = await import("../electron/generated-media.ts");
const { collectComfyMedia } = await import("../src/comfy-images.ts");

const graph = () => ({
  "1": { class_type: "Source", inputs: { text: "original", steps: 25, image: "original.png", enabled: true, model: "test.safetensors" }, _meta: { title: "Input" } },
  "2": { class_type: "SaveAny", inputs: { value: ["1", 0], filename_prefix: "Saved" } },
});
const schema = () => ({
  Source: { description: "Generate image", input: { required: { text: ["STRING", { multiline: true }], steps: ["INT", { min: 1, max: 100 }], image: [["original.png"], { image_upload: true }], enabled: ["BOOLEAN"], model: [["test.safetensors", "other.safetensors"]] } }, output: ["IMAGE"] },
  SaveAny: { input: { required: { value: ["IMAGE"], filename_prefix: ["STRING"] } }, output_node: true },
});
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF3sAAAAASUVORK5CYII=", "base64");

async function fixture(t) {
  const data = await mkdtemp(path.join(os.tmpdir(), "pi-workflows-"));
  const workflows = new Map([["workflows/image.json", graph()]]), nodes = schema(), posted = [], requests = [];
  let queue = { queue_running: [], queue_pending: [] }, history = {}, lostResponse = false, rejectPrompt = false, cancelSupported = true;
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, method: req.method, body });
    res.setHeader("Content-Type", "application/json");
    const send = value => res.end(JSON.stringify(value));
    if (req.url.startsWith("/userdata?")) return send([...workflows.keys()].map(name => name.slice(10)).concat("../outside.json"));
    if (req.url.startsWith("/userdata/")) { const key = decodeURIComponent(req.url.slice(10)); if (workflows.has(key)) return send(workflows.get(key)); }
    if (req.url === "/object_info") return send(nodes);
    if (req.url.startsWith("/object_info/")) { const name = decodeURIComponent(req.url.slice(13)); return send(nodes[name] ? { [name]: nodes[name] } : {}); }
    if (req.url === "/models") return send(["diffusion_models", "checkpoints"]);
    if (req.url === "/models/diffusion_models") return send(["test.safetensors"]);
    if (req.url === "/upload/image") return send({ name: "uploaded.png", subfolder: "input" });
    if (req.url === "/prompt" && req.method === "POST") {
      const payload = JSON.parse(body); posted.push(payload);
      if (rejectPrompt) { res.statusCode = 400; return send({ error: "Invalid input", node_errors: { "1": "invalid" } }); }
      queue.queue_pending.push([1, payload.prompt_id, payload.prompt, { client_id: payload.client_id }]);
      if (lostResponse) return res.destroy();
      return send({ prompt_id: payload.prompt_id, number: 1 });
    }
    if (req.url === "/queue" && req.method === "GET") return send(queue);
    if (req.url === "/queue" && req.method === "POST") { const ids = JSON.parse(body).delete; queue.queue_pending = queue.queue_pending.filter(row => !ids.includes(row[1])); return send({}); }
    if (req.url.startsWith("/history/")) return send(history);
    if (/^\/api\/jobs\/[^/]+\/cancel$/.test(req.url)) {
      if (!cancelSupported) { res.statusCode = 404; return send({}); }
      const id = req.url.split("/")[3];
      queue.queue_running = queue.queue_running.filter(row => row[1] !== id);
      queue.queue_pending = queue.queue_pending.filter(row => row[1] !== id);
      history[id] = { status: { status_str: "error", messages: [["execution_interrupted", {}]] } };
      return send({ cancelled: true });
    }
    if (req.url.startsWith("/view?")) { res.setHeader("Content-Type", "image/png"); return res.end(png); }
    res.statusCode = 404; send({ error: "Not found" });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  await saveComfySettings(data, { ...DEFAULT_COMFY_SETTINGS, enabled: true, url });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(data, { recursive: true, force: true }); });
  const describe = async () => { const list = await catalog.findWorkflows(data); return catalog.inspectWorkflow(data, list.items[0].id); };
  const run = async (options = {}) => { const inspected = await describe(); return jobs.submitWorkflow(data, { workflowId: inspected.workflow.id, revision: inspected.revision, requestKey: "one generation", ...options }); };
  return { data, url, workflows, nodes, posted, requests, describe, run,
    get queue() { return queue; }, set queue(value) { queue = value; },
    set history(value) { history = value; },
    set lostResponse(value) { lostResponse = value; }, set rejectPrompt(value) { rejectPrompt = value; }, set cancelSupported(value) { cancelSupported = value; } };
}

test("catalog discovers new server/local workflows without registering tools; listing never executes", async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.data, "comfy-workflows"));
  await writeFile(path.join(f.data, "comfy-workflows/local.json"), JSON.stringify(graph()));
  let list = await catalog.findWorkflows(f.data, "", 0, 1);
  assert.equal(list.total, 2); assert.equal(list.nextOffset, 1);
  assert.ok(!list.items.some(item => item.location.includes("..")));
  f.workflows.set("workflows/new video.json", graph());
  list = await catalog.findWorkflows(f.data, "video");
  assert.equal(list.total, 1);
  assert.equal(f.posted.length, 0);
  assert.equal(f.requests.some(request => request.url === "/object_info"), false);
});

test("inspect reads exact values/schema, hides connections and rejects stale revisions", async t => {
  const f = await fixture(t), inspected = await f.describe();
  assert.deepEqual(inspected.problems, []);
  assert.equal(inspected.parameters.items.find(p => p.input === "steps").current, 25);
  assert.ok(!inspected.parameters.items.some(p => p.input === "value"));
  assert.equal(inspected.nodes.find(node => node.id === "2").output, true);
  f.workflows.get("workflows/image.json")["1"].inputs.steps = 30;
  const job = await jobs.submitWorkflow(f.data, { workflowId: inspected.workflow.id, revision: inspected.revision, requestKey: "stale" });
  assert.equal(job.status, "failed"); assert.match(job.error, /изменил/); assert.equal(f.posted.length, 0);
});

test("node/model discovery stays paged and preserves complete enum values", async t => {
  const f = await fixture(t);
  const found = await catalog.discoverNodes(f.data, { query: "generate" });
  assert.equal(found.total, 1);
  const node = await catalog.discoverNodes(f.data, { nodeClass: "Source", limit: 1 });
  const models = node.inputs.find(input => input.name === "model").choices;
  assert.equal(models.total, 2); assert.equal(models.nextOffset, 1);
  assert.deepEqual(await catalog.comfyJson(f.url, "/models/diffusion_models"), ["test.safetensors"]);
});

test("editor graphs use the supplied native compiler, never widget-index guessing", async t => {
  const f = await fixture(t);
  const editor = { nodes: [{ id: 123, type: "custom", widgets_values: ["text", "randomize", 25] }], definitions: { subgraphs: [] } };
  f.workflows.set("workflows/image.json", editor);
  const id = (await catalog.findWorkflows(f.data)).items[0].id;
  await assert.rejects(catalog.inspectWorkflow(f.data, id), /штатный экспорт/);
  let compiled = 0;
  const result = await catalog.inspectWorkflow(f.data, id, async received => { assert.deepEqual(received, editor); compiled++; return graph(); });
  assert.equal(result.format, "editor"); assert.equal(compiled, 1); assert.equal(f.posted.length, 0);
});

test("patches preserve defaults/graph, enforce types/enums and never replace connections", () => {
  const original = graph();
  const result = catalog.applyWorkflowPatches(original, [{ node: "1", input: "steps", value: 20 }], schema());
  assert.equal(result["1"].inputs.steps, 20); assert.equal(original["1"].inputs.steps, 25);
  assert.deepEqual(result["2"].inputs.value, ["1", 0]);
  for (const patch of [{ node: "1", input: "steps", value: "20" }, { node: "1", input: "model", value: "invented" }, { node: "2", input: "value", value: "broken link" }, { node: "1", input: "enabled", value: 1 }, { node: "1", input: "missing", value: 1 }])
    assert.throws(() => catalog.applyWorkflowPatches(original, [patch], schema()));
});

test("generic submission changes only requested values and recovers persisted request keys", async t => {
  const f = await fixture(t);
  const job = await f.run({ values: [{ node: "1", input: "steps", value: 20 }] });
  assert.equal(job.status, "queued"); assert.equal(f.posted.length, 1);
  assert.equal(f.posted[0].prompt["1"].inputs.steps, 20);
  assert.equal(f.posted[0].prompt["1"].inputs.text, "original");
  assert.equal(f.workflows.get("workflows/image.json")["1"].inputs.steps, 25);
  const same = await f.run({ values: [{ node: "1", input: "steps", value: 20 }] });
  assert.equal(same.id, job.id); assert.equal(same.reused, true); assert.equal(f.posted.length, 1);
  await assert.rejects(f.run({ values: [{ node: "1", input: "steps", value: 19 }] }), /другими параметрами/);
  assert.equal((await jobs.readJob(f.data, job.id)).promptId, job.promptId);
});

test("concurrent calls reserve one generation before POST", async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.run(), f.run()]);
  assert.equal(a.id, b.id); assert.equal(f.posted.length, 1);
});

test("lost queue acknowledgement remains unknown and reconnect checks the existing job", async t => {
  const f = await fixture(t); f.lostResponse = true;
  const job = await f.run(); assert.equal(job.status, "unknown"); assert.equal(f.posted.length, 1);
  assert.equal((await f.run()).reused, true); assert.equal(f.posted.length, 1);
  const recovered = await jobs.workflowJobStatus(f.data, job.id);
  assert.equal(recovered.status, "queued"); assert.equal(recovered.promptId, f.posted[0].prompt_id);
});

test("server validation errors, absent nodes and cloud nodes are not successful generations", async t => {
  const f = await fixture(t); f.rejectPrompt = true;
  assert.equal((await f.run()).status, "failed"); assert.equal(f.posted.length, 1);
  f.nodes.Source.api_node = true;
  const cloud = await f.run({ requestKey: "cloud" }); assert.equal(cloud.status, "failed"); assert.match(cloud.error, /облачный/); assert.equal(f.posted.length, 1);
  delete f.nodes.Source;
  const missing = await f.run({ requestKey: "missing" }); assert.match(missing.error, /отсутствует узел/); assert.equal(f.posted.length, 1);
});

test("uploads use server-returned names, validate all targets and keep graph connections", async t => {
  const f = await fixture(t), file = path.join(f.data, "reference.png");
  await writeFile(file, png);
  const job = await f.run({ files: [{ node: "1", input: "image", path: file }] });
  assert.equal(job.status, "queued"); assert.equal(f.posted[0].prompt["1"].inputs.image, "input/uploaded.png");
  const broken = await f.run({ requestKey: "bad uploads", files: [{ node: "1", input: "missing", path: file }] });
  assert.equal(broken.status, "failed"); assert.equal(f.requests.filter(request => request.url === "/upload/image").length, 1);
});

test("waiting is bounded, cancellation is job-specific, and old servers never receive global interrupt", async t => {
  const f = await fixture(t), job = await f.run();
  assert.equal((await jobs.waitWorkflowJob(f.data, job.id, 0)).status, "queued");
  f.queue = { queue_pending: [], queue_running: [[1, job.promptId, {}, {}], [2, "other", {}, {}]] };
  f.cancelSupported = false;
  await assert.rejects(jobs.cancelWorkflowJob(f.data, job.id), /чужую работу/);
  f.cancelSupported = true;
  assert.equal((await jobs.cancelWorkflowJob(f.data, job.id)).status, "cancelled");
  assert.equal(f.queue.queue_running.length, 1); assert.equal(f.queue.queue_running[0][1], "other");
  assert.ok(!f.requests.some(request => request.url === "/interrupt"));
});

test("completed mixed outputs are paginated, downloaded and published without base64 metadata", async t => {
  const f = await fixture(t), job = await f.run();
  f.history = { [job.promptId]: { status: { completed: true, status_str: "success" }, outputs: { "2": { images: [{ filename: "image.png", subfolder: "", type: "output" }], videos: [{ filename: "clip.mp4", subfolder: "", type: "output" }], files: [{ filename: "notes.txt", subfolder: "", type: "output" }] } } } };
  const first = await jobs.collectWorkflowJob(f.data, job.id, { limit: 1 });
  assert.equal(first.total, 3); assert.equal(first.nextOffset, 1); assert.equal(first.files[0].data, png.toString("base64"));
  const rest = await jobs.collectWorkflowJob(f.data, job.id, { offset: 1 });
  assert.deepEqual(rest.files.map(file => file.type), ["video", "file"]);
  for (const file of rest.files) {
    const kind = file.type === "video" ? "video" : "artifact";
    const response = await generatedMediaResponse(f.data, new Request(`pi-generated://${kind}/${path.basename(file.path)}`));
    assert.equal(response.status, 200);
    if (kind === "artifact") assert.equal(response.headers.get("content-disposition"), "attachment");
  }
  assert.equal(collectComfyMedia([{ id: "result", name: "comfyui_job", result: { details: { media: rest.files } } }]).length, 2);
  assert.deepEqual((await readdir(path.join(f.data, "comfy-jobs"))).filter(name => name.endsWith(".tmp")), []);
});

test("unsafe artifact paths and changed server/disabled integration are rejected", async t => {
  for (const filename of ["../secret", "C:secret", "..", "folder/file"]) assert.throws(() => jobs.workflowArtifacts({ "1": { files: [{ filename, type: "output" }] } }));
  const f = await fixture(t), job = await f.run();
  await saveComfySettings(f.data, { ...DEFAULT_COMFY_SETTINGS, enabled: true, url: "http://127.0.0.1:1" });
  await assert.rejects(jobs.workflowJobStatus(f.data, job.id), /другому серверу/);
  await saveComfySettings(f.data, { ...DEFAULT_COMFY_SETTINGS, enabled: false });
  await assert.rejects(catalog.findWorkflows(f.data), /отключён/);
});

test("node definition changes invalidate inspect even when the saved file is unchanged", async t => {
  const f = await fixture(t), inspected = await f.describe();
  f.nodes.Source.input.required.steps[1].max = 50;
  const job = await jobs.submitWorkflow(f.data, { workflowId: inspected.workflow.id, revision: inspected.revision, requestKey: "changed schema" });
  assert.equal(job.status, "failed"); assert.match(job.error, /описания узлов изменились/); assert.equal(f.posted.length, 0);
});

test("interrupting a wait leaves the GPU job intact and the saved ID resumable", async t => {
  const f = await fixture(t), job = await f.run();
  await assert.rejects(jobs.waitWorkflowJob(f.data, job.id, 30, AbortSignal.timeout(40)));
  assert.equal(f.queue.queue_pending[0][1], job.promptId);
  assert.equal(f.posted.length, 1);
  assert.equal(f.requests.some(request => request.method === "POST" && /cancel|interrupt/.test(request.url)), false);
  assert.equal((await jobs.readJob(f.data, job.id)).promptId, job.promptId);
});

test("large prompts stay bounded; source connections are available to the model", async t => {
  const f = await fixture(t);
  f.workflows.get("workflows/image.json")["1"].inputs.text = "a".repeat(10_000);
  const inspected = await f.describe();
  const prompt = inspected.parameters.items.find(p => p.input === "text").current;
  assert.equal(prompt.truncated, true); assert.ok(prompt.preview.length <= 1200);
  assert.deepEqual(inspected.nodes.find(node => node.id === "2").connections, [{ input: "value", source: "1", output: 0 }]);
});

test("one bad upload target is rejected before any earlier valid upload is sent", async t => {
  const f = await fixture(t), file = path.join(f.data, "reference.png");
  await writeFile(file, png);
  const job = await f.run({ files: [{ node: "1", input: "image", path: file }, { node: "2", input: "value", path: file }] });
  assert.equal(job.status, "failed"); assert.equal(f.posted.length, 0);
  assert.equal(f.requests.some(request => request.url === "/upload/image"), false);
});

test("a concurrently initializing reservation is read after completion, never resubmitted", async t => {
  const f = await fixture(t), job = await f.run();
  const filename = path.join(f.data, "comfy-jobs", `${job.id}.json`);
  const saved = await readFile(filename, "utf8");
  await writeFile(filename, "");
  const restore = new Promise(resolve => setTimeout(() => { void writeFile(filename, saved).then(resolve); }, 30));
  const reused = await f.run();
  await restore;
  assert.equal(reused.reused, true); assert.equal(f.posted.length, 1);
});

test("an incomplete/unknown history is not reported as a successful generation", async t => {
  const f = await fixture(t), job = await f.run();
  f.history = { [job.promptId]: { outputs: {} } };
  assert.equal((await jobs.workflowJobStatus(f.data, job.id)).status, "unknown");
});

test("saved job list recovers this chat's IDs without trusting stale statuses", async t => {
  const f = await fixture(t), job = await f.run();
  await writeFile(path.join(f.data, "comfy-jobs", `${"f".repeat(64)}.json`), "broken");
  const list = await jobs.listWorkflowJobs(f.data);
  assert.equal(list.total, 1); assert.equal(list.items[0].job_id, job.id);
  assert.equal(list.items[0].storedStatus, "queued"); assert.equal(list.unreadable.length, 1);
  assert.match(list.guidance, /snapshot/);
});

test("native export requests do not modify goal/plan and reject stopped or remote execution", async () => {
  const source = await readFile(new URL("../electron/pi-manager.ts", import.meta.url), "utf8");
  const anchor = "  private async handleGoalRequest(conversationId: string, request: JsonObject): Promise<unknown> {";
  const start = source.indexOf(anchor) + anchor.length;
  const end = source.indexOf('    if (request.action === "manage_skills")', start);
  assert.ok(start >= anchor.length && end > start);
  const body = stripTypeScriptTypes(`async function handle(conversationId, request) {${source.slice(start, end)}\n}`);
  const handle = new Function(`${body};return handle;`)();
  const state = { goal: { status: "paused" }, plan: { execution: "paused" } }, before = structuredClone(state);
  let calls = 0;
  const owner = { store: { getConversation: () => state }, runtimes: new Map(), compileComfyWorkflow: async (_id, workflow) => { calls++; return workflow; } };
  assert.deepEqual(await handle.call(owner, "chat", { action: "comfy_compile", params: { workflow: graph() } }), graph());
  assert.deepEqual(state, before);
  owner.runtimes.set("chat", { runAborted: true });
  await assert.rejects(handle.call(owner, "chat", { action: "comfy_compile" }), /отменён/);
  assert.equal(calls, 1);
  owner.runtimes.clear(); owner.remoteRuntime = true;
  await assert.rejects(handle.call(owner, "chat", { action: "comfy_compile" }), /исполнителе/);
  assert.equal(calls, 1);
});
