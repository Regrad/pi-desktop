import path from "node:path";

export const mediaFolders = ["image-generation", "music-generation", "3d-generation", "video-generation", "comfy-results"] as const;

export function chatDirectory(dataDir: string, id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Некорректный идентификатор чата");
  return path.resolve(dataDir, "chats", id);
}

/** Settings stay global. Only files owned by the running chat go here. */
export function chatFileDirectory(dataDir: string, folder: string, owner = process.env.PI_DESKTOP_CONVERSATION_ID): string {
  if (!/^[a-z0-9-]+$/.test(folder)) throw new Error("Некорректная папка данных");
  return path.join(owner ? chatDirectory(dataDir, owner) : dataDir, folder);
}
