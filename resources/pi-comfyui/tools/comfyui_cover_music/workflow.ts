export const workflow = {
  "10": {
    "class_type": "SaveAudioAdvanced",
    "inputs": {
      "audio": [
        "1009",
        0
      ],
      "filename_prefix": "audio/YuE2_расширенный_кавер",
      "format": "flac"
    }
  },
  "45": {
    "class_type": "LoadAudio",
    "inputs": {
      "audio": "YuE2_пример_кавер.flac"
    }
  },
  "47": {
    "class_type": "YuE2MemoryPreset",
    "inputs": {
      "vram": "16 GB"
    }
  },
  "67": {
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
        "67",
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
      "audio_encoder": "sheetsage2_bf16.safetensors",
      "memory_budget_gib": [
        "47",
        0
      ],
      "offload_ar": [
        "47",
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
  "1025": {
    "class_type": "YuE2NativeGenerateMusic",
    "inputs": {
      "pipe": [
        "1059",
        0
      ],
      "style": [
        "1051",
        0
      ],
      "lyrics": [
        "1052",
        0
      ],
      "abc": [
        "1050",
        0
      ],
      "seed": [
        "67",
        0
      ],
      "mode": "melody",
      "max_duration": [
        "1060",
        1
      ],
      "temperature": 1,
      "top_p": 0.95,
      "top_k": 100,
      "repetition_penalty": 1.2
    }
  },
  "1041": {
    "class_type": "YuE2NativeAudioToABC",
    "inputs": {
      "pipe": [
        "1059",
        0
      ],
      "audio": [
        "45",
        0
      ],
      "mode": "melody"
    }
  },
  "1044": {
    "class_type": "PreviewAny",
    "inputs": {
      "source": [
        "1041",
        0
      ]
    }
  },
  "1048": {
    "class_type": "YuE2ABCModifier",
    "inputs": {
      "abc": [
        "1044",
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
  "1049": {
    "class_type": "YuE2VocalRangeRetarget",
    "inputs": {
      "abc": [
        "1048",
        0
      ],
      "target_voice": "original",
      "mode": "nearest_key_safe",
      "manual_semitones": 0
    }
  },
  "1050": {
    "class_type": "YuE2MelodyCleanup",
    "inputs": {
      "abc": [
        "1049",
        0
      ],
      "preset": "off",
      "remove_notes_shorter_than_ms": 40,
      "remove_pitch_outliers": true,
      "outlier_semitones": 24
    }
  },
  "1051": {
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
      "extra": "English, soulful jazz-pop, expressive male vocal, relaxed 88 BPM, Rhodes piano, upright bass, brushed drums, warm saxophone, subtle strings, intimate late-night atmosphere, rich and organic live-band production"
    }
  },
  "1052": {
    "class_type": "YuE2LyricsStructurer",
    "inputs": {
      "lyrics_text": "[Verse]\nStreetlights shimmer on the pavement\nMidnight breathing soft and slow\nEvery corner holds a memory\nOf the places we used to know\n\n[Chorus]\nStay with me until the morning\nLet the city fade away\nWe don't need to chase tomorrow\nAll I need is here today\n\n[Verse]\nOld café beneath the neon\nRain is falling on the glass\nEvery song becomes a story\nEvery moment moves too fast\n\n[Chorus]\nStay with me until the morning\nLet the city fade away\nWe don't need to chase tomorrow\nAll I need is here today\n\n[Bridge]\nMaybe time will keep on turning\nMaybe everything will change\nBut tonight the music holds us\nLike a fire inside the rain\n\n[Chorus]\nStay with me until the morning\nLet the city fade away\nWe don't need to chase tomorrow\nAll I need is here today",
      "structure": "",
      "verse_lines": 4,
      "section_plan": "verse:2,chorus:1,bridge:1"
    }
  },
  "1059": {
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
  "1060": {
    "class_type": "YuE2ABCDurationBudget",
    "inputs": {
      "abc": [
        "1050",
        0
      ],
      "headroom_percent": 10,
      "tail_seconds": 2
    }
  }
};
