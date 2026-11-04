import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ToolContext } from "../../lib/context.js";
import { modelSource, uploadModelImage } from "../../lib/model3d-tools.js";
import { runApiWorkflow } from "../../lib/workflow.js";
import { resolveHistoryImage } from "../../shared/image-attachments.js";

import { textureGraph } from "./workflow.js";
export { textureGraph } from "./workflow.js";

export default function register(pi: ExtensionAPI, { dataDir }: ToolContext) {
  pi.registerTool({
    name: "comfyui_texture_3d", label: "UltraTex: текстурирование 3D-модели",
    description: "Texture an existing mesh from a reference image locally with UltraTex FLUX.2 Klein PBR. Returns a GLB with albedo, metallic and roughness. Defaults preserve existing UVs; choose comfy_gpu or xatlas for new UVs. Geometry generation and simplification are separate operations. source is an existing mesh path accessible to ComfyUI; image accepts paths or attachment: references. Requires installed UltraTex nodes and weights. The chat displays the GLB interactively.",
    parameters: Type.Object({
      source: Type.String(), image: Type.String(),
      seed: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
      steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })), cfg: Type.Optional(Type.Number({ minimum: 0, maximum: 30 })),
      texture_resolution: Type.Optional(Type.Integer({ minimum: 512, maximum: 8192, multipleOf: 512 })),
      albedo_resolution: Type.Optional(Type.Integer({ minimum: 256, maximum: 4096, multipleOf: 16 })),
      mr_resolution: Type.Optional(Type.Integer({ minimum: 256, maximum: 4096, multipleOf: 16 })),
      render_size: Type.Optional(Type.Integer({ minimum: 512, maximum: 4096, multipleOf: 512 })),
      uv_mode: Type.Optional(Type.Union(["keep_existing", "comfy_gpu", "xatlas"].map(value => Type.Literal(value)))),
      reference_alignment: Type.Optional(Type.Union(["fit_front_silhouette", "center"].map(value => Type.Literal(value)))),
      memory_factor: Type.Optional(Type.Number({ minimum: 0, maximum: 200 })),
      attention: Type.Optional(Type.Union(["ultratex_sparse", "comfy_default"].map(value => Type.Literal(value)))),
      sparse_topk: Type.Optional(Type.Number({ minimum: 0.05, maximum: 1 })),
      token_chunk: Type.Optional(Type.Integer({ minimum: 0, maximum: 131072, multipleOf: 1024 })),
      drop_background_tokens: Type.Optional(Type.Boolean()),
      view_weight_power: Type.Optional(Type.Number({ minimum: 0, maximum: 16 })),
      best_view_mix: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      edge_feather_px: Type.Optional(Type.Number({ minimum: 0, maximum: 64 })),
    }),
    async execute(_id, params, signal, update, ctx) {
      const source = await modelSource(params.source);
      const image = await uploadModelImage(dataDir, params.image, signal, reference => resolveHistoryImage(ctx.sessionManager.getBranch(), reference));
      const result = await runApiWorkflow(dataDir, textureGraph(source, image, params), { kind: "model", outputNodes: ["pi_tex_bake"] }, signal,
        text => update?.({ content: [{ type: "text", text }], details: {} }));
      return { content: [{ type: "text", text: `Textured model saved:\n${result.files.map(file => file.path).join("\n")}\nJob: ${result.promptId}. Interactive preview is available.` }],
        details: { promptId: result.promptId, files: result.files.map(file => file.path), media: result.files.map(file => ({ type: "model3d", path: file.path, mimeType: file.mimeType })) } };
    },
  });
}
