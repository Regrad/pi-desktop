export function patchPiLensEditDiagnostics(source) {
  const replacements = [
    ["the file has likely changed significantly. Re-read the relevant section before retrying.",
      "this replacement was not applied. Re-read the relevant section and copy oldText from the current file before retrying."],
    [/The file has likely changed since your last read (?:—|\\u2014) this is a content-drift issue, not indentation\./g,
      "The supplied fragment does not match the current file content. This replacement was not applied."],
  ];
  let result = source;
  for (const [before, after] of replacements) {
    if (result.includes(after)) continue;
    const matches = typeof before === "string" ? result.split(before).length - 1 : [...result.matchAll(before)].length;
    if (matches !== 1) throw new Error("Pi Lens edit-diagnostics bridge is incompatible with this version; review the guard messages.");
    result = result.replace(before, after);
  }
  return result;
}
