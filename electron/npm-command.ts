import { existsSync } from "node:fs";
import path from "node:path";

// Run npm's JavaScript entry point directly on Windows. npm.cmd needs cmd.exe,
// which splits unquoted paths and expands shell metacharacters in arguments.
export function npmCommand(
  args: string[],
  runtimeExecutable: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fileExists: (file: string) => boolean = existsSync,
): { executable: string; args: string[]; env: NodeJS.ProcessEnv } {
  const childEnv = { ...env, NO_UPDATE_NOTIFIER: "1" };
  if (platform !== "win32") return { executable: "npm", args: [...args], env: childEnv };

  const candidates: string[] = [];
  if (env.npm_execpath && path.win32.basename(env.npm_execpath).toLowerCase() === "npm-cli.js") {
    candidates.push(env.npm_execpath);
  }
  const searchPath = env.PATH ?? env.Path ?? env.path ?? "";
  for (const entry of searchPath.split(";")) {
    const directory = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!directory || !path.win32.isAbsolute(directory)) continue;
    if (!fileExists(path.win32.join(directory, "npm.cmd"))) continue;
    candidates.push(path.win32.join(directory, "node_modules", "npm", "bin", "npm-cli.js"));
    candidates.push(path.win32.join(directory, "npm", "bin", "npm-cli.js"));
  }
  const cli = candidates.find(candidate => path.win32.isAbsolute(candidate) && fileExists(candidate));
  if (!cli) throw new Error("Не найден npm-cli.js. Установите Node.js с npm и добавьте его папку в PATH.");
  return {
    executable: runtimeExecutable,
    args: [cli, ...args],
    env: { ...childEnv, ELECTRON_RUN_AS_NODE: "1" },
  };
}
