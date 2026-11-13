import path from "node:path";

// Call only with tool results from the owning device's session/events, never user text.
export function collectMediaGrants(value, dataDir, grants) {
  if (typeof value === "string") {
    for (const [kind, folder] of [["image", "image-generation"], ["music", "music-generation"], ["model3d", "3d-generation"], ["video", "video-generation"], ["artifact", "comfy-results"]]) {
      if (path.isAbsolute(value) && path.dirname(path.resolve(value)) === path.resolve(dataDir, folder)) grants.add(`${kind}/${path.basename(value)}`);
      if (path.isAbsolute(value)) {
        const relative = path.relative(path.resolve(dataDir, "chats"), path.resolve(value)).split(path.sep).join("/");
        const match = /^([a-zA-Z0-9_-]{1,128})\/([^/]+)\/(.+)$/.exec(relative);
        if (match && !relative.split("/").some(part => !part || part === "." || part === "..")
          && (match[2] === folder || (kind === "image" && ["workspace", "chat-attachments"].includes(match[2]) && /\.(png|jpe?g|webp)$/i.test(match[3]))))
          grants.add(`${kind}/${relative}`);
      }
    }
    return;
  }
  if (Array.isArray(value)) { value.forEach(item => collectMediaGrants(item, dataDir, grants)); return; }
  if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    if (["data", "text", "before", "after"].includes(key)) continue; // File contents/user text never grant capabilities.
    collectMediaGrants(item, dataDir, grants);
  }
}
