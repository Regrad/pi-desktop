import path from "node:path";
import { findPackageJSON } from "node:module";

const reservedName = /^(?:nul|con|prn|aux|com[1-9¹²³]|lpt[1-9¹²³])$/i;
let parserPromise;

function bashParser() {
  parserPromise ??= (async () => {
    const { Parser, Language } = await import("web-tree-sitter");
    const lens = path.dirname(findPackageJSON("pi-lens", import.meta.url));
    await Parser.init();
    const grammar = await Language.load(path.join(lens, "grammars", "tree-sitter-bash.wasm"));
    const parser = new Parser();
    parser.setLanguage(grammar);
    return parser;
  })().catch(error => {
    parserPromise = undefined;
    throw error;
  });
  return parserPromise;
}

function literalDestination(node) {
  switch (node.type) {
    case "word":
      return node.text.replace(/\\(\r?\n|.)/gs, (_, char) => char.endsWith("\n") ? "" : char);
    case "raw_string":
      return node.text.slice(1, -1);
    case "ansi_c_string":
      return node.text.includes("\\") ? undefined : node.text.slice(2, -1);
    case "string":
      return node.namedChildren.every(child => child.type === "string_content")
        ? node.text.slice(1, -1).replace(/\\(\r?\n|[\\"`$])/g, (_, char) => char.endsWith("\n") ? "" : char)
        : undefined;
    case "concatenation": {
      const parts = node.namedChildren.map(literalDestination);
      return parts.every(part => part !== undefined) ? parts.join("") : undefined;
    }
    default:
      return undefined;
  }
}

function redirectDestination(redirect, command) {
  // The grammar may include later arguments in this field. Only join pieces
  // separated by escaped newlines, which Bash removes before tokenization.
  const [first, ...rest] = redirect.childrenForFieldName("destination");
  if (!first) return undefined;
  let target = literalDestination(first);
  let end = first.endIndex;
  for (const part of rest) {
    if (!/^(?:\\\r?\n)+$/.test(command.slice(end, part.startIndex))) break;
    const suffix = literalDestination(part);
    if (target === undefined || suffix === undefined) return undefined;
    target += suffix;
    end = part.endIndex;
  }
  return { target, start: first.startIndex, end };
}

export async function normalizeWindowsBash(command, executable) {
  if (!/^(?:bash|sh)(?:\.exe)?$/i.test(path.win32.basename(executable)) || !/[<>]/.test(command)) return command;
  // Skip simple redirects to ordinary names without initializing the parser.
  if (!/nul|con|prn|aux|com[1-9¹²³]|lpt[1-9¹²³]|[\\"']/i.test(command)) return command;
  const tree = (await bashParser()).parse(command);
  if (!tree) throw new Error("Could not parse Bash redirections. Use /dev/null to discard output in Bash.");
  try {
    const replacements = [];
    for (const redirect of tree.rootNode.descendantsOfType("file_redirect")) {
      const destination = redirectDestination(redirect, command);
      if (!destination?.target) continue;
      const { target, start, end } = destination;
      if (/^nul$/i.test(target)) {
        replacements.push({ start, end });
      } else if (redirect.children.some(child => child.type.includes(">")) && target.split(/[\\/]/).some(component =>
        reservedName.test(component.split(/[.:]/, 1)[0].trimEnd()))) {
        throw new Error("Bash redirection targets a reserved Windows filename. Choose a regular filename, or use /dev/null to discard output.");
      }
    }
    for (const { start, end } of replacements.sort((a, b) => b.start - a.start)) {
      command = command.slice(0, start) + "/dev/null" + command.slice(end);
    }
    return command;
  } finally {
    tree.delete();
  }
}
