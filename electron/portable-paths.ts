import path from "node:path";

export function portableDataDirectory(projectRoot: string, executable: string, packaged: boolean, portableDir?: string): string {
  if (!packaged && !portableDir) return path.join(projectRoot, "data");
  const binaryDir = portableDir ?? path.dirname(executable);
  // New distributions keep Electron in app/. Flat older distributions still work.
  return path.join(path.basename(binaryDir).toLowerCase() === "app" ? path.dirname(binaryDir) : binaryDir, "data");
}
