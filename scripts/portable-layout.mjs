import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { extractFile } from "@electron/asar";

export const portableBinaryDirectory = root => path.join(root, "app");
export const portableApplicationDirectory = root => path.join(portableBinaryDirectory(root), "resources", "app");

export function isApplicationArchive(filename) {
  return path.basename(filename) === "app.asar";
}

export async function installedApplicationPath(binaryDir) {
  const resources = path.join(binaryDir, "resources");
  const archive = path.join(resources, "app.asar");
  try { if ((await stat(archive)).isFile()) return archive; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return path.join(resources, "app");
}

export async function readApplicationFile(app, relative) {
  try {
    return isApplicationArchive(app) ? extractFile(app, path.normalize(relative)) : await readFile(path.join(app, relative));
  } catch (error) {
    if (error.code !== "ENOENT" && !error.message.endsWith("was not found in this archive")) throw error;
    return undefined;
  }
}
