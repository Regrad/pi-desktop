// API conversion of PixelArtistry Animated Characters (MIT). See PIXELARTISTRY.md.
type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
export const CHARACTER_GRAPH: Graph = {
  "3": {
    "class_type": "KSampler",
    "inputs": {
      "model": [
        "108",
        0
      ],
      "seed": "{{seed}}",
      "steps": 12,
      "cfg": 7.5,
      "sampler_name": "euler",
      "scheduler": "normal",
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
      "seed": "{{seed}}",
      "steps": 20,
      "cfg": 7.5,
      "sampler_name": "euler",
      "scheduler": "normal",
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
      "seed": "{{seed}}",
      "steps": 12,
      "cfg": 7.5,
      "sampler_name": "euler",
      "scheduler": "simple",
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
      "switch": true,
      "on_false": [
        "122",
        1
      ],
      "on_true": [
        "192",
        0
      ]
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
      "switch": [
        "316",
        0
      ],
      "on_false": [
        "298",
        0
      ],
      "on_true": [
        "299",
        0
      ]
    }
  },
  "315": {
    "class_type": "ComfySwitchNode",
    "inputs": {
      "switch": [
        "316",
        0
      ],
      "on_false": [
        "298",
        1
      ],
      "on_true": [
        "299",
        1
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
      "switch": [
        "316",
        0
      ],
      "on_false": [
        "319",
        0
      ],
      "on_true": [
        "40",
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
  "324": {
    "class_type": "PrimitiveString",
    "inputs": {
      "value": "blender"
    }
  },
  "325": {
    "class_type": "MeshReconstructWithQuad",
    "inputs": {
      "mesh": [
        "92",
        0
      ],
      "remesh_band": 1,
      "resolution": 1536,
      "remove_floaters": true,
      "remove_inner_faces": true
    }
  },
  "326": {
    "class_type": "MemoryCleaner",
    "inputs": {
      "input_1": [
        "325",
        0
      ],
      "enabled": true,
      "always_run": true,
      "clean_vram": true,
      "clean_ram": true
    }
  },
  "327": {
    "class_type": "WTiVoNativeMeshToMesh",
    "inputs": {
      "mesh": [
        "326",
        0
      ],
      "input_res": 1536,
      "final_res": 1536,
      "proxy_points": 12000000,
      "proxy_eps_scale": 1,
      "proxy_feature_weight": 1.5,
      "lambda_fill": 20,
      "threads": 16,
      "thin_iso_vox": 0,
      "faithc_component_mode": "largest"
    }
  },
  "328": {
    "class_type": "LODTailorTheMeshTrimmer",
    "inputs": {
      "mesh": [
        "327",
        0
      ],
      "blender_path": [
        "324",
        0
      ],
      "target_tris": 6000000,
      "passes": 100,
      "tolerance": 1.05,
      "intermediate_ratio": 0.5,
      "last_ratio": 0.25,
      "final_ratio": 0.2,
      "triangulate": true,
      "symmetry": false,
      "voxel_rebuild": true,
      "relative_voxel_size": 0.001,
      "minimum_voxel_size": 0.000001,
      "seal_distance": 0.0001,
      "seal_max_steps": 100,
      "seal_keep_trying": true,
      "timeout_seconds": 1800
    }
  },
  "333": {
    "class_type": "MeshToFile3D",
    "inputs": {
      "mesh": [
        "328",
        0
      ]
    }
  },
  "335": {
    "class_type": "LODTailorTheMeshTrimmer",
    "inputs": {
      "mesh": [
        "328",
        0
      ],
      "blender_path": [
        "324",
        0
      ],
      "target_tris": 12000,
      "passes": 3,
      "tolerance": 1.05,
      "intermediate_ratio": 0.5,
      "last_ratio": 0.25,
      "final_ratio": 0.2,
      "triangulate": true,
      "symmetry": false,
      "voxel_rebuild": true,
      "relative_voxel_size": 0.0015,
      "minimum_voxel_size": 0.000001,
      "seal_distance": 0.0001,
      "seal_max_steps": 100,
      "seal_keep_trying": true,
      "timeout_seconds": 1800
    }
  },
  "337": {
    "class_type": "UnwrapMesh",
    "inputs": {
      "mesh": [
        "335",
        0
      ],
      "segmenter": "pec",
      "resolution": 1536,
      "padding": 2,
      "weld_distance": 0.0002
    }
  },
  "338": {
    "class_type": "MeshSmoothNormals",
    "inputs": {
      "mesh": [
        "337",
        0
      ],
      "crease_angle": 180
    }
  },
  "339": {
    "class_type": "MeshToFile3D",
    "inputs": {
      "mesh": [
        "338",
        0
      ]
    }
  },
  "340": {
    "class_type": "MemoryCleaner",
    "inputs": {
      "input_1": [
        "339",
        0
      ],
      "input_2": [
        "333",
        0
      ],
      "enabled": true,
      "always_run": true,
      "clean_vram": true,
      "clean_ram": true
    }
  },
  "341": {
    "class_type": "LODTailorBakeForger",
    "inputs": {
      "high_poly": [
        "340",
        1
      ],
      "low_poly": [
        "340",
        0
      ],
      "blender_path": [
        "324",
        0
      ],
      "prefer_gpu_baking": true,
      "hybrid_cpu_gpu_baking": true,
      "bake_sample_count": 1,
      "bake_normal_detail": true,
      "normal_map_resolution": 2048,
      "copy_base_color_texture": false,
      "base_color_resolution": 2048,
      "bake_roughness_texture": false,
      "roughness_resolution": 2048,
      "bake_metallic_texture": false,
      "metallic_resolution": 2048,
      "bake_emission_texture": false,
      "emission_resolution": 2048,
      "bake_ao_texture": false,
      "ao_resolution": 2048,
      "brighter": false,
      "auto_bake_margin": true,
      "bake_margin_pixels": 16,
      "bake_margin_minimum_pixels": 16,
      "bake_margin_resolution_divisor": 256,
      "fallback_bake_mode": "AUTO",
      "coverage_probe_sample_count": 4096,
      "extended_ray_sample_ratio": 0.005,
      "fallback_minimum_recoverable_samples": 8,
      "tight_cage_extrusion_factor": 0.0019,
      "tight_max_ray_distance_factor": 0.029,
      "far_cage_extrusion_factor": 0.02,
      "far_max_ray_distance_factor": 0.092,
      "coverage_alpha_threshold": 0.5,
      "normal_length_tolerance": 0.35,
      "neutral_normal_color": "0.5,0.5,1.0,1.0",
      "material_base_color": "0.8,0.8,0.8,1.0",
      "material_roughness": 0.9,
      "material_metallic": 0,
      "material_specular_level": 0.5,
      "load_output_images": true
    }
  },
  "342": {
    "class_type": "WTiVoFastMergeByDistance",
    "inputs": {
      "model": [
        "341",
        0
      ],
      "merge_distance": 0.0001,
      "centroid_merge": false,
      "remove_degenerate": true,
      "topology_mode": "TEXTURE_SAFE",
      "adaptive_retry_step": true,
      "max_attempts": 100
    }
  },
  "353": {
    "class_type": "UTXFileToMesh",
    "inputs": {
      "file": [
        "383",
        0
      ]
    }
  },
  "354": {
    "class_type": "UnetLoaderGGUF",
    "inputs": {
      "unet_name": "flux-2-klein-base-9b-Q4_0.gguf"
    }
  },
  "355": {
    "class_type": "VAELoader",
    "inputs": {
      "vae_name": "flux2-vae.safetensors"
    }
  },
  "356": {
    "class_type": "CLIPLoaderGGUF",
    "inputs": {
      "clip_name": "Qwen3-8B-Q4_K_M.gguf",
      "type": "flux2"
    }
  },
  "357": {
    "class_type": "UTXTextEncode",
    "inputs": {
      "clip": [
        "356",
        0
      ],
      "text": ""
    }
  },
  "358": {
    "class_type": "UTXGenerateTextureViewsV23",
    "inputs": {
      "source": [
        "375",
        0
      ],
      "model": [
        "354",
        0
      ],
      "vae": [
        "355",
        0
      ],
      "positive": [
        "357",
        0
      ],
      "lora_name": "ultratex_flux2.safetensors",
      "lora_strength": 1,
      "decoder_name": "ultratex_flux2_decoder.pt",
      "task": "albedo",
      "view_resolution": 1024,
      "view_count": 12,
      "seed": "{{seed}}",
      "steps": 4,
      "guidance": 4,
      "denoise": 1,
      "sparse_retention": 0.2,
      "extra_angle_mode": "guided",
      "extra_denoise": 0.55,
      "extra_steps": 4,
      "tiled_decode": true,
      "negative": [
        "376",
        0
      ]
    }
  },
  "364": {
    "class_type": "UTXGenerateTextureViewsV23",
    "inputs": {
      "source": [
        "375",
        0
      ],
      "model": [
        "354",
        0
      ],
      "vae": [
        "355",
        0
      ],
      "positive": [
        "357",
        0
      ],
      "lora_name": "ultratex_flux2_mr.safetensors",
      "lora_strength": 1,
      "decoder_name": "ultratex_flux2_decoder.pt",
      "task": "mr",
      "view_resolution": 1024,
      "view_count": 6,
      "seed": "{{seed}}",
      "steps": 4,
      "guidance": 4,
      "denoise": 1,
      "sparse_retention": 0.2,
      "extra_angle_mode": "independent",
      "extra_denoise": 0.55,
      "extra_steps": 4,
      "tiled_decode": true,
      "negative": [
        "376",
        0
      ]
    }
  },
  "368": {
    "class_type": "LoadBackgroundRemovalModel",
    "inputs": {
      "bg_removal_name": "birefnet.safetensors"
    }
  },
  "369": {
    "class_type": "RemoveBackground",
    "inputs": {
      "bg_removal_model": [
        "368",
        0
      ],
      "image": [
        "122",
        0
      ]
    }
  },
  "374": {
    "class_type": "UTXUnwrapMeshUVV25",
    "inputs": {
      "mesh": [
        "353",
        0
      ],
      "atlas_size": 2048,
      "uv_mode": "keep_existing",
      "padding": 16
    }
  },
  "375": {
    "class_type": "UTXPrepareTextureV25",
    "inputs": {
      "mesh": [
        "374",
        0
      ],
      "reference": [
        "122",
        0
      ],
      "alignment": "front",
      "mask_polarity": "foreground",
      "normal_mode": "auto_smooth",
      "normal_view_resolution": 1024,
      "camera_fit": "native_mesh_fit",
      "image_margin_percent": 0,
      "image_padding_pixels": 0,
      "reference_zoom": 1,
      "mask": [
        "369",
        0
      ],
      "runtime": [
        "387",
        0
      ]
    }
  },
  "376": {
    "class_type": "UTXTextEncode",
    "inputs": {
      "clip": [
        "356",
        0
      ],
      "text": ""
    }
  },
  "377": {
    "class_type": "UTXFastSurfaceTextureBaker",
    "inputs": {
      "albedo_setup": [
        "358",
        3
      ],
      "albedo_views": [
        "358",
        0
      ],
      "texture_size": 2048,
      "completion": "surface_fill",
      "upscale_mode": "sharp_anchor_v2",
      "device": "auto",
      "mr_setup": [
        "364",
        3
      ],
      "mr_views": [
        "364",
        0
      ]
    }
  },
  "383": {
    "class_type": "MemoryCleaner",
    "inputs": {
      "input_1": [
        "342",
        0
      ],
      "enabled": true,
      "always_run": true,
      "clean_vram": true,
      "clean_ram": true
    }
  },
  "384": {
    "class_type": "UTXApplyMaterials",
    "inputs": {
      "mesh": [
        "353",
        0
      ],
      "normal_convention": "OpenGL",
      "alpha_mode": "inherit",
      "alpha_cutoff": 0.5,
      "uv_convention": "v_down",
      "base_color": [
        "377",
        2
      ],
      "roughness": [
        "377",
        3
      ],
      "metallic": [
        "377",
        4
      ]
    }
  },
  "385": {
    "class_type": "UTXCreate3DFile",
    "inputs": {
      "mesh": [
        "384",
        0
      ]
    }
  },
  "386": {
    "class_type": "Save3DAdvanced",
    "inputs": {
      "model_3d": [
        "388",
        0
      ],
      "filename_prefix": "3d/PixelArtistry_char_final",
      "viewport_state": {},
      "width": 1024,
      "height": 1024
    }
  },
  "387": {
    "class_type": "UTXConfigureRuntime",
    "inputs": {
      "spill_directory": "",
      "ram_cache_mb": 256,
      "disk_budget_gb": 16,
      "system_headroom_mb": 2048,
      "gpu_headroom_mb": 768,
      "token_chunk": 4096,
      "activation_factor": 12,
      "atlas_tile": 512,
      "decode_tile": 64,
      "performance_mode": "adaptive",
      "max_vram_mb": 0,
      "adaptive_diagnostics": false
    }
  },
  "388": {
    "class_type": "UTXCacheCleaner",
    "inputs": {
      "mode": "delete_when_executed",
      "confirm_delete_on_run": true,
      "passthrough": [
        "385",
        0
      ]
    }
  }
};
export const MULTIVIEW_SHAPE: Graph = {
  "mv_3": {
    "class_type": "KSampler",
    "inputs": {
      "model": [
        "mv_108",
        0
      ],
      "positive": [
        "mv_324",
        0
      ],
      "negative": [
        "mv_324",
        1
      ],
      "latent_image": [
        "mv_87",
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
  "mv_15": {
    "class_type": "CLIPVisionLoader",
    "inputs": {
      "clip_name": "dino_v3_L_naf_fp32.safetensors"
    }
  },
  "mv_18": {
    "class_type": "KSampler",
    "inputs": {
      "model": [
        "mv_126",
        0
      ],
      "positive": [
        "mv_91",
        0
      ],
      "negative": [
        "mv_91",
        1
      ],
      "latent_image": [
        "mv_91",
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
  "mv_23": {
    "class_type": "KSampler",
    "inputs": {
      "model": [
        "mv_126",
        0
      ],
      "positive": [
        "mv_94",
        0
      ],
      "negative": [
        "mv_94",
        1
      ],
      "latent_image": [
        "mv_94",
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
  "mv_87": {
    "class_type": "EmptyTrellis2LatentStructure",
    "inputs": {
      "batch_size": 1
    }
  },
  "mv_91": {
    "class_type": "Trellis2ShapeStage",
    "inputs": {
      "positive": [
        "mv_324",
        0
      ],
      "negative": [
        "mv_324",
        1
      ],
      "voxel": [
        "mv_119",
        0
      ]
    }
  },
  "mv_92": {
    "class_type": "VaeDecodeShapeTrellis",
    "inputs": {
      "samples": [
        "mv_23",
        0
      ],
      "vae": [
        "mv_117",
        0
      ]
    }
  },
  "mv_94": {
    "class_type": "Trellis2UpsampleStage",
    "inputs": {
      "positive": [
        "mv_91",
        0
      ],
      "negative": [
        "mv_91",
        1
      ],
      "shape_latent": [
        "mv_18",
        0
      ],
      "vae": [
        "mv_117",
        0
      ],
      "target_resolution": 1536
    }
  },
  "mv_108": {
    "class_type": "ModelSamplingSD3",
    "inputs": {
      "model": [
        "mv_125",
        0
      ],
      "shift": 5
    }
  },
  "mv_117": {
    "class_type": "VAELoader",
    "inputs": {
      "vae_name": "trellis_2_shape_vae_bf16.safetensors"
    }
  },
  "mv_119": {
    "class_type": "VaeDecodeStructureTrellis2",
    "inputs": {
      "samples": [
        "mv_3",
        0
      ],
      "vae": [
        "mv_117",
        0
      ],
      "resolution": "32"
    }
  },
  "mv_125": {
    "class_type": "RescaleCFG",
    "inputs": {
      "model": [
        "mv_199",
        0
      ],
      "multiplier": 0.7
    }
  },
  "mv_126": {
    "class_type": "RescaleCFG",
    "inputs": {
      "model": [
        "mv_279",
        0
      ],
      "multiplier": 0.5
    }
  },
  "mv_192": {
    "class_type": "RemoveBackground",
    "inputs": {
      "bg_removal_model": [
        "mv_193",
        0
      ],
      "image": [
        "mv_338",
        0
      ]
    }
  },
  "mv_193": {
    "class_type": "LoadBackgroundRemovalModel",
    "inputs": {
      "bg_removal_name": "birefnet.safetensors"
    }
  },
  "mv_199": {
    "class_type": "CFGOverride",
    "inputs": {
      "model": [
        "mv_319",
        0
      ],
      "cfg": 1,
      "start_percent": 0.667,
      "end_percent": 1
    }
  },
  "mv_279": {
    "class_type": "CFGOverride",
    "inputs": {
      "model": [
        "mv_319",
        0
      ],
      "cfg": 1,
      "start_percent": 0.769,
      "end_percent": 1
    }
  },
  "mv_312": {
    "class_type": "ImageCropToMask",
    "inputs": {
      "images": [
        "mv_338",
        0
      ],
      "masks": [
        "mv_192",
        0
      ],
      "width": 1024,
      "height": 1024,
      "pad_factor": 1.1,
      "grow_mask": 0,
      "background": "#000000"
    }
  },
  "mv_319": {
    "class_type": "UNETLoader",
    "inputs": {
      "unet_name": "pixal3d_multiview_int8_convrot.safetensors",
      "weight_dtype": "default"
    }
  },
  "mv_324": {
    "class_type": "Pixal3DMultiViewConditioning",
    "inputs": {
      "clip_vision_model": [
        "mv_15",
        0
      ],
      "front": [
        "mv_312",
        0
      ],
      "left": [
        "mv_349",
        0
      ],
      "back": [
        "mv_350",
        0
      ],
      "right": [
        "mv_352",
        0
      ],
      "fov": 20
    }
  },
  "mv_338": {
    "class_type": "LoadImage",
    "inputs": {
      "image": "{{image_1}}"
    }
  },
  "mv_341": {
    "class_type": "LoadImage",
    "inputs": {
      "image": "{{image_2}}"
    }
  },
  "mv_342": {
    "class_type": "LoadImage",
    "inputs": {
      "image": "{{image_3}}"
    }
  },
  "mv_345": {
    "class_type": "LoadImage",
    "inputs": {
      "image": "{{image_4}}"
    }
  },
  "mv_348": {
    "class_type": "RemoveBackground",
    "inputs": {
      "bg_removal_model": [
        "mv_193",
        0
      ],
      "image": [
        "mv_341",
        0
      ]
    }
  },
  "mv_349": {
    "class_type": "ImageCropToMask",
    "inputs": {
      "images": [
        "mv_341",
        0
      ],
      "masks": [
        "mv_348",
        0
      ],
      "width": 1024,
      "height": 1024,
      "pad_factor": 1.1,
      "grow_mask": 0,
      "background": "#000000"
    }
  },
  "mv_350": {
    "class_type": "ImageCropToMask",
    "inputs": {
      "images": [
        "mv_342",
        0
      ],
      "masks": [
        "mv_351",
        0
      ],
      "width": 1024,
      "height": 1024,
      "pad_factor": 1.1,
      "grow_mask": 0,
      "background": "#000000"
    }
  },
  "mv_351": {
    "class_type": "RemoveBackground",
    "inputs": {
      "bg_removal_model": [
        "mv_193",
        0
      ],
      "image": [
        "mv_342",
        0
      ]
    }
  },
  "mv_352": {
    "class_type": "ImageCropToMask",
    "inputs": {
      "images": [
        "mv_345",
        0
      ],
      "masks": [
        "mv_353",
        0
      ],
      "width": 1024,
      "height": 1024,
      "pad_factor": 1.1,
      "grow_mask": 0,
      "background": "#000000"
    }
  },
  "mv_353": {
    "class_type": "RemoveBackground",
    "inputs": {
      "bg_removal_model": [
        "mv_193",
        0
      ],
      "image": [
        "mv_345",
        0
      ]
    }
  }
};
