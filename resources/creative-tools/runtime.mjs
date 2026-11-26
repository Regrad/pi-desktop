import path from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { readFile, readdir, stat, mkdir, writeFile } from "node:fs/promises";

/** fs.cp delegates to native filesystem internals which cannot traverse ASAR. */
export async function materializeResources(source, destination) {
  const info = await stat(source);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const name of await readdir(source))
      await materializeResources(path.join(source, name), path.join(destination, name));
  } else if (info.isFile()) {
    await writeFile(destination, await readFile(source));
  } else throw new Error(`Unsupported editor resource: ${source}`);
}

export const editorNames = ["blender", "aseprite", "froxel"];

export async function readEditorSettings(agentDir, name) {
  if (!editorNames.includes(name)) throw new Error("Unknown creative editor.");
  const file = path.join(agentDir, "creative-tools.json");
  let settings;
  try { settings = JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new Error(`Cannot read ${file}: ${error.message}`); }
  const value = settings?.[name] ?? {};
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (value.executable !== undefined && typeof value.executable !== "string") ||
      (value.mode !== undefined && !["headless", "window"].includes(value.mode)))
    throw new Error(`Invalid ${name} settings in ${file}.`);
  return { ...value, file };
}

async function versions(root, executable) {
  try {
    const children = await readdir(root, { withFileTypes: true });
    return children.filter(item => item.isDirectory()).map(item => path.join(root, item.name, executable))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

export async function resolveEditor(name, settings, env = process.env) {
  const explicit = settings.executable || env[`PI_DESKTOP_${name.toUpperCase()}_PATH`];
  if (explicit) {
    if (!path.isAbsolute(explicit) || !(await stat(explicit).catch(() => null))?.isFile())
      throw new Error(`Configured ${name} executable does not exist: ${explicit}. Fix ${settings.file}.`);
    return explicit;
  }
  const local = env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local");
  const programs = env.ProgramFiles || "C:\\Program Files";
  const programs86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const candidates = (env.PATH || "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, exe));
  if (process.platform === "win32") {
    candidates.unshift(path.join(local, "Programs", name === "aseprite" ? "Aseprite" : name === "froxel" ? "Froxel" : "Blender", exe));
    if (name === "blender") candidates.push(...await versions(path.join(programs, "Blender Foundation"), exe));
    if (name === "froxel") candidates.push(...await versions(path.join(local, "Programs", "Froxel"), exe));
    if (name === "aseprite") candidates.push(path.join(programs, "Aseprite", exe), path.join(programs86, "Steam", "steamapps", "common", "Aseprite", exe));
  }
  for (const file of candidates) if (existsSync(file) && (await stat(file)).isFile()) return file;
  throw new Error(`${name} is not installed. Install the editor, then set ${name}.executable in ${settings.file} if it is outside standard folders. Reconnect this MCP server. See docs/CREATIVE_TOOLS.md.`);
}
