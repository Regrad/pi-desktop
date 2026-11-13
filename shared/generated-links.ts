export type GeneratedLink = { kind: "image" | "music" | "model3d"; filename: string };

/** Stable media address relative to data, independent of the installation path. */
export function generatedMediaReference(file: string): string | undefined {
  const value = file.replaceAll("\\", "/");
  const owned = /\/chats\/([a-zA-Z0-9_-]{1,128})\/((?:image-generation|music-generation|3d-generation|video-generation|comfy-results|workspace|chat-attachments)\/.+)$/.exec(value);
  if (owned) {
    const parts = owned[2].split("/");
    if (parts.some(part => !part || part === "." || part === ".." || /[:\0]/.test(part))) return;
    return `${owned[1]}/${owned[2]}`;
  }
  return /\/(?:image-generation|music-generation|3d-generation|video-generation|comfy-results)\/([^/:\0]+)$/.exec(value)?.[1];
}

// Recognize only local generated media, never executable files or network shares.
export function parseGeneratedLink(value: string): GeneratedLink | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:" || url.host || url.search || url.hash) return;
    const pathname = decodeURIComponent(url.pathname);
    if (!/^\/[a-z]:\//i.test(pathname) || /[\\\0]/.test(pathname)) return;
    const match = /\/(image-generation|music-generation|3d-generation)\/([^/]+)$/.exec(pathname);
    if (!match || /[:]/.test(match[2])) return;
    const kind = match[1] === "music-generation" ? "music" : match[1] === "3d-generation" ? "model3d" : "image";
    const extensions = kind === "music" ? /\.(flac|wav|mp3|opus|ogg)$/i : kind === "model3d" ? /\.glb$/i : /\.(png|jpe?g|webp)$/i;
    return extensions.test(match[2]) ? { kind, filename: generatedMediaReference(pathname) ?? match[2] } : undefined;
  } catch { return; }
}

export function generatedLinkLabel(href: string, text: string): string {
  const link = parseGeneratedLink(href);
  if (!link || (text !== href && !/^file:\/\//i.test(text))) return text;
  const name = link.filename.split("/").pop()!;
  return name.length > 64 ? `${name.slice(0, 24)}…${name.slice(-32)}` : name;
}
