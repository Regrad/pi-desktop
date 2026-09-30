// Keep this small compatibility patch tied to the pinned Pi provider source.
// Do not replace user messages or move media after payload conversion: adjacent
// tool results must keep their own images and tool_call_id, including old chats.
const original = `                if (hasImages && model.input.includes("image")) {
                    for (const block of toolMsg.content) {
                        if (isImageContentBlock(block)) {
                            imageBlocks.push({
                                type: "image_url",
                                image_url: {
                                    url: \`data:\${block.mimeType};base64,\${block.data}\`,
                                },
                            });
                        }
                    }
                }`;

const replacement = `                if (hasImages && model.input.includes("image")) {
                    // Pi Desktop: llama.cpp accepts multimodal tool results.
                    // Preserve provenance instead of inventing a user turn.
                    const toolImages = toolMsg.content.filter(isImageContentBlock).map((block) => ({
                        type: "image_url",
                        image_url: { url: \`data:\${block.mimeType};base64,\${block.data}\` },
                    }));
                    if (model.provider === "llama-cpp") {
                        toolResultMsg.content = [
                            { type: "text", text: sanitizeSurrogates(toolResultText) },
                            ...toolImages,
                        ];
                    }
                    else {
                        // Other providers may only accept images in user turns.
                        imageBlocks.push(...toolImages);
                    }
                }`;

export function patchToolResultImages(source) {
  const normalized = source.replace(/\r\n/g, "\n");
  if (normalized.includes(replacement)) return source;
  if (normalized.split(original).length !== 2) {
    throw new Error("Pi tool-image compatibility patch no longer matches. Review the provider before building.");
  }
  const patched = normalized.replace(original, replacement);
  return source.includes("\r\n") ? patched.replace(/\n/g, "\r\n") : patched;
}
