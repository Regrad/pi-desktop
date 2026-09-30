import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, rm, readFile, unlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
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
const { segmentationGraph, validateSegmentation } = await import("../electron/comfy-segmentation.ts");
const { DEFAULT_COMFY_SETTINGS } = await import("../shared/comfy.ts");
const { saveComfySettings, loadComfySettings, runComfy } = await import("../electron/comfy-client.ts");
const { collectAnswerMedia, collectComfyImages } = await import("../src/comfy-images.ts");
const { default: extension } = await import("../electron/comfy-extension.ts");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF3sAAAAASUVORK5CYII=", "base64");

test("segmentation validates original-coordinate prompts and rejects control syntax", () => {
  const input = { images: ["source.png"], targets: ["person"] };
  assert.doesNotThrow(() => validateSegmentation(input));
  for (const patch of [{ targets: [] }, { targets: ["person:10000"] }, { targets: ["person, dog"] }, { threshold: NaN }, { max_objects: 0 }, { refine_iterations: 6 }, { positive_points: [{ x: -1, y: 0 }] }, { negative_points: [{ x: 100, y: 0 }] }, { boxes: [{ x: 0, y: 0, width: 101, height: 5 }] }, { width: 64 }]) {
    assert.throws(() => validateSegmentation({ ...input, ...patch }, { width: 100, height: 50 }));
  }
  assert.doesNotThrow(() => validateSegmentation({ images: ["source.png"], positive_points: [{ x: 99, y: 49 }] }, { width: 100, height: 50 }));
  assert.throws(() => validateSegmentation({ images: ["source.png"], negative_points: [{ x: 0, y: 0 }] }));
});

test("SAM3 graph keeps original size, yields mask plus visible RGB preview, bounds category counts", () => {
  const graph = segmentationGraph(DEFAULT_COMFY_SETTINGS, { targets: ["person", "wooden crate"], max_objects: 4 }, "source.png");
  assert.equal(graph.text.inputs.text, "person:4, wooden crate:4");
  assert.equal(graph.detect.inputs.individual_masks, false);
  assert.deepEqual(graph.save_mask.inputs.images, ["mask_rgb", 0]);
  assert.deepEqual(graph.preview.inputs.mask, ["detect", 0]);
  assert.deepEqual(graph.preview.inputs.destination, ["mask_rgb", 0]);
  assert.ok(!Object.values(graph).some(n => /Sampler|Scale/.test(n.class_type)));
  const points = segmentationGraph(DEFAULT_COMFY_SETTINGS, { positive_points: [{ x: 1, y: 2 }], boxes: [{ x: 0, y: 0, width: 10, height: 20 }] }, "source.png");
  assert.equal(points.text, undefined);
  assert.equal(points.detect.inputs.conditioning, undefined);
  assert.equal(points.detect.inputs.positive_coords, '[{"x":1,"y":2}]');
  assert.deepEqual(points.box_0.inputs.bboxes, { x: 0, y: 0, width: 10, height: 20 });
  assert.deepEqual(points.mask_rgb.inputs.mask, ["box_union_0", 0]);
});

test("one, two and several boxes are dictionaries, never literal API arrays", () => {
  for (const count of [1, 2, 3, 16]) {
    const boxes = Array.from({ length: count }, (_, i) => ({ x: i, y: i, width: 10, height: 20 }));
    const graph = segmentationGraph(DEFAULT_COMFY_SETTINGS, { boxes }, "source.png");
    const detectors = Object.values(graph).filter(n => n.class_type === "SAM3_Detect");
    assert.equal(detectors.length, count);
    assert.deepEqual(detectors.map(n => n.inputs.bboxes), boxes);
    const unions = Object.values(graph).filter(n => n.class_type === "MaskComposite");
    assert.equal(unions.length, count - 1); assert.ok(unions.every(n => n.inputs.operation === "or"));
    for (const node of Object.values(graph)) for (const value of Object.values(node.inputs)) if (Array.isArray(value)) {
      assert.equal(value.length, 2); assert.equal(typeof value[0], "string");
      assert.ok(Number.isInteger(value[1]) && graph[value[0]], "Every API array is a real link");
    }
    assert.deepEqual(graph.mask_rgb.inputs.mask, graph.preview.inputs.mask);
  }
});

