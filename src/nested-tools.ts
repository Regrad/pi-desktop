type RecordValue = Record<string, any>;

export interface NestedActivity {
  id: string;
  name: string;
  parentToolCallId?: string;
  args?: unknown;
  result?: unknown;
  running: boolean;
  error?: boolean;
  startedAt: number;
}

// Native nested calls belong to the model-issued parent, not the transcript footer.
// Persisted records contain status/arguments, not the complete tool output.
export function nestedToolActivities(
  parentId: string,
  live: Record<string, NestedActivity>,
  results: ReadonlyMap<string, RecordValue>,
): NestedActivity[] {
  const collected = new Map<string, NestedActivity>();
  const visited = new Set<string>([parentId]);
  const visit = (id: string) => {
    const record = results.get(id)?.nestedCalls;
    const saved = Array.isArray(record) ? record : record?.calls;
    const children = new Map<string, NestedActivity>();
    if (Array.isArray(saved)) {
      for (const call of saved) {
        if (typeof call?.id !== "string" || typeof call.name !== "string") continue;
        children.set(call.id, {
          id: call.id, name: call.name, parentToolCallId: id,
          args: call.arguments, running: false, error: call.status === "error",
          startedAt: 0,
          ...(call.error ? { result: { content: [{ type: "text", text: call.error }], isError: true } } : {}),
        });
      }
    }
    for (const tool of Object.values(live)) {
      if (tool.parentToolCallId === id || children.has(tool.id)) {
        children.set(tool.id, { ...children.get(tool.id), ...tool });
      }
    }
    for (const child of children.values()) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      collected.set(child.id, child);
      visit(child.id);
    }
  };
  visit(parentId);
  return [...collected.values()];
}
