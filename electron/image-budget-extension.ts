import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { imageBudgetBytes, pruneRequestImages } from "../shared/image-budget.js";

/**
 * Runs last among Desktop extensions so it sees the final message list and
 * cannot interfere with the prompt, planning or notebook projections.
 */
export default function imageBudgetExtension(
  pi: ExtensionAPI,
  env: Record<string, string | undefined> = process.env,
) {
  pi.on("context", event => {
    const budget = imageBudgetBytes(env);
    if (!budget) return undefined;
    const trimmed = pruneRequestImages(event.messages, budget);
    return trimmed.removed ? { messages: trimmed.messages } : undefined;
  });
}
