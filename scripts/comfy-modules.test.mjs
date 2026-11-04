import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const source = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(source))) return next(source.href, context);
  }
  return next(specifier, context);
} });
const { idolGraph } = await import("../resources/pi-comfyui/tools/comfyui_generate_idol_3d/index.ts");

test("Idol has its own explicit workflow and preserves zero/decimation semantics", () => {
  const normal = idolGraph("upload.png", { seed: 0 });
  assert.equal(normal[2].inputs.image, "upload.png");
  assert.equal(normal[12].inputs.seed, 0);
  assert.equal(normal[14].inputs.seed, 0);
  assert.equal(normal[24].inputs.target_face_count, 0);
  const low = idolGraph("other.png", { target_face_count: 20000, resolution: 256, steps: 30, cfg: 2 });
  assert.equal(low[24].inputs.target_face_count, 20000);
  assert.equal(low[23].inputs.resolution, 256);
  assert.equal(low[12].inputs.steps, 30);
  assert.equal(low[12].inputs.cfg, 2);
  assert.notEqual(low[25].inputs.filename_prefix, normal[25].inputs.filename_prefix);
  assert.equal(normal[2].inputs.image, "upload.png", "Calls do not change the saved template");
});

test("preparation and universal workflow execution are absent from settings and the host", async () => {
  for (const file of ["src/ComfySettings.tsx", "electron/main.ts", "electron/preload.cts", "shared/types.ts", "electron/web-backend.ts", "electron/remote-runtime.ts", "electron/pi-manager.ts"]) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /ComfyLibraryPreparation|startComfyPreparation|getComfyPreparation|cancelComfyPreparation|listComfyWorkflows|inspectComfyWorkflow|comfy_compile|Подготовить.*карточки/, file);
  }
  for (const file of ["electron/comfy-library.ts", "electron/comfy-workflow-compiler.ts", "resources/pi-comfyui/lib/workflow-library.ts",
    "resources/pi-comfyui/lib/workflow-catalog.ts", "resources/pi-comfyui/lib/workflow-jobs.ts", "resources/pi-comfyui/tools/comfyui_run_workflow/index.ts", "resources/pi-comfyui/tools/comfyui_workflows/index.ts", "resources/pi-comfyui/tools/comfyui_job/index.ts"]) {
    assert.equal(existsSync(new URL(`../${file}`, import.meta.url)), false, file);
  }
});
