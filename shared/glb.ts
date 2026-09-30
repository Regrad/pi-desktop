// GLBs displayed in the chat must be self-contained: never fetch external textures/buffers.
export function validateLocalGlb(bytes: Uint8Array): void {
  if (bytes.byteLength < 20 || bytes.byteLength > 256 * 1024 * 1024) throw new Error("Некорректный размер GLB");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength)
    throw new Error("Некорректный GLB 2.0");
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || length % 4 || length > bytes.byteLength - 20) throw new Error("Некорректный JSON-блок GLB");
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
  if (json.asset?.version !== "2.0") throw new Error("Нужна модель glTF 2.0");
  for (const entry of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (entry.uri !== undefined && (typeof entry.uri !== "string" || !entry.uri.startsWith("data:")))
      throw new Error("GLB должен содержать текстуры и данные внутри файла, без внешних ссылок");
  }
}
