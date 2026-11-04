import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveHistoryImage } from "../../shared/image-attachments.js";
import { imagePathForTool } from "../../lib/image-input.js";
import type { ToolContext } from "../../lib/context.js";
import { toolResult } from "../../lib/tool-result.js";

export default function register(pi: ExtensionAPI, context: ToolContext) {
  const { dataDir } = context;
  pi.registerTool({
    name: "desktop_get_image_path", label: "Путь к изображению из чата",
    outputSchema: Type.Object({ path: Type.String(), width: Type.Number(), height: Type.Number() }),
    promptGuidelines: ["Returns an object directly: result.path is the absolute local image path; result.width/height are pixel dimensions."],
    description: "Resolve one selected image attachment: reference to an absolute PNG path for file-based scripts or exact cropping. Materialize pasted pixels once in this chat; repeated calls reuse the file. Validate original paths without copying. Image tools also accept attachment: references directly. This tool does not publish an image.",
    promptSnippet: "Pasted chat images have no original disk path. Resolve the selected attachment: reference with desktop_get_image_path before shell scripts or cropping.",
    parameters: Type.Object({ image: Type.String({ description: "One attachment: reference from media_list_attachments, or an existing absolute PNG/JPEG/WebP path." }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const image = await imagePathForTool(dataDir, params.image, reference => resolveHistoryImage(ctx.sessionManager.getBranch(), reference));
      return toolResult({ path: image.path, width: image.width, height: image.height }, { files: [image.path], displayInAnswer: false });
    },
  });

}
