// Version-checked compatibility bridge, shipped with the portable application.
function replaceOnce(source, before, after) {
  if (source.includes(after)) return source;
  if (source.split(before).length !== 2) throw new Error("Pi Desktop context bridge no longer matches pinned Pi; review before applying.");
  return source.replace(before, after);
}

export function patchServiceMessages(source) {
  const before = "export function convertToLlm(messages) {\n    return messages";
  const after = "export function convertToLlm(messages) {\n    if (desktopContextEnabled()) messages = projectDesktopServiceContext(messages);\n    return messages";
  const normalized = source.replace(/\r\n/g, "\n");
  const patched = replaceOnce(normalized, before, after);
  const header = 'import { desktopContextEnabled, projectDesktopServiceContext } from "./desktop-service-context.js";\n';
  const result = patched.includes(header) ? patched : header + patched;
  return source.includes("\r\n") ? result.replace(/\n/g, "\r\n") : result;
}

export function patchDesktopCompaction(source) {
  let result = source.replace(/\r\n/g, "\n");
  result = replaceOnce(result, "const llmMessages = convertToLlm(currentMessages);", "const llmMessages = convertToLlm(desktopSummaryMessages(currentMessages));");
  result = replaceOnce(result, "const llmMessages = convertToLlm(messages);", "const llmMessages = convertToLlm(desktopSummaryMessages(messages));");
  const serializer = "const conversationText = serializeDesktopSummary(llmMessages, serializeConversation);";
  if (!result.includes(serializer)) {
    const original = "const conversationText = serializeConversation(llmMessages);";
    if (result.split(original).length !== 3) throw new Error("Pi Desktop summary serializer no longer matches pinned Pi.");
    result = result.replaceAll(original, serializer);
  }
  result = replaceOnce(result, "let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;",
    "let basePrompt = desktopSummaryInstructions(previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT);");
  result = replaceOnce(result, "${TURN_PREFIX_SUMMARIZATION_PROMPT}`;", "${desktopSummaryInstructions(TURN_PREFIX_SUMMARIZATION_PROMPT)}`;");
  result = result.replace('import { desktopSummaryMessages, desktopSummaryInstructions } from "../desktop-service-context.js";\n', "");
  const header = 'import { desktopSummaryMessages, desktopSummaryInstructions, serializeDesktopSummary } from "../desktop-service-context.js";\n';
  if (!result.includes(header)) result = header + result;
  return source.includes("\r\n") ? result.replace(/\n/g, "\r\n") : result;
}
