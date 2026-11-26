// Exercises real, installed editors in isolated fixtures; never opens personal files.
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = process.env.PI_CREATIVE_ROOT || path.resolve(import.meta.dirname, "..");
const tempRoot = process.platform === "win32" ? "C:\\AI_Temp" : tmpdir();
await mkdir(tempRoot, { recursive: true });
const directory = await mkdtemp(path.join(tempRoot, "pi-creative-live-"));
const env = { ...process.env, PI_CODING_AGENT_DIR: directory, PI_DESKTOP_CREATIVE_TEMP: tempRoot };
await writeFile(path.join(directory, "creative-tools.json"), "{}");

for (const name of process.argv.slice(2).filter(arg => arg !== "--describe").length
  ? process.argv.slice(2).filter(arg => arg !== "--describe") : ["blender", "aseprite", "froxel"]) {
  const client = new Client({ name: "pi-desktop-creative-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(root, "resources", "creative-tools", "mcp.mjs"), name], env, stderr: "pipe" });
  let diagnostics = "";
  transport.stderr?.on("data", bytes => { diagnostics = (diagnostics + bytes.toString()).slice(-6000); });
  try {
    await client.connect(transport);
    const inventory = (await client.listTools()).tools;
    const call = async (tool, args) => {
      const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 120_000 });
      assert.ok(!result.isError, `${name}.${tool}: ${JSON.stringify(result)}\n${diagnostics}`);
      return result;
    };
    if (process.argv.includes("--describe")) {
      console.log(JSON.stringify({ name, count: inventory.length, names: inventory.map(tool => tool.name), tools: inventory.filter(tool =>
        /^(add_object|save_file|export_mesh)$/.test(tool.name)).map(tool => ({ name: tool.name, input: tool.inputSchema })) }));
      continue;
    }
    if (name === "blender") {
      const blendFile = path.join(directory, "test.blend"), previewPath = path.join(directory, "blender.png");
      const result = await call("execute_blender_code", { blendFile, previewPath, code: `
import math
bpy.ops.mesh.primitive_cube_add()
bpy.context.object.name = 'smoke_cube'
bpy.ops.object.camera_add(location=(4, -6, 4))
camera = bpy.context.object
from mathutils import Vector
camera.rotation_euler = (Vector((0,0,0)) - camera.location).to_track_quat('-Z','Y').to_euler()
bpy.context.scene.camera = camera
bpy.ops.object.light_add(type='AREA', location=(2,-3,6))
bpy.context.object.data.energy = 500
scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE'
scene.render.resolution_x = 256
scene.render.resolution_y = 256
scene.render.resolution_percentage = 100
scene.render.filepath = ${JSON.stringify(previewPath)}
bpy.ops.render.render(write_still=True)
bpy.ops.export_scene.gltf(filepath=${JSON.stringify(path.join(directory, "blender.glb"))}, export_format='GLB')
` });
      assert.ok(result.content.some(block => block.type === "image"));
      const saved = await readFile(blendFile);
      const failed = await client.callTool({ name: "execute_blender_code", arguments: { blendFile, code: "raise RuntimeError('fixture failure')" } });
      assert.equal(failed.isError, true);
      assert.deepEqual(await readFile(blendFile), saved, "failed code changed saved project");
      const loaded = await call("execute_blender_code", { blendFile, code: "assert 'smoke_cube' in bpy.data.objects\nprint('project reopened')" });
      assert.match(loaded.content[0].text, /project reopened/);
    } else if (name === "aseprite") {
      const ready = await call("preflight", { mode: "headless" });
      const text = ready.content.filter(item => item.type === "text").map(item => item.text).join("\n");
      assert.equal(ready.structuredContent?.ready, true, text);
      await call("sprite_manage", { op: "new", width: 16, height: 16, colorMode: "rgb" });
      await call("draw", { ops: [{ kind: "rect", rect: { x: 3, y: 3, width: 10, height: 10 }, color: "#ef8040", fill: "#ef8040" }] });
      const preview = await call("look", { op: "preview" });
      assert.ok(preview.content.some(block => block.type === "image"));
      await call("sprite_manage", { op: "save_as", path: path.join(directory, "sprite.aseprite") });
      const resources = await client.listResources();
      assert.ok(resources.resources.some(item => item.uri === "skill://studio"));
      const workflow = await client.readResource({ uri: "skill://studio" });
      assert.match(workflow.contents[0].text, /Procedure/);
    } else {
      // Select exact current schemas with --describe when updating Froxel.
      await call("new_document", {});
      await call("fill_box", { x0: 3, y0: 3, z0: 3, x1: 12, y1: 12, z1: 12, palette: 1 });
      await call("save_file", { path: path.join(directory, "voxel.vox") });
      await call("export_mesh", { path: path.join(directory, "voxel.glb") });
      await call("render", { path: path.join(directory, "voxel.png"), width: 128, height: 128, samples: 8 });
    }
    console.log(`${name}: PASS (${inventory.length} tools)`);
  } catch (error) { throw new Error(`${name}: ${error.message}\n${diagnostics}`, { cause: error }); }
  finally { await client.close(); }
}
console.log(`Fixtures: ${directory}`);
