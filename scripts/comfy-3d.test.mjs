import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
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
const { DEFAULT_COMFY_SETTINGS } = await import("../shared/comfy.ts");
const { validateLocalGlb } = await import("../shared/glb.ts");
const { MODEL_GRAPHS } = await import("../electron/comfy-3d-graphs.ts");
const { builtinGraph, runComfy, saveComfySettings } = await import("../electron/comfy-client.ts");
const { collectComfyMedia } = await import("../src/comfy-images.ts");
const { generatedFile, generatedMediaResponse } = await import("../electron/generated-media.ts");
function glb(json = { asset: { version: "2.0" } }) {
  const text = JSON.stringify(json);
  const chunk = Buffer.from(text + " ".repeat((4 - Buffer.byteLength(text) % 4) % 4));
  const header = Buffer.alloc(20);
  header.write("glTF"); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + chunk.length, 8);
  header.writeUInt32LE(chunk.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, chunk]);
}
test("GLB validation rejects external resources and corrupt headers", () => {
  validateLocalGlb(glb());
  for (const uri of ["https://example.com/a.png", "file:///C:/secret", "a.png", "blob:foreign"]) {
    assert.throws(() => validateLocalGlb(glb({ asset: { version: "2.0" }, images: [{ uri }] })), /внешних/);
    assert.throws(() => validateLocalGlb(glb({ asset: { version: "2.0" }, buffers: [{ uri }] })), /внешних/);
  }
  assert.throws(() => validateLocalGlb(Buffer.from("not a model")));
  const corrupt = glb(); corrupt.writeUInt32LE(1, 8); assert.throws(() => validateLocalGlb(corrupt));
});
test("built-in 3D graphs preserve stages, seeds and separately bound views", () => {
  const single = builtinGraph(DEFAULT_COMFY_SETTINGS, "model3d", { seed: 0 }, ["one.png"]);
  assert.equal(single[122].inputs.image, "one.png");
  assert.equal(single[3].inputs.steps, 12);
  assert.equal(single[18].inputs.steps, 20);
  for (const n of Object.values(single)) if (n.class_type === "KSampler") assert.equal(n.inputs.seed, 0);
  assert.equal(single[322].class_type, "Save3DAdvanced");
  assert.deepEqual(single[322].inputs.viewport_state, {});
  const multi = builtinGraph(DEFAULT_COMFY_SETTINGS, "model3d_multiview", { seed: 42 }, ["front.png", "left.png", "back.png", "right.png"]);
  assert.deepEqual([338, 341, 342, 345].map(id => multi[id].inputs.image), ["front.png", "left.png", "back.png", "right.png"]);
  assert.ok(!Object.values(multi).some(n => ["ImageCropV2", "SaveImageAdvanced"].includes(n.class_type)));
  assert.throws(() => builtinGraph(DEFAULT_COMFY_SETTINGS, "model3d_multiview", {}, ["one.png"]), /image_2/);
  assert.equal(MODEL_GRAPHS.model3d[122].inputs.image, "{{image_1}}");
});
test("3D quality controls apply to both built-in workflows without changing defaults", () => {
  const options = { target_face_count: 20000, remesh_resolution: 512, shape_resolution: 1024, texture_resolution: 2048, normal_map_resolution: 1024, ao_resolution: 512, ao_samples: 32 };
  for (const [mode, images] of [["model3d", ["one.png"]], ["model3d_multiview", ["front.png", "left.png", "back.png", "right.png"]]]) {
    const graph = builtinGraph(DEFAULT_COMFY_SETTINGS, mode, { model3d_options: options }, images);
    assert.equal(graph[186].inputs.target_face_count, 20000);
    assert.equal(graph[241].inputs.resolution, 512);
    assert.equal(graph[94].inputs.target_resolution, 1024);
    assert.equal(graph[288].inputs.value, 2048);
    assert.equal(graph[224].inputs.resolution, 1024);
    assert.equal(graph[233].inputs.resolution, 512);
    assert.equal(graph[233].inputs.samples, 32);
    assert.equal(MODEL_GRAPHS[mode][186].inputs.target_face_count, 700000);
    assert.throws(() => builtinGraph(DEFAULT_COMFY_SETTINGS, mode, { model3d_options: { shape_resolution: 1100 } }, images), /shape_resolution/);
  }
});
test("3D API round trip persists only file metadata and serves a portable model", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-3d-test-"));
  const bytes = glb(); let queued = 0; let submitted;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/upload/image") return res.end('{"name":"upload.png"}');
    if (req.url === "/object_info") return res.end(JSON.stringify(Object.fromEntries(Object.values(MODEL_GRAPHS.model3d).map(n => [n.class_type, { api_node: false }]))));
    if (req.url === "/prompt") { queued++; submitted = JSON.parse(Buffer.concat(chunks)).prompt; return res.end('{"prompt_id":"3d-job"}'); }
    if (req.url === "/history/3d-job") return res.end(JSON.stringify({ "3d-job": { status: { status_str: "success" }, outputs: { saved: { "3d": [{ filename: "model.glb", subfolder: "3d", type: "output" }] }, preview: { images: [{ filename: "preview.png", type: "temp" }] } } } }));
    if (req.url.startsWith("/view?")) { res.setHeader("Content-Type", "application/octet-stream"); return res.end(bytes); }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  await saveComfySettings(dir, { ...structuredClone(DEFAULT_COMFY_SETTINGS), enabled: true, url: `http://127.0.0.1:${server.address().port}` });
  await assert.rejects(runComfy(dir, "model3d", { images: [] }), /изображение/);
  await assert.rejects(runComfy(dir, "model3d_multiview", { images: ["attachment:a:1"] }), /четыре/);
  assert.equal(queued, 0);
  const result = await runComfy(dir, "model3d", { images: ["attachment:a:1"], seed: 0 }, undefined, undefined, () => ({ mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF3sAAAAASUVORK5CYII=" }));
  assert.equal(submitted[122].inputs.image, "upload.png");
  assert.deepEqual(result.images, []); assert.deepEqual(result.audio, []);
  assert.equal(result.totalModels, 1); assert.equal("data" in result.models[0], false);
  assert.deepEqual(await readFile(result.models[0].path), bytes);
  const media = { type: "model3d", ...result.models[0] };
  const tool = { id: "3d-1", name: "comfyui_generate_3d", result: { details: { media: [media] } } };
  assert.deepEqual(collectComfyMedia([tool, structuredClone(tool)]), [media]);
  const url = `pi-generated://model3d/${encodeURIComponent(path.basename(media.path))}`;
  const response = await generatedMediaResponse(dir, new Request(url, { headers: { Origin: "null" } }));
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "model/gltf-binary");
  assert.equal(response.headers.get("access-control-allow-origin"), "null");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  const head = await generatedMediaResponse(dir, new Request(url, { method: "HEAD" }));
  assert.equal(head.headers.get("content-length"), String(bytes.length)); assert.equal(await head.text(), "");
  const relocated = path.join(dir, "relocated"); await mkdir(path.join(relocated, "3d-generation"), { recursive: true });
  await writeFile(path.join(relocated, "3d-generation", path.basename(media.path)), bytes);
  assert.equal((await generatedMediaResponse(relocated, new Request(url))).status, 200);
  await assert.rejects(generatedFile(dir, "model3d", "../secret.glb"));
});
test("bundled 3D graphs match the running ComfyUI schema", { skip: !process.env.PI_TEST_COMFY_SCHEMA }, async () => {
  const info = await (await fetch("http://127.0.0.1:8188/object_info")).json();
  for (const [mode, graph] of Object.entries(MODEL_GRAPHS)) for (const [id, node] of Object.entries(graph)) {
    const schema = info[node.class_type];
    assert.ok(schema && !schema.api_node, `${mode}/${id}: local node exists`);
    for (const name of Object.keys(schema.input.required ?? {})) assert.ok(name in node.inputs, `${mode}/${id}: missing ${name}`);
    for (const [name, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && typeof value[0] === "string" && Number.isInteger(value[1])) {
        assert.ok(graph[value[0]], `${mode}/${id}: dependency ${value[0]}`);
        assert.ok(value[1] < info[graph[value[0]].class_type].output.length, `${mode}/${id}: output index`);
      } else {
        const expected = schema.input.required?.[name] ?? schema.input.optional?.[name];
        assert.ok(expected || name.includes("."), `${mode}/${id}: unknown input ${name}`);
        if (expected && !String(value).includes("{{")) {
          if (Array.isArray(expected[0])) assert.ok(expected[0].includes(value), `${mode}/${id}/${name}: unsupported choice ${value}`);
          if (expected[0] === "INT") assert.ok(Number.isInteger(value), `${mode}/${id}/${name}: integer`);
        }
      }
    }
  }
});
