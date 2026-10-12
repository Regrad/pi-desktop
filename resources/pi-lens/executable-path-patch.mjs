import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const marker = "// Pi Desktop: launch verified physical ASAR executables";
export function patchPiLensExecutablePath(source, name = "dist/index.js") {
  if (source.includes(marker)) return source;
  const anchor = "function trySpawn(command, args, cwd, env, needsShell) {";
  if (source.split(anchor).length !== 2) throw new Error("Pi Lens executable launch anchor changed");
  const relative = path.posix.relative(path.posix.dirname(name), "dist/desktop-analysis/executable-path.mjs");
  const helper = relative.startsWith(".") ? relative : "./" + relative;
  return `${marker}\nimport { resolveAsarExecutable as desktopPhysicalExecutable } from ${JSON.stringify(helper)};\n` +
    source.replace(anchor, anchor + "\n    command = desktopPhysicalExecutable(command);");
}

export async function applyPiLensExecutablePath(packageDir) {
  const manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
  if (manifest.version !== "4.3.0") throw new Error("Pi Lens executable path bridge targets 4.3.0");
  // Check both launchers before writing either one.
  const changes = await Promise.all(["dist/index.js", "dist/clients/lsp/launch.js"].map(async name => {
    const file = path.join(packageDir, name);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(file));
    return { file, source, patched: patchPiLensExecutablePath(source, name) };
  }));
  const directory = path.join(packageDir, "dist/desktop-analysis");
  await mkdir(directory, { recursive: true });
  await copyFile(new URL("executable-path.mjs", import.meta.url), path.join(directory, "executable-path.mjs"));
  for (const { file, source, patched } of changes) if (source !== patched) await writeFile(file, patched, "utf8");
}
