const oldImport = 'import { routeTool, declaredTools, routingEnabled } from "./desktop-tool-routing.js";\n';
const importLine = 'import { routeTool, declaredTools, routingEnabled, guardExtensionHandler } from "./desktop-tool-routing.js";\n';

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
  let normalized = source.replace(/\r\n/g, "\n").replace(oldImport, "").replace(importLine, "");
  const register = '        registerTool(tool) {\n            assertActive();';
  const activate = '            runtime.setActiveTools(toolNames);';
  const routed = '            tool = routeTool(tool, extension.path);';
  const declared = '            runtime.setActiveTools(routingEnabled() ? declaredTools(toolNames, runtime.getAllTools()) : toolNames);';
  const handler = '            const registeredHandler = (...args) => handler(...args);';
  const guarded = '            const guardedHandler = guardExtensionHandler(event, handler, extension.path);\n            const registeredHandler = (...args) => guardedHandler(...args);';
  if (normalized.split(register).length !== 2 || (!normalized.includes(declared) && normalized.split(activate).length !== 2)
    || (!normalized.includes(guarded) && normalized.split(handler).length !== 2)) {
    throw new Error("Pi tool routing anchors changed; review the extension loader.");
  }
  if (!normalized.includes(routed)) normalized = normalized.replace(register, `${register}\n${routed}`);
  if (!normalized.includes(declared)) normalized = normalized.replace(activate, declared);
  if (!normalized.includes(guarded)) normalized = normalized.replace(handler, guarded);
  const result = importLine + normalized;
  return source.includes("\r\n") ? result.replace(/\n/g, "\r\n") : result;
}

/** Hidden model APIs bypass tool_call, so check the same live permission at their execution boundary. */
export function patchCodemodePlanning(source) {
  const header = 'import { assertPlanningModelAccess } from "../../core/extensions/desktop-tool-routing.js";\n';
  const anchor = '    const runModelCall = async (name, type, [model, context], checkContext, run) => {';
  const check = `${anchor}\n        assertPlanningModelAccess();`;
  const normalized = source.replace(/\r\n/g, "\n");
  if (normalized.includes(header) && normalized.includes(check)) return source;
  if (normalized.split(anchor).length !== 2 || normalized.includes(header)) throw new Error("Pi codemode model-call permission anchor changed.");
  const result = header + normalized.replace(anchor, check);
  return source.includes("\r\n") ? result.replace(/\n/g, "\r\n") : result;
}
