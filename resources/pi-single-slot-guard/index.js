function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default function piSingleSlotGuard(pi) {
  pi.on("tool_call", (event) => {
    if (!isRecord(event.input)) return;

    if (event.toolName === "fetch_content" && event.input.mode === "answer") {
      event.input.mode = "readable";
      delete event.input.prompt;
      delete event.input.answerModel;
      return;
    }

    if (event.toolName === "web_search") {
      event.input.workflow = "none";
    }
  });
}
