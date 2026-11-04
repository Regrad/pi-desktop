import { Type } from "typebox";
export function createToolContext(dataDir: string) {
  const reportText = (reports: Record<string, string>) => Object.entries(reports).map(([name, value]) => `${name}: ${value.length > 12_000 ? `${value.slice(0, 12_000)}… (full report in generation record)` : value}`).join("\n");
  const generationStatus = (reached: boolean | null) => reached === true ? "needs review: the ending may be truncated" : reached === false ? "completed" : "finished: truncation status unknown";
  const vocalMode = Type.Union([
    Type.Literal("instrumental_lead", { description: "Move the Vocal melody into Ins, keeping non-overlapping instrumental accompaniment and fills." }),
    Type.Literal("accompaniment_only", { description: "Replace Vocal notes with rests; keep only the existing Ins accompaniment. This may sound sparse when the accompaniment is sparse." }),
  ], { description: "Removes the symbolic Vocal score before NEW audio generation. It does not separate vocals from an existing recording." });
  const musicOptions = Type.Object({
    vram: Type.Optional(Type.Union([Type.Literal("12 GB"), Type.Literal("16 GB"), Type.Literal("24 GB"), Type.Literal("32 GB"), Type.Literal("48 GB")])),
    language: Type.Optional(Type.String()), genre: Type.Optional(Type.String()), secondary_genres: Type.Optional(Type.String()),
    era: Type.Optional(Type.String()), vocal: Type.Optional(Type.String()), instruments: Type.Optional(Type.String()),
    drums: Type.Optional(Type.String()), mood: Type.Optional(Type.String()), tempo: Type.Optional(Type.String()),
    structure: Type.Optional(Type.String()), verse_lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
    section_plan: Type.Optional(Type.String()),
    tempo_mode: Type.Optional(Type.Union([Type.Literal("keep"), Type.Literal("override"), Type.Literal("multiplier")])),
    bpm: Type.Optional(Type.Number({ minimum: 20, maximum: 400 })), tempo_multiplier: Type.Optional(Type.Number({ minimum: 0.25, maximum: 4 })),
    transpose_scope: Type.Optional(Type.Union([Type.Literal("whole_score"), Type.Literal("vocal_only"), Type.Literal("instrumental_only"), Type.Literal("none")])),
    semitones: Type.Optional(Type.Integer({ minimum: -36, maximum: 36 })), remove_chords: Type.Optional(Type.Boolean()),
    drop_sections: Type.Optional(Type.String()), vocal_transpose: Type.Optional(Type.Integer({ minimum: -36, maximum: 36 })),
    instrumental_transpose: Type.Optional(Type.Integer({ minimum: -36, maximum: 36 })), octave_shift: Type.Optional(Type.Integer({ minimum: -3, maximum: 3 })),
    target_voice: Type.Optional(Type.Union([Type.Literal("original"), Type.Literal("female_contralto"), Type.Literal("female_alto"), Type.Literal("female_mezzo"), Type.Literal("female_soprano"), Type.Literal("male_bass"), Type.Literal("male_baritone"), Type.Literal("male_tenor")], { description: "Pitch range of the vocal melody, not voice timbre or singer identity; describe those in prompt/vocal." })),
    vocal_range_mode: Type.Optional(Type.Union([Type.Literal("nearest_key_safe"), Type.Literal("nearest_octave"), Type.Literal("manual")])),
    manual_semitones: Type.Optional(Type.Integer({ minimum: -36, maximum: 36 })),
    cleanup_preset: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("light"), Type.Literal("medium"), Type.Literal("custom")])),
    remove_notes_shorter_than_ms: Type.Optional(Type.Number({ minimum: 0, maximum: 500 })),
    remove_pitch_outliers: Type.Optional(Type.Boolean()), outlier_semitones: Type.Optional(Type.Integer({ minimum: 6, maximum: 48 })),
    adapter: Type.Optional(Type.String({ description: "Installed YuE2 LoRA/LoKr filename from media_status. 'none' applies no adapter." })), ar_strength: Type.Optional(Type.Number({ minimum: 0, maximum: 3 })),
    nar_strength: Type.Optional(Type.Number({ minimum: 0, maximum: 3 })), adapter_enabled: Type.Optional(Type.Boolean()),
    headroom_percent: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })), tail_seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 60 })),
    abc_max_tokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 20000 })),
    abc_temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 5 })), abc_top_p: Type.Optional(Type.Number({ minimum: 0.01, maximum: 1 })),
    abc_top_k: Type.Optional(Type.Integer({ minimum: 1, maximum: 32768 })), abc_repetition_penalty: Type.Optional(Type.Number({ minimum: 0.01, maximum: 10 })),
    abc_penalty_window: Type.Optional(Type.Integer({ minimum: 1, maximum: 20000 })),
    music_temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 5 })), music_top_p: Type.Optional(Type.Number({ minimum: 0.01, maximum: 1 })),
    music_top_k: Type.Optional(Type.Integer({ minimum: 1, maximum: 32768 })), music_repetition_penalty: Type.Optional(Type.Number({ minimum: 0.01, maximum: 10 })),
    analysis_language: Type.Optional(Type.Union([Type.Literal("English"), Type.Literal("generic")])),
  });
  return { dataDir, reportText, generationStatus, vocalMode, musicOptions };
}
export type ToolContext = ReturnType<typeof createToolContext>;
