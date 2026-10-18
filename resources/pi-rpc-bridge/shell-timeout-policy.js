// Only known simple inspections get a short deadline. Unknown commands may be
// builds, scripts or other long jobs, so never infer their duration from silence.
// Keep this function self-contained: the compatibility bridge embeds it in Pi.
export function defaultShellTimeout(command) {
  const quickSeconds = 60;
  const workSeconds = 3600;
  if (typeof command !== "string" || !command.trim()) return workSeconds;
  // Expansions, script blocks and nested shells need an actual shell parser;
  // conservatively give them the work deadline instead of guessing.
  if (/[$`(){}]/.test(command)) return workSeconds;
  const inspections = new Set([
    "pwd", "cd", "ls", "dir", "cat", "head", "tail", "wc", "rg", "grep",
    "echo", "printf", "stat", "file", "which", "where", "whoami", "uname",
    "get-location", "set-location", "get-childitem", "get-content", "get-item",
    "get-itemproperty", "test-path", "resolve-path", "get-command", "get-process",
    "select-string", "select-object", "sort-object", "format-list", "format-table",
    "write-output", "out-string", "measure-object",
  ]);
  const segments = command.split(/[;&|\r\n]+/).filter(part => part.trim());
  for (const segment of segments) {
    const words = segment.trim().match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
    const executable = (words.shift() ?? "").replace(/^["']|["']$/g, "");
    const name = executable.split(/[\\/]/).pop().replace(/\.exe$/i, "").toLowerCase();
    if (words.some(word => /^-(?:wait|follow)$/.test(word.toLowerCase())) ||
        name === "tail" && words.some(word => /^-(?:[a-z]*[fF][a-z]*|-follow(?:=|$))/.test(word))) return workSeconds;
    if (inspections.has(name)) continue;
    if (name === "git" && /^(?:status|diff|show|log|ls-files|rev-parse)$/.test(words[0] ?? "")) continue;
    if (/^(?:cmake|ninja|make|node|python|python3|dotnet|npm|pnpm|yarn|cargo|rustc|gcc|clang|msbuild)$/.test(name) &&
        words.length === 1 && /^(?:--version|-v|-V|--help|-h|\/\?)$/.test(words[0])) continue;
    return workSeconds;
  }
  return segments.length ? quickSeconds : workSeconds;
}
