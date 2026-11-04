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
test("removed Idol tool is not shipped or recommended", async () => {
  assert.equal(existsSync(new URL("../resources/pi-comfyui/tools/comfyui_generate_idol_3d/index.ts", import.meta.url)), false);
  const source = await readFile(new URL("../resources/pi-comfyui/tools/comfyui_generate_3d/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Idol|comfyui_generate_idol_3d/);
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
