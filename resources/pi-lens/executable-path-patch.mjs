const marker = "// Pi Desktop: launch verified physical ASAR executables";
export function patchPiLensExecutablePath(source) {
  if (source.includes(marker)) return source;
  const anchor = "function trySpawn(command, args, cwd, env, needsShell) {";
  if (source.split(anchor).length !== 2) throw new Error("Pi Lens executable launch anchor changed");
  return `${marker}\nimport { resolveAsarExecutable as desktopPhysicalExecutable } from "./desktop-analysis/executable-path.mjs";\n` +
    source.replace(anchor, anchor + "\n    command = desktopPhysicalExecutable(command);");
}
