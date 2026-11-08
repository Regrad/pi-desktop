import { open } from "node:fs/promises";

// Read only the GLB JSON chunk; embedded texture data stays on disk.
export async function modelSummary(file: string) {
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(20);
    if ((await handle.read(header, 0, 20, 0)).bytesRead !== 20 || header.toString("ascii", 0, 4) !== "glTF" || header.readUInt32LE(16) !== 0x4e4f534a)
      throw new Error("Invalid GLB header");
    const length = header.readUInt32LE(12);
    if (length > 8 * 1024 * 1024 || length > header.readUInt32LE(8) - 20) throw new Error("Invalid GLB JSON size");
    const bytes = Buffer.alloc(length);
    if ((await handle.read(bytes, 0, length, 20)).bytesRead !== length) throw new Error("Incomplete GLB JSON");
    const gltf = JSON.parse(bytes.toString("utf8"));
    let triangles = 0, vertices = 0;
    const materials = new Set<number>();
    for (const mesh of gltf.meshes ?? []) for (const p of mesh.primitives ?? []) {
      const count = gltf.accessors?.[p.indices ?? p.attributes?.POSITION]?.count ?? 0;
      const mode = p.mode ?? 4;
      if (mode === 4) triangles += count / 3;
      else if (mode === 5 || mode === 6) triangles += Math.max(0, count - 2);
      vertices += gltf.accessors?.[p.attributes?.POSITION]?.count ?? 0;
      if (p.material !== undefined) materials.add(p.material);
    }
    const used = [...materials].map(id => gltf.materials?.[id]).filter(Boolean);
    return {
      triangles, vertices, meshes: gltf.meshes?.length ?? 0,
      normalMaps: used.filter(m => m.normalTexture).length,
      baseColorMaps: used.filter(m => m.pbrMetallicRoughness?.baseColorTexture).length,
      metallicRoughnessMaps: used.filter(m => m.pbrMetallicRoughness?.metallicRoughnessTexture).length,
      verification: "GLB structure only; geometry topology and visual quality are not verified by this report",
    };
  } finally { await handle.close(); }
}
