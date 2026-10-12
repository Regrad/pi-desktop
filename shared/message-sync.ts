export interface MessagePatch {
  startIndex: number;
  messages: unknown[];
}

/** Apply an authoritative suffix, preserving array identity on a no-op. */
export function applyMessagePatch<T>(current: T[], patch: MessagePatch): T[] {
  if (!Number.isInteger(patch.startIndex) || (patch.startIndex !== 0 && patch.startIndex !== current.length) || !Array.isArray(patch.messages))
    throw new Error("Invalid message synchronization prefix");
  if (patch.startIndex === current.length && patch.messages.length === 0) return current;
  return [...current.slice(0, patch.startIndex), ...patch.messages as T[]];
}
