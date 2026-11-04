import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveHistoryImage } from "../../shared/image-attachments.js";
import { publishImage } from "../../lib/image-input.js";
import type { ToolContext } from "../../lib/context.js";
import { imageBlockSchema, toolResult } from "../../lib/tool-result.js";

export default function register(pi: ExtensionAPI, context: ToolContext) {
  const { dataDir } = context;
  pi.registerTool({
    name: "desktop_show_image", label: "Показать изображение в ответе",
    outputSchema: Type.Object({ path: Type.String(), images: Type.Array(imageBlockSchema) }),
    promptGuidelines: ["Returns an object directly: result.path is the published file; result.images are image blocks for image(block), not text() or JSON.stringify."],
    description: "Publish one explicitly selected local PNG/JPEG/WebP or attachment directly in the chat answer, outside collapsed tools. Existing files stay in place without copying; clipboard images are materialized once in this chat's storage. read inspects an image; this tool shows it to the user. Works even when media tools is disabled.",
    promptSnippet: "Show an existing image in the chat answer with desktop_show_image; read alone does not publish it.",
    parameters: Type.Object({ image: Type.String({ description: "Absolute local path or attachment: reference" }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const image = await publishImage(dataDir, params.image, reference => resolveHistoryImage(ctx.sessionManager.getBranch(), reference));
      return toolResult({ path: image.path }, { files: [image.path], displayInAnswer: true }, [{ type: "image", data: image.data, mimeType: image.mimeType }]);
    },
  });

}
