# Image-to-3D generation

The `media_generate_3d` tool uses PixelArtistry's Animated Characters pipeline:
Pixal3D/Trellis2 shape → Quad Reconstruct → WTiVo → LODTailor high/low meshes →
Bake Forger high-to-low normal map → UltraTex PBR maps → self-contained GLB.

Source: https://github.com/pixelartistry/PixelArtistry-Animated-Characters
Workflow: `PixelArtistry_05_Image_to_LowPoly_Character_UltraTex.json`.
Its MIT license is included in `PIXELARTISTRY-LICENSE`.
`pixelartistry-graphs.ts` is a mechanical API conversion with a separate,
namespaced Pixal3D multiview shape branch. Both input modes share the new
processing/baking pipeline. Four views also guide UltraTex texturing.
The four-view mesh is rotated 180 degrees around Y before texturing to align
its front with UltraTex's +Z camera; normals, tangents and the baked UVs are
retained by the stock Rotate Mesh operation.

Defaults: 12,000 target triangles, 2K maps, 1536 shape/WTiVo resolution,
12 million proxy points, 4 texture steps, 12 albedo / 6 material views.
The face count is a reduction target, not native generation at that count.
`target_face_count=0` skips the final low-poly reduction; the preparation stage
still limits its high-poly reference to 6 million triangles. `watertight=false`
skips Quad/WTiVo and disables voxel rebuilding. Normal baking preserves a shared
UV layout; GLB reports describe structure, not proof of good topology or rigging.

## Required ComfyUI installation

- Python 3.12, torch 2.8 + CUDA 12 for WTiVo's compiled extension.
- ComfyUI 0.39.2 or compatible newer Flux block/attention interfaces. The old
  0.37.0 layout cannot run UltraTex's bounded token chunking.
- Blender (the executable is configurable through `postprocess.blender_path`).
- Quad Reconstruct, WTiVo, Memory Cleaner, LODTailor, Bake Forger, Fast Merge.
- ComfyUI-GGUF: `4dfc025`.
- UltraTex Modular: `8b3715605fa5f08d4de7f858d3ba8c16f94e7b0c`.
  The author's old `4dea3ff` pin does not accept the workflow's `sharp_anchor_v2`.
  The new node uses `Quality`, accepts 8K atlases and side/back references.
  This integration removes the retired `completion` input and supplies the
  retired refinement inputs as disabled; no ComfyUI core patch is needed.
- GGUF models: `flux-2-klein-base-9b-Q4_0.gguf` in `diffusion_models` and
  `Qwen3-8B-Q4_K_M.gguf` in `text_encoders`, from the author's linked Unsloth
  repositories. Existing Flux VAE, UltraTex LoRAs/decoder and BiRefNet are reused.
- Existing native Pixal3D/Trellis2 weights; four-view mode additionally requires
  `pixal3d_multiview_int8_convrot.safetensors`.

UltraTex cache cleanup runs after the final result. Generated models belong to
the requesting chat through Pi Desktop's normal media publication path.
The separate existing-mesh texturing tool is outside this replacement.

FLUX.2 Klein base 9B is under BFL's non-commercial model license; check
https://bfl.ai/licensing before commercial use of the model.
