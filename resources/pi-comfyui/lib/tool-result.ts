import { Type } from "typebox";

export const imageBlockSchema = Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() });

type ImageBlock = { type: "image"; data: string; mimeType: string };
// Keep human-readable tool history and desktop previews; codemode receives the data itself.
export function toolResult<T extends object, D>(data: T, details: D, images: ImageBlock[] = [], isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }, ...images], details,
    structuredContent: { ...data, ...(images.length ? { images } : {}), ...(isError ? { isError: true } : {}) },
    ...(isError ? { isError: true } : {}),
  };
}
