const LOADER_TOOL_NAME = "pi_lens_activate_tools";

export default function piLensAllTools(pi) {
  pi.on("session_start", () => {
    const allTools = pi.getAllTools();
    const loaderTool = allTools.find((tool) => tool.name === LOADER_TOOL_NAME);
    if (!loaderTool) return;

    const sourcePath = loaderTool.sourceInfo?.path;
    if (!sourcePath) return;

    const lensTools = allTools
      .filter((tool) => tool.name !== LOADER_TOOL_NAME && tool.sourceInfo?.path === sourcePath)
      .map((tool) => tool.name);
    const activeTools = pi.getActiveTools().filter((name) => name !== LOADER_TOOL_NAME);
    pi.setActiveTools([...new Set([...activeTools, ...lensTools])]);
  });
}
