export const workflow = {
  "10": {
    "class_type": "SaveAudioAdvanced",
    "inputs": {
      "audio": [
        "1009",
        0
      ],
      "filename_prefix": "audio/YuE2_расширенная_генерация",
      "format": "flac"
    }
  },
  "41": {
    "class_type": "YuE2MemoryPreset",
    "inputs": {
      "vram": "16 GB"
    }
  },
  "51": {
    "class_type": "PrimitiveInt",
    "inputs": {
      "value": 0
    }
  },
  "1005": {
    "class_type": "EmptyYuE2LatentAudio",
    "inputs": {
      "seconds": [
        "1025",
        3
      ],
      "batch_size": 1
    }
  },
  "1008": {
    "class_type": "KSampler",
    "inputs": {
      "model": [
        "1025",
        0
      ],
      "positive": [
        "1025",
        2
      ],
      "negative": [
        "1018",
        0
      ],
      "latent_image": [
        "1005",
        0
      ],
      "seed": [
        "51",
        0
      ],
      "steps": 32,
      "cfg": 1,
      "sampler_name": "dpm_2",
      "scheduler": "sgm_uniform",
      "denoise": 1
    }
  },
  "1009": {
    "class_type": "VAEDecodeAudio",
    "inputs": {
      "samples": [
        "1008",
        0
      ],
      "vae": [
        "1025",
        1
      ]
    }
  },
  "1015": {
    "class_type": "YuE2NativePipelineLoader",
    "inputs": {
      "checkpoint": "yue2_3b_bf16.safetensors",
      "audio_encoder": "none",
      "memory_budget_gib": [
        "41",
        0
      ],
      "offload_ar": [
        "41",
        1
      ]
    }
  },
  "1018": {
    "class_type": "ConditioningZeroOut",
    "inputs": {
      "conditioning": [
        "1025",
        2
      ]
    }
  },
  "1024": {
    "class_type": "YuE2NativeGenerateABC",
    "inputs": {
      "pipe": [
        "1049",
        0
      ],
      "style": [
        "1036",
        0
      ],
      "lyrics": [
        "1037",
        0
      ],
      "seed": [
        "51",
        0
      ],
      "mode": "full",
      "max_abc_tokens": 8192,
      "temperature": 0.7,
      "top_p": 0.9,
      "top_k": 30,
      "repetition_penalty": 1.005,
      "penalty_window": 100
    }
  },
  "1025": {
    "class_type": "YuE2NativeGenerateMusic",
    "inputs": {
      "pipe": [
        "1049",
        0
      ],
      "style": [
        "1036",
        0
      ],
      "lyrics": [
        "1037",
        0
      ],
      "abc": [
        "1042",
        0
      ],
      "seed": [
        "51",
        0
      ],
      "mode": "full",
      "max_duration": [
        "1054",
        1
      ],
      "temperature": 1,
      "top_p": 0.95,
      "top_k": 100,
      "repetition_penalty": 1.2
    }
  },
  "1036": {
    "class_type": "YuE2StyleBuilder",
    "inputs": {
      "language": "",
      "genre": "",
      "secondary_genres": "",
      "era": "",
      "vocal": "",
      "instruments": "",
      "drums": "",
      "mood": "",
      "tempo": "",
      "extra": "Upbeat indie pop with warm female vocals, bright electric guitars, punchy drums, melodic bass, and subtle synth layers. Catchy and energetic, with an uplifting summer atmosphere, a memorable chorus, and polished modern production."
    }
  },
  "1037": {
    "class_type": "YuE2LyricsStructurer",
    "inputs": {
      "lyrics_text": "[Verse]\nMorning light across the window\nCity waking down below\nI can hear the streets are calling\nFeels like somewhere we should go\n\n[Chorus]\nRun with me into the sunlight\nLeave the shadows far behind\nWe don't need to know tomorrow\nTonight the whole world feels alive\n\n[Verse]\nRadio playing through the open door\nLaughing like we did before\nEvery mile becomes a memory\nAnd I just want a little more\n\n[Chorus]\nRun with me into the sunlight\nLeave the shadows far behind\nWe don't need to know tomorrow\nTonight the whole world feels alive",
      "structure": "",
      "verse_lines": 4,
      "section_plan": "verse:2,chorus:1,bridge:1"
    }
  },
  "1038": {
    "class_type": "YuE2ABCModifier",
    "inputs": {
      "abc": [
        "1024",
        0
      ],
      "tempo_mode": "keep",
      "bpm": 120,
      "tempo_multiplier": 1,
      "transpose_scope": "whole_score",
      "semitones": 0,
      "remove_chords": false,
      "drop_sections": "",
      "vocal_transpose": 0,
      "instrumental_transpose": 0,
      "octave_shift": 0
    }
  },
  "1039": {
    "class_type": "YuE2VocalRangeRetarget",
    "inputs": {
      "abc": [
        "1038",
        0
      ],
      "target_voice": "original",
      "mode": "nearest_key_safe",
      "manual_semitones": 0
    }
  },
  "1042": {
    "class_type": "YuE2MelodyCleanup",
    "inputs": {
      "abc": [
        "1039",
        0
      ],
      "preset": "off",
      "remove_notes_shorter_than_ms": 40,
      "remove_pitch_outliers": true,
      "outlier_semitones": 24
    }
  },
  "1049": {
    "class_type": "YuE2NativeUniversalAdapterLoader",
    "inputs": {
      "pipeline": [
        "1015",
        0
      ],
      "adapter": "none",
      "ar_strength": 1,
      "nar_strength": 1,
      "enabled": true
    }
  },
  "1054": {
    "class_type": "YuE2ABCDurationBudget",
    "inputs": {
      "abc": [
        "1042",
        0
      ],
      "headroom_percent": 10,
      "tail_seconds": 2
    }
  }
};
