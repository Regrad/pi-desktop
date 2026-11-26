---
name: blender-modeling
description: Create, edit, render or export a 3D mesh, character, prop, scene or animation in Blender when the user requests an art asset. Do not use for ordinary programming, discussing 3D APIs or editing engine code.
---

# Blender modeling

Use this workflow only for the requested art task in this chat. Do not connect
other editors or add these instructions to a project's general rules.

1. Discover the MCP gateway through codemode, then call `mcp({server:"blender"})`.
   Read its instructions and the `execute_blender_code` schema. If the editor is
   missing, follow the reported setup path; do not assume a developer's local path.
2. Inspect supplied references, existing assets and the target engine's needs.
   Keep the requested style, including deliberate low-poly facets. Ask for a
   reference approval when the user requests one before modeling.
3. Choose one absolute `.blend` path inside the project. Reuse it for every
   call. The server loads it, executes bpy code and saves on success, in a
   background Blender isolated from the user's open windows. A new file starts
   with an empty scene. Print data when inspecting geometry or materials.
4. Block out the whole silhouette and proportions before small details. Use
   materials, topology and polygon density appropriate to the actual brief.
   Do not impose subdivision, photorealistic PBR or a fixed render resolution.
5. Render previews to absolute PNG paths through bpy and pass `previewPath`
   to return the image. Inspect the whole asset from front, side and rear
   against the reference. Check faces, limbs, clothing, seams and texture
   bleeding. Tool success is not evidence of visual quality.
6. Save the editable `.blend`, export the requested format using bpy, and
   check the exported geometry, scale, materials and animation. For GLB,
   `bpy.ops.export_scene.gltf(filepath=..., export_format='GLB')`.
7. Show the result and list actual output paths and remaining issues.

Each call defaults to a five-minute limit; `timeoutSeconds` can be raised for
a justified render. A cancelled call does not resume in the middle of its code.
