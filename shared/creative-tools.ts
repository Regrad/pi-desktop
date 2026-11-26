import path from "node:path";

/** Definitions only. Creating a chat must not probe or launch any editor. */
export function creativeMcpServers(appRoot: string, executable: string) {
  return Object.fromEntries(["blender", "aseprite", "froxel"].map(name => [name, {
    command: executable,
    args: [path.join(appRoot, "resources", "creative-tools", "mcp.mjs"), name],
    env: { ELECTRON_RUN_AS_NODE: "1" },
    directTools: false,
    lifecycle: "lazy",
    requestTimeoutMs: 300_000,
    description: {
      blender: "Create, edit, render and export 3D models in Blender.",
      aseprite: "Draw and animate pixel-art sprites in Aseprite.",
      froxel: "Sculpt, rig, animate and export voxel models in Froxel.",
    }[name],
  }]));
}

export function mergeCreativeMcpServers(servers: Record<string, Record<string, unknown>>, appRoot: string, executable: string) {
  const result = { ...servers };
  for (const [name, definition] of Object.entries(creativeMcpServers(appRoot, executable))) {
    const previous = servers[name];
    const args = Array.isArray(previous?.args) ? previous.args : [];
    // Refresh our relocated portable paths; preserve custom servers and disabled states.
    const managed = args.some(arg => typeof arg === "string" && arg.replace(/\\/g, "/").endsWith("/resources/creative-tools/mcp.mjs"));
    if (!previous) result[name] = definition;
    else if (managed) result[name] = { ...definition, ...previous, command: executable, args: definition.args };
  }
  return result;
}
