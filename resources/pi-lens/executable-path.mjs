import { existsSync } from "node:fs";

export function resolveAsarExecutable(command, exists = existsSync) {
  if (typeof command !== "string" || !/\.(exe|com|cmd|bat)$/i.test(command)) return command;
  const physical = command.replace(/([\\/][^\\/]+\.asar)([\\/])/i, "$1.unpacked$2");
  // Redirect only to an existing physical binary; do not rewrite JS arguments.
  return physical !== command && exists(physical) ? physical : command;
}
