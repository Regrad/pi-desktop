const marker = 'import { normalizeWindowsBash } from "./desktop-windows-bash.js";';

export function patchWindowsBash(source) {
  if (source.includes(marker)) return source;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const replace = (anchor, value) => {
    if (source.split(anchor).length !== 2) throw new Error("Pi Desktop Windows Bash bridge no longer matches pinned Pi.");
    source = source.replace(anchor, () => value);
  };
  const shellContext = "            const shellConfig = resolveShellConfig();";
  replace(shellContext, [shellContext,
    '            if (process.platform === "win32" && shellName === "bash") {',
    '                command = await normalizeWindowsBash(command, shellConfig.shell);',
    '                if (signal?.aborted) throw new Error("aborted");',
    "            }",
  ].join(eol));
  const guidelines = "    promptGuidelines: bashToolSystemPromptContribution.guidelines,";
  replace(guidelines, [
    '    promptGuidelines: process.platform === "win32" ? [...bashToolSystemPromptContribution.guidelines,',
    '        "The bash tool uses Bash syntax even on Windows. Use /dev/null in Bash to discard output. Use the powershell tool for PowerShell syntax.",',
    "    ] : bashToolSystemPromptContribution.guidelines,",
  ].join(eol));
  return marker + eol + source;
}
