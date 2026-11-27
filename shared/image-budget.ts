/**
 * Requests carry the whole conversation, so every image stays in the payload
 * until the endpoint rejects the accumulated bytes. Only the request is
 * trimmed: the session, saved files and attachment references stay intact.
 */

export const imageBudgetEnv = "PI_DESKTOP_IMAGE_BUDGET_MB";
export const defaultImageBudgetBytes = 4 * 1024 * 1024;
/** Leave room for the next results before evicting from the cached prefix again. */
export const imageBudgetHysteresis = 0.7;

type ContentBlock = { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
type RequestMessage = { role?: unknown; content?: unknown; toolName?: unknown };

const megabyte = 1024 * 1024;

export function imageBudgetBytes(env: Record<string, string | undefined> = {}): number {
  const raw = env[imageBudgetEnv];
  if (raw === undefined || !raw.trim()) return defaultImageBudgetBytes;
  const megabytes = Number(raw);
  return Number.isFinite(megabytes) && megabytes > 0 ? Math.round(megabytes * megabyte) : 0;
}

/** Base64 grows by a third; the endpoint counts what it has to decode. */
export function decodedImageBytes(data: string): number {
  return Math.floor(data.length * 3 / 4);
}

function contentBlocks(content: unknown): ContentBlock[] | undefined {
  return Array.isArray(content) ? content as ContentBlock[] : undefined;
}

function isImage(block: ContentBlock): block is { type: "image"; data: string; mimeType: string } {
  return block?.type === "image" && typeof block.data === "string";
}

function messageText(message: RequestMessage): string {
  return (contentBlocks(message?.content) ?? [])
    .filter(block => block?.type === "text" && typeof block.text === "string")
    .map(block => block.text as string)
    .join("\n");
}

/** Image tools report absolute output paths, so a trimmed image stays reachable. */
function storedFiles(text: string): string[] {
  const paths = new Set<string>();
  const pathPattern = /^(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/))[^"|<>?\u0000-\u001F]+\.(?:png|jpe?g|webp|gif|bmp|tiff)$/i;
  const add = (value: string) => {
    const candidate = value.trim();
    if (pathPattern.test(candidate)) paths.add(candidate);
  };
  for (const line of text.split(/\r?\n/)) {
    add(line.replace(/^\s*(?:(?:files?|path|output)\s*:\s*|[-*]\s+)/i, "").trim().replace(/^[`'"]|[`'"]$/g, ""));
    // Structured tool results quote paths and escape backslashes.
    for (const match of line.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
      try { add(JSON.parse(match[0])); } catch { /* Not a JSON string. */ }
    }
  }
  return [...paths].slice(0, 3);
}

/** The endpoint rejects the payload before the model sees it; other 400s stay untouched. */
export function imageBudgetRejected(error?: string): boolean {
  return Boolean(error && /image[^\n]{0,24}budget|budget[^\n]{0,24}image/i.test(error));
}

export function requestImageBytes(messages: readonly unknown[]): number {
  let total = 0;
  for (const entry of messages)
    for (const block of contentBlocks((entry as RequestMessage)?.content) ?? [])
      if (isImage(block)) total += decodedImageBytes(block.data);
  return total;
}

export type ImageBudgetResult<T> = {
  messages: T[];
  removed: number;
  bytesBefore: number;
  bytesAfter: number;
  targetBytes: number;
};

/**
 * Keeps the newest images and everything the user attached in the latest
 * message, replacing older ones with a short note that carries the saved path.
 */
export function pruneRequestImages<T>(messages: readonly T[], budgetBytes: number): ImageBudgetResult<T> {
  const source = messages.slice() as T[];
  const bytesBefore = requestImageBytes(source);
  const unchanged = (removed: number, bytesAfter = bytesBefore): ImageBudgetResult<T> =>
    ({ messages: source, removed, bytesBefore, bytesAfter, targetBytes: budgetBytes });
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0 || bytesBefore <= budgetBytes) return unchanged(0);

  const target = Math.max(1, Math.floor(budgetBytes * imageBudgetHysteresis));
  let lastUserIndex = -1;
  type ImageLocation = { message: number; block: number; bytes: number };
  const byMessage = new Map<number, Map<number, number>>();
  let kept: ImageLocation[] = [];
  let bytesAfter = 0;
  let removed = 0;
  source.forEach((entry, messageIndex) => {
    const message = entry as RequestMessage;
    const isUser = message?.role === "user";
    if (isUser) lastUserIndex = messageIndex;
    const previousBytes = bytesAfter;
    contentBlocks(message?.content)?.forEach((block, blockIndex) => {
      if (!isImage(block)) return;
      const bytes = decodedImageBytes(block.data);
      bytesAfter += bytes;
      kept.push({ message: messageIndex, block: blockIndex, bytes });
    });
    if (bytesAfter <= budgetBytes || (!isUser && bytesAfter === previousBytes)) return;

    // Replay evictions in chronological order. A later request cannot revive
    // an old image or keep evicting until new bytes cross the limit again.
    const newest = kept.at(-1);
    kept = kept.filter(image => {
      if (bytesAfter <= target || image === newest || image.message === lastUserIndex) return true;
      bytesAfter -= image.bytes;
      removed++;
      const targets = byMessage.get(image.message) ?? new Map<number, number>();
      targets.set(image.block, image.bytes);
      byMessage.set(image.message, targets);
      return false;
    });
  });
  if (!removed) return unchanged(0);
  const result = source.map((entry, index) => {
    const targets = byMessage.get(index);
    if (!targets) return entry;
    const message = entry as RequestMessage;
    const blocks = contentBlocks(message.content) ?? [];
    const paths = storedFiles(messageText(message));
    const tool = typeof message.toolName === "string" ? ` produced by ${message.toolName}` : "";
    const content = blocks.map((block, blockIndex) => {
      const bytes = targets.get(blockIndex);
      if (bytes === undefined) return block;
      const size = (bytes / megabyte).toFixed(1);
      const reference = paths.length ? ` Stored file(s): ${paths.join(", ")}.` : "";
      return {
        type: "text",
        text: `[image ${blockIndex + 1} omitted from this request: ${block.mimeType}, ${size} MB${tool}. The endpoint image byte budget is exceeded, but the original file is unchanged.${reference} Open it with read(path), or list chat images with media_list_attachments.]`,
      };
    });
    return { ...message, content } as T;
  });
  return { messages: result, removed, bytesBefore, bytesAfter, targetBytes: budgetBytes };
}
