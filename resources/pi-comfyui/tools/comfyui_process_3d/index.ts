import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ToolContext } from "../../lib/context.js";
import { modelGuidelines, processingProperties, processingInputs } from "../../lib/model3d-options.js";
import { modelSource, modelJobPrefix, runModelTool } from "../../lib/model3d-tools.js";

export default function register(pi: ExtensionAPI, { dataDir }: ToolContext) {
  pi.registerTool({
    name: "comfyui_process_3d", label: "Исправить и оптимизировать 3D-модель",
    description: "Process an EXISTING mesh with local ComfyUI ModelTools: WTiVo hole repair, Instant Meshes quad retopology, polygon reduction, and source-to-target texture transfer with normal/AO baking. source is the high-quality appearance source; optional target is an existing low-poly mesh to receive textures. Without target, operate on source. All processing operations are off unless explicitly requested. Enable simplify and set target_triangles only when polygon reduction was requested; enable texture transfer/baking when appearance must survive geometry changes. Quad OBJ, final GLB, textures and topology/warning reports are saved separately. Original files are unchanged. Inputs must be accessible on the ComfyUI computer.",
    promptSnippet: "Repair holes, retopologize, simplify or transfer textures on existing 3D models; inspect returned reports.",
    promptGuidelines: modelGuidelines,
    parameters: Type.Object({ source: Type.String(), target: Type.Optional(Type.String()), ...processingProperties }),
    async execute(_id, params, signal, update) {
      const { source, target, ...options } = params;
      const prefix = modelJobPrefix();
      const inputs = { ...processingInputs(options), source_path: await modelSource(source), target_path: target ? await modelSource(target) : "", output_prefix: prefix };
      return runModelTool(dataDir, { process: { class_type: "UniversalModelTools", inputs } }, prefix, ["process"], signal, text => update?.({ content: [{ type: "text", text }], details: {} }));
    },
  });
}
