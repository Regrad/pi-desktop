// User's Trellis2 image-to-texture API workflow; geometry is encoded from the existing mesh.
export const TEXTURE_GRAPH: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
  "1": {
    "class_type": "LoadImage",
    "inputs": {
      "image": "viking_wolf_rune_axe.png"
    }
  },
  "2": {
    "class_type": "CLIPVisionLoader",
    "inputs": {
      "clip_name": "dino_v3_L_naf_fp32.safetensors"
    }
  },
  "3": {
    "class_type": "Trellis2Conditioning",
    "inputs": {
      "clip_vision_model": [
        "2",
        0
      ],
      "image": [
        "1",
        0
      ]
    }
  },
  "4": {
    "class_type": "VAELoader",
    "inputs": {
      "vae_name": "trellis_2_shape_vae_bf16.safetensors"
    }
  },
  "5": {
    "class_type": "Trellis2MeshEncoder",
    "inputs": {
      "vae": [
        "4",
        0
      ],
      "mesh_filename": "C:\\AI\\ComfyUI\\ComfyUI\\output\\3d\\ComfyUI_00001.glb",
      "shape_encoder": "shape_enc_next_dc_f16c32_fp16.safetensors",
      "resolution": 512
    }
  },
  "6": {
    "class_type": "UNETLoader",
    "inputs": {
      "unet_name": "trellis_2_int8_convrot.safetensors",
      "weight_dtype": "default"
    }
  },
  "7": {
    "class_type": "Trellis2TextureStage",
    "inputs": {
      "positive": [
        "3",
        0
      ],
      "negative": [
        "3",
        1
      ],
      "shape_latent": [
        "5",
        0
      ]
    }
  },
  "8": {
    "class_type": "KSampler",
    "inputs": {
      "model": [
        "6",
        0
      ],
      "positive": [
        "7",
        0
      ],
      "negative": [
        "7",
        1
      ],
      "latent_image": [
        "7",
        2
      ],
      "seed": 43,
      "steps": 12,
      "cfg": 1,
      "sampler_name": "euler",
      "scheduler": "normal",
      "denoise": 1
    }
  },
  "9": {
    "class_type": "VAELoader",
    "inputs": {
      "vae_name": "trellis_2_texture_vae_bf16.safetensors"
    }
  },
  "10": {
    "class_type": "VaeDecodeTextureTrellis",
    "inputs": {
      "samples": [
        "8",
        0
      ],
      "vae": [
        "9",
        0
      ],
      "shape_subdivides": [
        "5",
        1
      ]
    }
  },
  "11": {
    "class_type": "UnwrapMesh",
    "inputs": {
      "mesh": [
        "5",
        2
      ],
      "segmenter": "pec",
      "resolution": 2048,
      "padding": 4,
      "weld_distance": 0
    }
  },
  "12": {
    "class_type": "BakeTextureFromVoxel",
    "inputs": {
      "mesh": [
        "11",
        0
      ],
      "voxel_colors": [
        "10",
        0
      ],
      "texture_size": 2048
    }
  },
  "13": {
    "class_type": "ApplyTextureToMesh",
    "inputs": {
      "mesh": [
        "11",
        0
      ],
      "base_color": [
        "12",
        0
      ],
      "metallic": [
        "12",
        1
      ],
      "roughness": [
        "12",
        2
      ]
    }
  },
  "14": {
    "class_type": "MeshToFile3D",
    "inputs": {
      "mesh": [
        "13",
        0
      ]
    }
  },
  "15": {
    "class_type": "Save3DAdvanced",
    "inputs": {
      "model_3d": [
        "14",
        0
      ],
      "filename_prefix": "3d/retextured",
      "viewport_state": {},
      "width": 1024,
      "height": 1024
    }
  }
};
