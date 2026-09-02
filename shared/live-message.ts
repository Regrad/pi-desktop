export type LiveJsonObject = Record<string, any>;

export function applyAssistantMessageDelta(
  current: LiveJsonObject | undefined,
  delta: LiveJsonObject,
): LiveJsonObject {
  const next = current ? structuredClone(current) : { role: "assistant", content: [] };
  if (!Array.isArray(next.content)) next.content = [];
  const index = Number(delta.contentIndex ?? 0);
  while (next.content.length <= index) next.content.push({ type: "text", text: "" });
  if (delta.type === "text_start") next.content[index] = { type: "text", text: "" };
  if (delta.type === "thinking_start") next.content[index] = { type: "thinking", thinking: "" };
  if (delta.type === "toolcall_start") {
    const toolCall = delta.toolCall as LiveJsonObject | undefined;
    next.content[index] = {
      type: "toolCall",
      id: toolCall?.id,
      name: toolCall?.name ?? "Инструмент",
      arguments: toolCall?.arguments ?? {},
      partialArguments: "",
    };
  }
  if (delta.type === "text_delta") next.content[index].text = `${next.content[index].text ?? ""}${delta.delta ?? ""}`;
  if (delta.type === "thinking_delta") next.content[index].thinking = `${next.content[index].thinking ?? ""}${delta.delta ?? ""}`;
  if (delta.type === "toolcall_delta") {
    const toolCall = delta.toolCall as LiveJsonObject | undefined;
    next.content[index].partialArguments = `${next.content[index].partialArguments ?? ""}${delta.delta ?? ""}`;
    if (toolCall?.id) next.content[index].id = toolCall.id;
    if (toolCall?.name) next.content[index].name = toolCall.name;
    if (toolCall?.arguments && typeof toolCall.arguments === "object") next.content[index].arguments = toolCall.arguments;
  }
  if (delta.type === "toolcall_end" && delta.toolCall) next.content[index] = delta.toolCall;
  return next;
}
