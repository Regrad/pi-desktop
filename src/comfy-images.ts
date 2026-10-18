type ToolImageResult = { id: string; name: string; result?: unknown; args?: unknown };
const publishingTool = (name: string) => name.startsWith("comfyui_") || name === "desktop_show_image";

// Nested executions have no standalone transcript entry. Their media
// metadata is persisted on the parent result by the native routing extension.
function expandNestedMedia(tools: ToolImageResult[]): ToolImageResult[] {
  return tools.flatMap(tool => {
    const result = tool.result as { details?: { desktopNestedMedia?: unknown } } | undefined;
    const nested = result?.details?.desktopNestedMedia;
    if (!Array.isArray(nested)) return [tool];
    const { desktopNestedMedia: _nested, ...details } = result!.details!;
    const parent = { ...tool, result: { ...(tool.result as object), details } };
    return [parent, ...nested.filter((entry): entry is ToolImageResult =>
      entry && typeof entry.id === "string" && typeof entry.name === "string" && publishingTool(entry.name),
    )];
  });
}

export function collectComfyMedia(tools: ToolImageResult[]): Record<string, unknown>[] {
  tools = expandNestedMedia(tools);
  const seen = new Set<string>();
  return tools.flatMap((tool) => {
    if (!publishingTool(tool.name) || seen.has(tool.id) || !tool.result || typeof tool.result !== "object") return [];
    const result = tool.result as { isError?: boolean; details?: { files?: unknown[]; media?: Record<string, unknown>[]; displayInAnswer?: boolean } };
    if (result.isError || result.details?.displayInAnswer === false) return [];
    const images = collectComfyImages([tool]).map((image, i) => ({ ...image, path: result.details?.files?.[i] }));
    const audio = (Array.isArray(result.details?.media) ? result.details.media : []).filter((part) => part && part.type === "audio" && typeof part.path === "string" && typeof part.mimeType === "string" && part.mimeType.startsWith("audio/"));
    const models = (Array.isArray(result.details?.media) ? result.details.media : []).filter((part) => part && part.type === "model3d" && typeof part.path === "string" && part.mimeType === "model/gltf-binary");
    const others = (Array.isArray(result.details?.media) ? result.details.media : []).filter((part) => part && typeof part.path === "string" && ((part.type === "video" && ["video/mp4", "video/webm"].includes(String(part.mimeType))) || part.type === "file"));
    if (!images.length && !audio.length && !models.length && !others.length) return [];
    seen.add(tool.id);
    return [...images, ...audio, ...models, ...others];
  });
}

// The same tool result can be present in both a call and its persisted result message.
export function collectComfyImages(tools: ToolImageResult[]): Record<string, unknown>[] {
  tools = expandNestedMedia(tools);
  const seen = new Set<string>();
  const images: Record<string, unknown>[] = [];
  for (const tool of tools) {
    if (!publishingTool(tool.name) || seen.has(tool.id)) continue;
    if (!tool.result || typeof tool.result !== "object") continue;
    const result = tool.result as Record<string, unknown>;
    if (result.isError || !Array.isArray(result.content)) continue;
    const parts = result.content.filter((part): part is Record<string, unknown> =>
      part && typeof part === "object" && part.type === "image" &&
      typeof part.data === "string" && part.data.length > 0 &&
      typeof part.mimeType === "string" && part.mimeType.startsWith("image/"),
    );
    if (!parts.length) continue;
    seen.add(tool.id);
    images.push(...parts);
  }
  return images;
}

export function answerCanPublishMedia(state: { streaming: boolean; working: boolean; currentTurn: boolean; stopReason?: unknown }) {
  return !state.streaming && (!state.working || !state.currentTurn) &&
    !["toolUse", "error", "aborted"].includes(String(state.stopReason ?? ""));
}

