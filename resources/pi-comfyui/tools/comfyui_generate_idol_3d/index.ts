import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ToolContext } from "../../lib/context.js";
import { modelJobPrefix, uploadModelImage } from "../../lib/model3d-tools.js";
import { runApiWorkflow } from "../../lib/workflow.js";
import { resolveHistoryImage } from "../../shared/image-attachments.js";

// Verified Idol -> Gaussian splats -> SplatToMesh -> optional decimation -> GLB.
const template = {
  "2": {
    "class_type": "LoadImage",
    "inputs": {
      "image": "fennec-figure.png"
    }
  },
  "3": {
    "class_type": "LoadBackgroundRemovalModel",
    "inputs": {
      "bg_removal_name": "birefnet.safetensors"
    }
  },
  "4": {
    "class_type": "RemoveBackground",
    "inputs": {
      "bg_removal_model": [
        "3",
        0
      ],
      "image": [
        "2",
        0
      ]
    }
  },
  "5": {
    "class_type": "IdolPreprocessImage",
    "inputs": {
      "image": [
        "2",
        0
      ],
      "mask": [
        "4",
        0
      ],
      "mode": "synthetic"
    }
  },
  "7": {
    "class_type": "CLIPVisionLoader",
    "inputs": {
      "clip_name": "dino_v3_vit_h.safetensors"
    }
  },
  "8": {
    "class_type": "VAELoader",
    "inputs": {
      "vae_name": "flux2-vae.safetensors"
    }
  },
  "9": {
    "class_type": "TripoSplatConditioning",
    "inputs": {
      "clip_vision": [
        "7",
        0
      ],
      "vae": [
        "8",
        0
      ],
      "image": [
        "5",
        0
      ]
    }
  },
  "10": {
    "class_type": "UNETLoader",
    "inputs": {
      "unet_name": "idol_fp32.safetensors",
      "weight_dtype": "default"
    }
  },
  "11": {
    "class_type": "IdolPrecision",
    "inputs": {
      "model": [
        "10",
        0
      ],
      "precision": "default"
    }
  },
  "12": {
    "class_type": "KSampler",
    "inputs": {
      "model": [
        "11",
        0
      ],
      "positive": [
        "9",
        0
      ],
      "negative": [
        "9",
        1
      ],
      "latent_image": [
        "9",
        2
      ],
      "seed": 42,
      "steps": 50,
      "cfg": 4,
      "sampler_name": "euler",
      "scheduler": "simple",
      "denoise": 1
    }
  },
  "13": {
    "class_type": "VAELoader",
    "inputs": {
      "vae_name": "idol_vae_decoder_fp32.safetensors"
    }
  },
  "14": {
    "class_type": "VAEDecodeTripoSplat",
    "inputs": {
      "samples": [
        "12",
        0
      ],
      "vae": [
        "13",
        0
      ],
      "num_gaussians": 262144,
      "seed": 42
    }
  },
  "23": {
    "class_type": "SplatToMesh",
    "inputs": {
      "splat": [
        "14",
        0
      ],
      "resolution": 384,
      "kernel": 5,
      "smooth": 0,
      "level": 0.4,
      "min_component": 500,
      "min_opacity": 0.02,
      "color_sharpen": 2
    }
  },
  "24": {
    "class_type": "DecimateMesh",
    "inputs": {
      "mesh": [
        "23",
        0
      ],
      "target_face_count": 20000,
      "placement_mode": "midpoint"
    }
  },
  "25": {
    "class_type": "SaveGLB",
    "inputs": {
      "mesh": [
        "24",
        0
      ],
      "filename_prefix": "3d/idol_mesh"
    }
  }
};

export function idolGraph(image: string, options: { seed?: number; target_face_count?: number; resolution?: number; steps?: number; cfg?: number } = {}) {
  const graph = structuredClone(template);
  graph["2"].inputs.image = image;
  const seed = options.seed ?? Math.floor(Math.random() * 2 ** 48);
  graph["12"].inputs.seed = seed;
  graph["14"].inputs.seed = seed;
  graph["12"].inputs.steps = options.steps ?? 50;
  graph["12"].inputs.cfg = options.cfg ?? 4;
  graph["23"].inputs.resolution = options.resolution ?? 384;
  graph["24"].inputs.target_face_count = options.target_face_count ?? 0;
  graph["25"].inputs.filename_prefix = `${modelJobPrefix()}/idol`;
  return graph;
}

export default function register(pi: ExtensionAPI, { dataDir }: ToolContext) {
  pi.registerTool({
    name: "comfyui_generate_idol_3d", label: "Idol: изображение в 3D-модель",
    description: "Generate a polygon GLB from one reference image locally with Idol. The pipeline generates Gaussian splats, extracts a colored mesh, then optionally reduces triangles. target_face_count=0 (default) skips decimation; a positive value requests an approximate maximum, not native generation at that triangle count. The output uses vertex colors, not a UV texture atlas. The chat displays the model interactively. Requires the installed Idol, SplatToMesh and SaveGLB nodes and model files.",
    parameters: Type.Object({
      image: Type.String({ description: "Original image path or attachment: reference from comfyui_list_attachments." }),
      seed: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
      target_face_count: Type.Optional(Type.Integer({ minimum: 0, maximum: 50000000 })),
      resolution: Type.Optional(Type.Integer({ minimum: 64, maximum: 1024 })),
      steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      cfg: Type.Optional(Type.Number({ minimum: 0, maximum: 30 })),
    }),
    async execute(_id, params, signal, update, ctx) {
      const image = await uploadModelImage(dataDir, params.image, signal, reference => resolveHistoryImage(ctx.sessionManager.getBranch(), reference));
      const result = await runApiWorkflow(dataDir, idolGraph(image, params), { kind: "model", outputNodes: ["25"] }, signal,
        text => update?.({ content: [{ type: "text", text }], details: {} }));
      return { content: [{ type: "text", text: `Idol model saved:\n${result.files.map(file => file.path).join("\n")}\nJob: ${result.promptId}. Interactive model preview is available.` }],
        details: { promptId: result.promptId, files: result.files.map(file => file.path),
          media: result.files.map(file => ({ type: "model3d", path: file.path, mimeType: file.mimeType })) } };
    },
  });
}
