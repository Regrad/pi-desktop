// Converted from the user's local Pixal3D/Trellis2 workflows. Preserve their sampling and mesh settings.
export const MODEL_GRAPHS: Record<"model3d" | "model3d_multiview", Record<string, { class_type: string; inputs: Record<string, unknown> }>> = {
  "model3d": {
    "3": {
      "class_type": "KSampler",
      "inputs": {
        "model": [
          "108",
          0
        ],
        "positive": [
          "314",
          0
        ],
        "negative": [
          "315",
          0
        ],
        "latent_image": [
          "87",
          0
        ],
        "seed": "{{seed}}",
        "steps": 12,
        "cfg": 7.5,
        "sampler_name": "euler",
        "scheduler": "normal",
        "denoise": 1
      }
    },
    "12": {
      "class_type": "KSampler",
      "inputs": {
        "model": [
          "318",
          0
        ],
        "positive": [
          "98",
          0
        ],
        "negative": [
          "98",
          1
        ],
        "latent_image": [
          "98",
          2
        ],
        "seed": "{{seed}}",
        "steps": 12,
        "cfg": 1,
        "sampler_name": "euler",
        "scheduler": "normal",
        "denoise": 1
      }
    },
    "15": {
      "class_type": "CLIPVisionLoader",
      "inputs": {
        "clip_name": "dino_v3_L_naf_fp32.safetensors"
      }
    },
    "18": {
      "class_type": "KSampler",
      "inputs": {
        "model": [
          "126",
          0
        ],
        "positive": [
          "91",
          0
        ],
        "negative": [
          "91",
          1
        ],
        "latent_image": [
          "91",
          2
        ],
        "seed": "{{seed}}",
        "steps": 20,
        "cfg": 7.5,
        "sampler_name": "euler",
        "scheduler": "normal",
        "denoise": 1
      }
    },
    "23": {
      "class_type": "KSampler",
      "inputs": {
        "model": [
          "126",
          0
        ],
        "positive": [
          "94",
          0
        ],
        "negative": [
          "94",
          1
        ],
        "latent_image": [
          "94",
          2
        ],
        "seed": "{{seed}}",
        "steps": 12,
        "cfg": 7.5,
        "sampler_name": "euler",
        "scheduler": "simple",
        "denoise": 1
      }
    },
    "40": {
      "class_type": "UNETLoader",
      "inputs": {
        "unet_name": "trellis_2_int8_convrot.safetensors",
        "weight_dtype": "default"
      }
    },
    "55": {
      "class_type": "LoadMoGeModel",
      "inputs": {
        "model_name": "moge_2_vitl_normal_fp16.safetensors"
      }
    },
    "56": {
      "class_type": "MoGeInference",
      "inputs": {
        "moge_model": [
          "55",
          0
        ],
        "image": [
          "312",
          0
        ],
        "resolution_level": 9,
        "fov_x_degrees": 0,
        "batch_size": 4,
        "force_projection": true,
        "apply_mask": true,
        "refine_steps": 3
      }
    },
    "87": {
      "class_type": "EmptyTrellis2LatentStructure",
      "inputs": {
        "batch_size": 1
      }
    },
    "91": {
      "class_type": "Trellis2ShapeStage",
      "inputs": {
        "positive": [
          "314",
          0
        ],
        "negative": [
          "315",
          0
        ],
        "voxel": [
          "119",
          0
        ]
      }
    },
    "92": {
      "class_type": "VaeDecodeShapeTrellis",
      "inputs": {
        "samples": [
          "23",
          0
        ],
        "vae": [
          "117",
          0
        ]
      }
    },
    "93": {
      "class_type": "VaeDecodeTextureTrellis",
      "inputs": {
        "samples": [
          "12",
          0
        ],
        "vae": [
          "118",
          0
        ],
        "shape_subdivides": [
          "92",
          1
        ]
      }
    },
    "94": {
      "class_type": "Trellis2UpsampleStage",
      "inputs": {
        "positive": [
          "91",
          0
        ],
        "negative": [
          "91",
          1
        ],
        "shape_latent": [
          "18",
          0
        ],
        "vae": [
          "117",
          0
        ],
        "target_resolution": 1536
      }
    },
    "98": {
      "class_type": "Trellis2TextureStage",
      "inputs": {
        "positive": [
          "94",
          0
        ],
        "negative": [
          "94",
          1
        ],
        "shape_latent": [
          "23",
          0
        ]
      }
    },
    "108": {
      "class_type": "ModelSamplingSD3",
      "inputs": {
        "model": [
          "125",
          0
        ],
        "shift": 5
      }
    },
    "117": {
      "class_type": "VAELoader",
      "inputs": {
        "vae_name": "trellis_2_shape_vae_bf16.safetensors"
      }
    },
    "118": {
      "class_type": "VAELoader",
      "inputs": {
        "vae_name": "trellis_2_texture_vae_bf16.safetensors"
      }
    },
    "119": {
      "class_type": "VaeDecodeStructureTrellis2",
      "inputs": {
        "samples": [
          "3",
          0
        ],
        "vae": [
          "117",
          0
        ],
        "resolution": "32"
      }
    },
    "122": {
      "class_type": "LoadImage",
      "inputs": {
        "image": "{{image_1}}"
      }
    },
    "125": {
      "class_type": "RescaleCFG",
      "inputs": {
        "model": [
          "199",
          0
        ],
        "multiplier": 0.7
      }
    },
    "126": {
      "class_type": "RescaleCFG",
      "inputs": {
        "model": [
          "279",
          0
        ],
        "multiplier": 0.5
      }
    },
    "147": {
      "class_type": "BakeTextureFromVoxel",
      "inputs": {
        "mesh": [
          "196",
          0
        ],
        "voxel_colors": [
          "93",
          0
        ],
        "reference_mesh": [
          "92",
          0
        ],
        "texture_size": [
          "288",
          0
        ]
      }
    },
    "186": {
      "class_type": "DecimateMesh",
      "inputs": {
        "mesh": [
          "pi_watertight",
          0
        ],
        "target_face_count": 700000,
        "placement_mode": "midpoint"
      }
    },
    "192": {
      "class_type": "RemoveBackground",
      "inputs": {
        "bg_removal_model": [
          "193",
          0
        ],
        "image": [
          "122",
          0
        ]
      }
    },
    "193": {
      "class_type": "LoadBackgroundRemovalModel",
      "inputs": {
        "bg_removal_name": "birefnet.safetensors"
      }
    },
    "196": {
      "class_type": "UnwrapMesh",
      "inputs": {
        "mesh": [
          "238",
          0
        ],
        "segmenter": "pec",
        "resolution": [
          "288",
          0
        ],
        "padding": 1,
        "weld_distance": 0.0002
      }
    },
    "199": {
      "class_type": "CFGOverride",
      "inputs": {
        "model": [
          "318",
          0
        ],
        "cfg": 1,
        "start_percent": 0.667,
        "end_percent": 1
      }
    },
    "202": {
      "class_type": "GetMeshInfo",
      "inputs": {
        "mesh": [
          "92",
          0
        ]
      }
    },
    "210": {
      "class_type": "ApplyTextureToMesh",
      "inputs": {
        "mesh": [
          "196",
          0
        ],
        "base_color": [
          "147",
          0
        ],
        "metallic": [
          "147",
          1
        ],
        "roughness": [
          "147",
          2
        ],
        "occlusion": [
          "233",
          0
        ],
        "normal_map": [
          "224",
          0
        ]
      }
    },
    "224": {
      "class_type": "BakeNormalMapFromMesh",
      "inputs": {
        "low_poly": [
          "196",
          0
        ],
        "high_poly": [
          "pi_watertight",
          0
        ],
        "resolution": 2048,
        "cage_distance": 0.05,
        "ignore_backfaces": true
      }
    },
    "233": {
      "class_type": "BakeAmbientOcclusion",
      "inputs": {
        "low_poly": [
          "196",
          0
        ],
        "high_poly": [
          "pi_watertight",
          0
        ],
        "resolution": 1024,
        "samples": 64,
        "max_distance": 0.71,
        "strength": 1,
        "bias": 0.01
      }
    },
    "238": {
      "class_type": "MeshSmoothNormals",
      "inputs": {
        "mesh": [
          "186",
          0
        ],
        "crease_angle": 180
      }
    },
    "242": {
      "class_type": "MoGeGeometryToFOV",
      "inputs": {
        "moge_geometry": [
          "56",
          0
        ],
        "axis": "horizontal",
        "unit": "degrees"
      }
    },
    "248": {
      "class_type": "ComfySwitchNode",
      "inputs": {
        "on_false": [
          "122",
          1
        ],
        "on_true": [
          "192",
          0
        ],
        "switch": true
      }
    },
    "260": {
      "class_type": "MeshSmoothNormals",
      "inputs": {
        "mesh": [
          "210",
          0
        ],
        "crease_angle": 180
      }
    },
    "279": {
      "class_type": "CFGOverride",
      "inputs": {
        "model": [
          "318",
          0
        ],
        "cfg": 1,
        "start_percent": 0.769,
        "end_percent": 1
      }
    },
    "285": {
      "class_type": "MeshToFile3D",
      "inputs": {
        "mesh": [
          "260",
          0
        ]
      }
    },
    "288": {
      "class_type": "PrimitiveInt",
      "inputs": {
        "value": 4096
      }
    },
    "298": {
      "class_type": "Pixal3DConditioning",
      "inputs": {
        "clip_vision_model": [
          "15",
          0
        ],
        "image": [
          "312",
          0
        ],
        "camera_angle_x": [
          "242",
          0
        ]
      }
    },
    "299": {
      "class_type": "Trellis2Conditioning",
      "inputs": {
        "clip_vision_model": [
          "15",
          0
        ],
        "image": [
          "312",
          0
        ]
      }
    },
    "312": {
      "class_type": "ImageCropToMask",
      "inputs": {
        "images": [
          "122",
          0
        ],
        "masks": [
          "248",
          0
        ],
        "width": 1024,
        "height": 1024,
        "pad_factor": 1.1,
        "grow_mask": 0,
        "background": "#000000"
      }
    },
    "314": {
      "class_type": "ComfySwitchNode",
      "inputs": {
        "on_false": [
          "298",
          0
        ],
        "on_true": [
          "299",
          0
        ],
        "switch": [
          "316",
          0
        ]
      }
    },
    "315": {
      "class_type": "ComfySwitchNode",
      "inputs": {
        "on_false": [
          "298",
          1
        ],
        "on_true": [
          "299",
          1
        ],
        "switch": [
          "316",
          0
        ]
      }
    },
    "316": {
      "class_type": "PrimitiveBoolean",
      "inputs": {
        "value": false
      }
    },
    "318": {
      "class_type": "ComfySwitchNode",
      "inputs": {
        "on_false": [
          "319",
          0
        ],
        "on_true": [
          "40",
          0
        ],
        "switch": [
          "316",
          0
        ]
      }
    },
    "319": {
      "class_type": "UNETLoader",
      "inputs": {
        "unet_name": "pixal3d_int8_convrot.safetensors",
        "weight_dtype": "default"
      }
    },
    "322": {
      "class_type": "Save3DAdvanced",
      "inputs": {
        "model_3d": [
          "285",
          0
        ],
        "filename_prefix": "3d/PiDesktop",
        "viewport_state": {},
        "width": 1024,
        "height": 1024
      }
    }
  },
  "model3d_multiview": {
    "3": {
      "class_type": "KSampler",
      "inputs": {
        "model": [
          "108",
          0
        ],
        "positive": [
          "324",
          0
        ],
        "negative": [
          "324",
          1
        ],
        "latent_image": [
          "87",
          0
        ],
        "seed": "{{seed}}",
        "steps": 12,
        "cfg": 7.5,
        "sampler_name": "euler",
        "scheduler": "normal",
        "denoise": 1
      }
    },
    "12": {
      "class_type": "KSampler",
      "inputs": {
        "model": [
          "319",
          0
        ],
        "positive": [
          "98",
          0
        ],
        "negative": [
          "98",
          1
        ],
        "latent_image": [
          "98",
          2
        ],
        "seed": "{{seed}}",
        "steps": 12,
        "cfg": 1,
        "sampler_name": "euler",
        "scheduler": "normal",
        "denoise": 1
      }
    },
    "15": {
      "class_type": "CLIPVisionLoader",
      "inputs": {
        "clip_name": "dino_v3_L_naf_fp32.safetensors"
      }
    },
    "18": {
      "class_type": "KSampler",
      "inputs": {
        "model": [
          "126",
          0
        ],
        "positive": [
          "91",
          0
        ],
        "negative": [
          "91",
          1
        ],
        "latent_image": [
          "91",
          2
        ],
        "seed": "{{seed}}",
        "steps": 20,
        "cfg": 7.5,
        "sampler_name": "euler",
        "scheduler": "normal",
        "denoise": 1
      }
    },
    "23": {
      "class_type": "KSampler",
      "inputs": {
        "model": [
          "126",
          0
        ],
        "positive": [
          "94",
          0
        ],
        "negative": [
          "94",
          1
        ],
        "latent_image": [
          "94",
          2
        ],
        "seed": "{{seed}}",
        "steps": 12,
        "cfg": 7.5,
        "sampler_name": "euler",
        "scheduler": "simple",
        "denoise": 1
      }
    },
    "87": {
      "class_type": "EmptyTrellis2LatentStructure",
      "inputs": {
        "batch_size": 1
      }
    },
    "91": {
      "class_type": "Trellis2ShapeStage",
      "inputs": {
        "positive": [
          "324",
          0
        ],
        "negative": [
          "324",
          1
        ],
        "voxel": [
          "119",
          0
        ]
      }
    },
    "92": {
      "class_type": "VaeDecodeShapeTrellis",
      "inputs": {
        "samples": [
          "23",
          0
        ],
        "vae": [
          "117",
          0
        ]
      }
    },
    "93": {
      "class_type": "VaeDecodeTextureTrellis",
      "inputs": {
        "samples": [
          "12",
          0
        ],
        "vae": [
          "118",
          0
        ],
        "shape_subdivides": [
          "92",
          1
        ]
      }
    },
    "94": {
      "class_type": "Trellis2UpsampleStage",
      "inputs": {
        "positive": [
          "91",
          0
        ],
        "negative": [
          "91",
          1
        ],
        "shape_latent": [
          "18",
          0
        ],
        "vae": [
          "117",
          0
        ],
        "target_resolution": 1536
      }
    },
    "98": {
      "class_type": "Trellis2TextureStage",
      "inputs": {
        "positive": [
          "94",
          0
        ],
        "negative": [
          "94",
          1
        ],
        "shape_latent": [
          "23",
          0
        ]
      }
    },
    "108": {
      "class_type": "ModelSamplingSD3",
      "inputs": {
        "model": [
          "125",
          0
        ],
        "shift": 5
      }
    },
    "117": {
      "class_type": "VAELoader",
      "inputs": {
        "vae_name": "trellis_2_shape_vae_bf16.safetensors"
      }
    },
    "118": {
      "class_type": "VAELoader",
      "inputs": {
        "vae_name": "trellis_2_texture_vae_bf16.safetensors"
      }
    },
    "119": {
      "class_type": "VaeDecodeStructureTrellis2",
      "inputs": {
        "samples": [
          "3",
          0
        ],
        "vae": [
          "117",
          0
        ],
        "resolution": "32"
      }
    },
    "125": {
      "class_type": "RescaleCFG",
      "inputs": {
        "model": [
          "199",
          0
        ],
        "multiplier": 0.7
      }
    },
    "126": {
      "class_type": "RescaleCFG",
      "inputs": {
        "model": [
          "279",
          0
        ],
        "multiplier": 0.5
      }
    },
    "147": {
      "class_type": "BakeTextureFromVoxel",
      "inputs": {
        "mesh": [
          "196",
          0
        ],
        "voxel_colors": [
          "93",
          0
        ],
        "reference_mesh": [
          "92",
          0
        ],
        "texture_size": [
          "288",
          0
        ]
      }
    },
    "186": {
      "class_type": "DecimateMesh",
      "inputs": {
        "mesh": [
          "pi_watertight",
          0
        ],
        "target_face_count": 700000,
        "placement_mode": "midpoint"
      }
    },
    "192": {
      "class_type": "RemoveBackground",
      "inputs": {
        "bg_removal_model": [
          "193",
          0
        ],
        "image": [
          "338",
          0
        ]
      }
    },
    "193": {
      "class_type": "LoadBackgroundRemovalModel",
      "inputs": {
        "bg_removal_name": "birefnet.safetensors"
      }
    },
    "196": {
      "class_type": "UnwrapMesh",
      "inputs": {
        "mesh": [
          "238",
          0
        ],
        "segmenter": "pec",
        "resolution": [
          "288",
          0
        ],
        "padding": 1,
        "weld_distance": 0.0002
      }
    },
    "199": {
      "class_type": "CFGOverride",
      "inputs": {
        "model": [
          "319",
          0
        ],
        "cfg": 1,
        "start_percent": 0.667,
        "end_percent": 1
      }
    },
    "202": {
      "class_type": "GetMeshInfo",
      "inputs": {
        "mesh": [
          "92",
          0
        ]
      }
    },
    "210": {
      "class_type": "ApplyTextureToMesh",
      "inputs": {
        "mesh": [
          "196",
          0
        ],
        "base_color": [
          "147",
          0
        ],
        "metallic": [
          "147",
          1
        ],
        "roughness": [
          "147",
          2
        ],
        "occlusion": [
          "233",
          0
        ],
        "normal_map": [
          "224",
          0
        ]
      }
    },
    "224": {
      "class_type": "BakeNormalMapFromMesh",
      "inputs": {
        "low_poly": [
          "196",
          0
        ],
        "high_poly": [
          "pi_watertight",
          0
        ],
        "resolution": 2048,
        "cage_distance": 0.05,
        "ignore_backfaces": true
      }
    },
    "233": {
      "class_type": "BakeAmbientOcclusion",
      "inputs": {
        "low_poly": [
          "196",
          0
        ],
        "high_poly": [
          "pi_watertight",
          0
        ],
        "resolution": 1024,
        "samples": 64,
        "max_distance": 0.71,
        "strength": 1,
        "bias": 0.01
      }
    },
    "238": {
      "class_type": "MeshSmoothNormals",
      "inputs": {
        "mesh": [
          "186",
          0
        ],
        "crease_angle": 180
      }
    },
    "260": {
      "class_type": "MeshSmoothNormals",
      "inputs": {
        "mesh": [
          "210",
          0
        ],
        "crease_angle": 180
      }
    },
    "279": {
      "class_type": "CFGOverride",
      "inputs": {
        "model": [
          "319",
          0
        ],
        "cfg": 1,
        "start_percent": 0.769,
        "end_percent": 1
      }
    },
    "285": {
      "class_type": "MeshToFile3D",
      "inputs": {
        "mesh": [
          "260",
          0
        ]
      }
    },
    "288": {
      "class_type": "PrimitiveInt",
      "inputs": {
        "value": 4096
      }
    },
    "312": {
      "class_type": "ImageCropToMask",
      "inputs": {
        "images": [
          "338",
          0
        ],
        "masks": [
          "192",
          0
        ],
        "width": 1024,
        "height": 1024,
        "pad_factor": 1.1,
        "grow_mask": 0,
        "background": "#000000"
      }
    },
    "319": {
      "class_type": "UNETLoader",
      "inputs": {
        "unet_name": "pixal3d_multiview_int8_convrot.safetensors",
        "weight_dtype": "default"
      }
    },
    "324": {
      "class_type": "Pixal3DMultiViewConditioning",
      "inputs": {
        "clip_vision_model": [
          "15",
          0
        ],
        "front": [
          "312",
          0
        ],
        "left": [
          "349",
          0
        ],
        "back": [
          "350",
          0
        ],
        "right": [
          "352",
          0
        ],
        "fov": 20
      }
    },
    "338": {
      "class_type": "LoadImage",
      "inputs": {
        "image": "{{image_1}}"
      }
    },
    "341": {
      "class_type": "LoadImage",
      "inputs": {
        "image": "{{image_2}}"
      }
    },
    "342": {
      "class_type": "LoadImage",
      "inputs": {
        "image": "{{image_3}}"
      }
    },
    "345": {
      "class_type": "LoadImage",
      "inputs": {
        "image": "{{image_4}}"
      }
    },
    "348": {
      "class_type": "RemoveBackground",
      "inputs": {
        "bg_removal_model": [
          "193",
          0
        ],
        "image": [
          "341",
          0
        ]
      }
    },
    "349": {
      "class_type": "ImageCropToMask",
      "inputs": {
        "images": [
          "341",
          0
        ],
        "masks": [
          "348",
          0
        ],
        "width": 1024,
        "height": 1024,
        "pad_factor": 1.1,
        "grow_mask": 0,
        "background": "#000000"
      }
    },
    "350": {
      "class_type": "ImageCropToMask",
      "inputs": {
        "images": [
          "342",
          0
        ],
        "masks": [
          "351",
          0
        ],
        "width": 1024,
        "height": 1024,
        "pad_factor": 1.1,
        "grow_mask": 0,
        "background": "#000000"
      }
    },
    "351": {
      "class_type": "RemoveBackground",
      "inputs": {
        "bg_removal_model": [
          "193",
          0
        ],
        "image": [
          "342",
          0
        ]
      }
    },
    "352": {
      "class_type": "ImageCropToMask",
      "inputs": {
        "images": [
          "345",
          0
        ],
        "masks": [
          "353",
          0
        ],
        "width": 1024,
        "height": 1024,
        "pad_factor": 1.1,
        "grow_mask": 0,
        "background": "#000000"
      }
    },
    "353": {
      "class_type": "RemoveBackground",
      "inputs": {
        "bg_removal_model": [
          "193",
          0
        ],
        "image": [
          "345",
          0
        ]
      }
    },
    "372": {
      "class_type": "Save3DAdvanced",
      "inputs": {
        "model_3d": [
          "285",
          0
        ],
        "filename_prefix": "3d/PiDesktop",
        "viewport_state": {},
        "width": 1024,
        "height": 1024
      }
    }
  }
};

// Feed the raw mesh directly to the smart repair stage: one reconstruction at most.
// The standard WTiVo fallback follows the published 1536/16M profile; 2048/25M is opt-in.
for (const mode of ["model3d", "model3d_multiview"] as const) {
  MODEL_GRAPHS[mode].pi_memory_clean = { class_type: "MemoryCleaner", inputs: {
    input_1: ["202", 0], enabled: true, always_run: true, clean_vram: true, clean_ram: true,
  } };
  MODEL_GRAPHS[mode].pi_watertight = { class_type: "SmartWatertightMesh", inputs: {
    mesh: ["pi_memory_clean", 0], input_res: 1536, final_res: 1536, proxy_points: 16000000,
    proxy_eps_scale: 1, proxy_feature_weight: 1.5, lambda_fill: 20, threads: 16,
    thin_iso_vox: 0, faithc_component_mode: "largest",
  } };
}