export function collectAnswerMedia(tools: ToolImageResult[], answerComplete = true, answerText = "") {
  tools = expandNestedMedia(tools);
  // While a turn is in progress, keep media in its original tool, not below the growing answer.
  if (!answerComplete) return { parts: [] as Record<string, unknown>[], toolIds: new Set<string>() };
  const unique = new Map<string, ToolImageResult>();
  for (const tool of tools) if (tool.result !== undefined) unique.set(tool.id, tool);
  const completed = [...unique.values()];
  // Explicit publication is authoritative, including an empty selection.
  // Failed calls never replace the last successful selection.
  const audioSelection = completed.filter(tool => {
    if (tool.name !== "comfyui_publish_music" || !tool.result || typeof tool.result !== "object") return false;
    const result = tool.result as { isError?: boolean; details?: { audioSelection?: boolean } };
    return !result.isError && result.details?.audioSelection === true;
  }).at(-1);
  const candidates = completed.map(tool => ({ tool, media: collectComfyMedia([tool]) })).filter(item => item.media.length);
  // A historical terminal read is eligible only if the final answer actually
  // names that file. Reading a crop or mask for inspection must not publish it.
  const last = completed.at(-1);
  if (last?.name === "read") {
    const media = collectComfyImages([{ ...last, name: "desktop_show_image" }]);
    if (media.length) {
      let args = last.args;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = undefined; } }
      const file = args && typeof args === "object" ? (args as Record<string, unknown>).path : undefined;
      if (typeof file === "string") candidates.push({ tool: last, media: media.map(part => ({ ...part, path: file, originalPath: true })) });
    }
  }

  const normalizedAnswer = answerText.replaceAll("\\", "/").toLowerCase();
  const allParts = candidates.flatMap(item => item.media);
  const filenameCounts = new Map<string, number>();
  for (const part of allParts) {
    if (typeof part.path !== "string") continue;
    const filename = part.path.replaceAll("\\", "/").split("/").pop()!.toLowerCase();
    filenameCounts.set(filename, (filenameCounts.get(filename) ?? 0) + 1);
  }
  const namedInAnswer = (part: Record<string, unknown>) => {
    if (typeof part.path !== "string" || !normalizedAnswer) return false;
    const path = part.path.replaceAll("\\", "/").toLowerCase();
    const filename = path.split("/").pop()!;
    return normalizedAnswer.includes(path) || (filenameCounts.get(filename) === 1 && normalizedAnswer.includes(filename));
  };

  const parts: Record<string, unknown>[] = [];
  const toolIds = new Set<string>();
  for (const type of new Set(allParts.map(part => String(part.type)))) {
    if (type === "audio" && audioSelection) {
      const selected = collectComfyMedia([audioSelection]);
      const seen = new Set<string>();
      for (const part of selected.filter(part => part.type === "audio")) {
        const key = String(part.path).replaceAll("\\", "/").toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        parts.push(part);
      }
      continue;
    }
    const matching = candidates.map(item => ({ ...item, media: item.media.filter(part => part.type === type && namedInAnswer(part)) }))
      .filter(item => item.media.length);
    if (matching.length) {
      for (const item of matching) parts.push(...item.media);
      continue;
    }
    // No explicit choice: one final job per media type. Prefer a completed
    // generation to an inspection snapshot shown during that same turn.
    const possible = candidates.filter(item => item.media.some(part => part.type === type) && item.tool.name !== "read");
    const generated = possible.filter(item => item.tool.name.startsWith("comfyui_"));
    const final = (generated.length ? generated : possible).at(-1);
    if (final) parts.push(...final.media.filter(part => part.type === type));
  }
  for (const item of candidates) {
    if (item.media.every(part => parts.includes(part) || (audioSelection && part.type === "audio" && parts.some(selected =>
      selected.type === "audio" && typeof selected.path === "string" && typeof part.path === "string" &&
      selected.path.replaceAll("\\", "/").toLowerCase() === part.path.replaceAll("\\", "/").toLowerCase(),
    )))) toolIds.add(item.tool.id);
  }
  return { parts, toolIds };
}
