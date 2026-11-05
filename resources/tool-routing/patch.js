const importLine = 'import { routeTool, declaredTools, routingEnabled } from "./desktop-tool-routing.js";\n';

const discoveryOriginal = '        "- `ALL_TOOLS`, `await searchTools(query, { limit?, namespace? })`, `await describeTool(name)`, `await describeNamespace(name)`: find unlisted tools, such as MCP tools.",';
const discoveryReplacement = [
  '        "- `ALL_TOOLS` is a synchronous array of `{ name, description }` objects, not an object keyed by tool name. List names with `text(ALL_TOOLS.map(t => t.name))`.",',
  '        "- `searchTools`, `describeTool`, and `describeNamespace` are asynchronous: always await their results before reading or printing them. Examples: `text(await searchTools(\"music\", { limit: 3 }))`; `text(await describeTool(\"tool_name\"))`; `text(await describeNamespace(\"namespace_name\"))`. Use names returned by discovery, then call `await tools.<name>({ ...args })`. Serializing an unawaited Promise gives `{}`, not discovery results.",',
].join("\n").replaceAll('"music"', '\\"music\\"').replaceAll('"tool_name"', '\\"tool_name\\"').replaceAll('"namespace_name"', '\\"namespace_name\\"');

export function patchCodemodeDiscoveryDescription(source) {
  const normalized = source.replace(/\r\n/g, "\n");
  if (normalized.includes(discoveryReplacement)) return source;
  if (normalized.split(discoveryOriginal).length !== 2) {
    throw new Error("Pi codemode discovery anchor changed; review the tool description.");
  }
  const result = normalized.replace(discoveryOriginal, discoveryReplacement);
  return source.includes("\r\n") ? result.replace(/\n/g, "\r\n") : result;
}

export function patchToolRouting(source) {
  const normalized = source.replace(/\r\n/g, "\n");
  if (normalized.includes(importLine)) return source;
  const register = '        registerTool(tool) {\n            assertActive();';
  const activate = '            runtime.setActiveTools(toolNames);';
  if (normalized.split(register).length !== 2 || normalized.split(activate).length !== 2) {
    throw new Error("Pi tool routing anchors changed; review the extension loader.");
  }
  const result = importLine + normalized
    .replace(register, `${register}\n            tool = routeTool(tool, extension.path);`)
    .replace(activate, '            runtime.setActiveTools(routingEnabled() ? declaredTools(toolNames, runtime.getAllTools()) : toolNames);');
  return source.includes("\r\n") ? result.replace(/\n/g, "\r\n") : result;
}