test("mask tool returns correct roles regardless of history output order and stays inside tool", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-sam-test-"));
  let calls = 0, graph;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.setHeader("Content-Type", "application/json"); calls++;
    if (req.url === "/upload/image") return res.end('{"name":"source.png"}');
    if (req.url === "/object_info") return res.end(JSON.stringify(Object.fromEntries(Object.values(segmentationGraph(DEFAULT_COMFY_SETTINGS, { targets: ["person"] }, "source.png")).map(n => [n.class_type, { api_node: false }]))));
    if (req.url === "/prompt") { graph = JSON.parse(Buffer.concat(chunks)).prompt; return res.end('{"prompt_id":"sam-test"}'); }
    if (req.url === "/history/sam-test") return res.end(JSON.stringify({ "sam-test": { status: { status_str: "success" }, outputs: {
      save_preview: { images: [{ filename: "selection.png", type: "output" }] },
      save_mask: { images: [{ filename: "mask.png", type: "output" }] },
    } } }));
    if (req.url.startsWith("/view?")) { res.setHeader("Content-Type", "image/png"); return res.end(png); }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  await saveComfySettings(dir, { ...structuredClone(DEFAULT_COMFY_SETTINGS), enabled: true, url: `http://127.0.0.1:${server.address().port}` });
  assert.equal((await loadComfySettings(dir)).segmentationCheckpoint, DEFAULT_COMFY_SETTINGS.segmentationCheckpoint);
  await assert.rejects(runComfy(dir, "segment", { images: ["attachment:a:1"], positive_points: [{ x: 1, y: 0 }] }, undefined, undefined, () => ({ data: png.toString("base64"), mimeType: "image/png" })), /Точки/);
  assert.equal(calls, 0);
  const old = process.env.PI_DESKTOP_DATA_DIR;
  process.env.PI_DESKTOP_DATA_DIR = dir;
  t.after(() => { if (old === undefined) delete process.env.PI_DESKTOP_DATA_DIR; else process.env.PI_DESKTOP_DATA_DIR = old; });
  const tools = []; await extension({ registerTool: tool => tools.push(tool) });
  const tool = tools.find(tool => tool.name === "comfyui_create_mask");
  const history = [{ id: "a", type: "message", message: { role: "user", content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] } }];
  const result = await tool.execute("id", { image: "attachment:a:1", targets: ["person"] }, undefined, undefined, { sessionManager: { getBranch: () => history } });
  const text = JSON.parse(result.content[0].text);
  assert.match(text.mask_path, /mask\.png$/); assert.match(text.preview_path, /selection\.png$/);
  assert.deepEqual(await readFile(text.mask_path), png);
  assert.equal(result.content.filter(p => p.type === "image").length, 2);
  assert.equal(graph.text.inputs.text, "person:1");
  assert.deepEqual(collectAnswerMedia([{ id: "a", name: tool.name, result }]).parts, []);
  assert.equal(collectComfyImages([{ id: "a", name: tool.name, result }]).length, 2);
  assert.match(tool.promptGuidelines.join(" "), /script/);
});

