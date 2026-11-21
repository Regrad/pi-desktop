import type { Plugin } from "unified";

export type CitationSource = { url: string; title: string; number: number };

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  title?: string;
  children?: MarkdownNode[];
  data?: { hProperties?: Record<string, string> };
};

// LibreChat produces the literal escape sequences. Some models emit the
// equivalent character instead. Both represent the same stored source IDs.
const tokens = /(?:\\ue202|\uE202)(turn\d+(?:search|news|image|ref)\d+)|\\ue20[0134]|[\uE200\uE201\uE203\uE204]/gi;

export const remarkWebCitations: Plugin<[ReadonlyMap<string, CitationSource>]> = sources => tree => {
  if (!sources.size) return;
  const walk = (node: MarkdownNode) => {
    if (!node.children || ["link", "linkReference", "code", "inlineCode", "html"].includes(node.type)) return;
    node.children = node.children.flatMap(child => {
      if (child.type !== "text" || !child.value) {
        walk(child);
        return [child];
      }
      const replacements: MarkdownNode[] = [];
      let offset = 0;
      for (const match of child.value.matchAll(tokens)) {
        const index = match.index;
        if (index > offset) replacements.push({ type: "text", value: child.value.slice(offset, index) });
        if (match[1]) {
          const source = sources.get(match[1].toLowerCase());
          if (source && /^https?:\/\//i.test(source.url)) {
            replacements.push({
              type: "link", url: source.url, title: source.title || source.url,
              data: { hProperties: { className: "web-citation" } },
              children: [{ type: "text", value: `[${source.number}]` }],
            });
          } else {
            replacements.push({ type: "text", value: match[0] });
          }
        }
        offset = index + match[0].length;
      }
      if (offset === 0) return [child];
      if (offset < child.value.length) replacements.push({ type: "text", value: child.value.slice(offset) });
      return replacements;
    });
  };
  walk(tree as MarkdownNode);
};
