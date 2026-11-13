import path from "node:path";
import { stat } from "node:fs/promises";

export const portableBinaryDirectory = root => path.join(root, "app");
export const portableApplicationDirectory = root => path.join(portableBinaryDirectory(root), "resources", "app");

export async function installedApplicationDirectory(root) {
  const current = portableApplicationDirectory(root);
  try { await stat(current); return current; }
  catch (error) { if (error.code !== "ENOENT") throw error; return path.join(root, "resources", "app"); }
}