test("segmentation graph matches installed local schema and downloaded checkpoint", { skip: !process.env.PI_TEST_COMFY_SCHEMA }, async () => {
  const info = await (await fetch("http://127.0.0.1:8188/object_info")).json();
  const graph = segmentationGraph(DEFAULT_COMFY_SETTINGS, { targets: ["person"], positive_points: [{ x: 0, y: 0 }], boxes: [{ x: 0, y: 0, width: 1, height: 1 }, { x: 2, y: 2, width: 1, height: 1 }] }, "example.png");
  for (const node of Object.values(graph)) {
    const schema = info[node.class_type]; assert.ok(schema && !schema.api_node);
    for (const name of Object.keys(schema.input.required ?? {})) assert.ok(name in node.inputs, `${node.class_type}/${name}`);
    for (const name of Object.keys(node.inputs)) assert.ok(schema.input.required?.[name] || schema.input.optional?.[name]);
  }
  assert.ok(info.CheckpointLoaderSimple.input.required.ckpt_name[0].includes(DEFAULT_COMFY_SETTINGS.segmentationCheckpoint));
});

test("real local SAM3 accepts text, multiple boxes and points, including the failed user call", { skip: !process.env.PI_TEST_COMFY_SEGMENT }, async t => {
  const queue = await (await fetch("http://127.0.0.1:8188/queue")).json();
  assert.equal(queue.queue_running.length + queue.queue_pending.length, 0, "Do not disturb user jobs");
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-sam-live-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await saveComfySettings(dir, { ...structuredClone(DEFAULT_COMFY_SETTINGS), enabled: true });
  const cases = [
    { label: "text", images: ["C:/AI/ComfyUI/ComfyUI/input/example.png"], targets: ["person"] },
    { label: "two boxes", images: ["C:/AI/ComfyUI/ComfyUI/input/example.png"], boxes: [{ x: 180, y: 160, width: 440, height: 350 }, { x: 200, y: 480, width: 330, height: 280 }] },
    { label: "positive and negative points", images: ["C:/AI/ComfyUI/ComfyUI/input/example.png"], positive_points: [{ x: 380, y: 430 }], negative_points: [{ x: 20, y: 20 }] },
  ];
  if (process.env.PI_TEST_COMFY_FLAG) cases.push({ label: "original failed flag call", images: [process.env.PI_TEST_COMFY_FLAG], boxes: [{ x: 140, y: 205, width: 535, height: 380 }, { x: 215, y: 580, width: 120, height: 255 }] });
  for (const { label, ...input } of cases) {
  const result = await runComfy(dir, "segment", input);
  assert.equal(result.images.length, 2);
  assert.ok(result.images.some(image => image.nodeId === "save_mask"));
  assert.ok(result.images.some(image => image.nodeId === "save_preview"));
  const mask = result.images.find(image => image.nodeId === "save_mask");
  const preview = result.images.find(image => image.nodeId === "save_preview");
  const stats = JSON.parse(execFileSync("C:/AI/ComfyUI/python_embeded/python.exe", ["-c", "import sys,json;from PIL import Image; a=Image.open(sys.argv[1]).convert('L');b=Image.open(sys.argv[2]);print(json.dumps({'size':list(a.size),'mask_extrema':a.getextrema(),'preview_corner':b.getpixel((0,0))}))", mask.path, preview.path], { encoding: "utf8" }));
  assert.deepEqual(stats.size, [result.inputDimensions[0].width, result.inputDimensions[0].height]);
  assert.deepEqual(stats.mask_extrema, [0, 255]);
  assert.deepEqual(stats.preview_corner, [0, 0, 0]);
  const history = (await (await fetch(`http://127.0.0.1:8188/history/${result.promptId}`)).json())[result.promptId];
  // Remove only filenames generated/uploaded by this test, never scan or clean user folders.
  const uploadedInput = history.prompt[2].source.inputs.image;
  const files = [path.join("C:/AI/ComfyUI/ComfyUI/input", uploadedInput), ...Object.values(history.outputs).flatMap(v => v.images.map(o => path.join("C:/AI/ComfyUI/ComfyUI/output", o.subfolder, o.filename)))];
  for (const file of files) await unlink(file);
  console.log("SAM3 live completed", label, result.promptId, result.images.map(image => image.nodeId));
  }
});
