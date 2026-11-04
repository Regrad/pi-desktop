import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { listHistoryImages } from "../../shared/image-attachments.js";
import type { ToolContext } from "../../lib/context.js";
import { toolResult } from "../../lib/tool-result.js";

export default function register(pi: ExtensionAPI, _context: ToolContext) {
  pi.registerTool({
    name: "media_list_attachments", label: "Изображения из чата",
    outputSchema: Type.Object({ items: Type.Array(Type.Object({ reference: Type.String(), name: Type.String(), mimeType: Type.String(), path: Type.Optional(Type.String()), role: Type.Optional(Type.String()), maskFor: Type.Optional(Type.String()), convention: Type.Optional(Type.String()) })), guidance: Type.String() }),
    promptGuidelines: ["Returns an object directly: result.items contains attachment metadata, not image bytes."],
    description: "List the latest 20 user image attachments in this chat. Image tools accept these attachment: references directly. Use original absolute paths when available. If a script or precise crop needs a file, resolve the chosen reference with desktop_get_image_path instead of guessing paths. Listing does not copy images.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const images = listHistoryImages(ctx.sessionManager.getBranch()).slice(-20);
      return toolResult({ items: images, guidance: "Resolve a selected reference with desktop_get_image_path({image: reference}); use result.path for files or scripts." }, {});
    },
  });

}
