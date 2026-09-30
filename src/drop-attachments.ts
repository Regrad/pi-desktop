import type { Attachment } from "../shared/types.js";

export function mergeAttachments(current: Attachment[], incoming: Attachment[]): Attachment[] {
  const merged = [...current];
  for (const item of incoming) {
    const duplicate = merged.some((existing) => item.path.startsWith("clipboard:")
      ? existing.path.startsWith("clipboard:") && existing.data === item.data
      : existing.path.toLowerCase() === item.path.toLowerCase());
    if (!duplicate) merged.push(item);
  }
  return merged;
}
