export type GeneratedLink = { kind: "image" | "music" | "model3d"; filename: string };

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
    return extensions.test(match[2]) ? { kind, filename: match[2] } : undefined;
  } catch { return; }
}

export function generatedLinkLabel(href: string, text: string): string {
  const link = parseGeneratedLink(href);
  if (!link || (text !== href && !/^file:\/\//i.test(text))) return text;
  return link.filename.length > 64 ? `${link.filename.slice(0, 24)}…${link.filename.slice(-32)}` : link.filename;
}
