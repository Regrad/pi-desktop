import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { structuredPatch } from "diff";
import type { FileDiff, RunDiff } from "../shared/types.js";

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".next",
  ".nuxt",
  ".vs",
  ".vscode",
  ".godot",
  "bin",
  "build",
  "coverage",
  "dist",
  "library",
  "logs",
  "node_modules",
  "obj",
  "target",
  "temp",
  "tmp",
]);
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;
const MAX_FILES = 30_000;

interface FileFingerprint {
  size: number;
  modified: number;
}

interface Snapshot {
  files: Map<string, string>;
  ignored: Map<string, FileFingerprint>;
  truncated: boolean;
}

interface RootInfo {
  path: string;
  label: string;
}

export class RunDiffTracker {
  private constructor(
    private readonly roots: RootInfo[],
    private readonly before: Snapshot,
  ) {}

  static async start(rootPaths: string[]): Promise<RunDiffTracker> {
    const uniqueRoots = [...new Set(rootPaths.map((item) => path.resolve(item)))];
    const roots = uniqueRoots.map((rootPath) => ({
      path: rootPath,
      label: path.basename(rootPath) || rootPath,
    }));
    return new RunDiffTracker(roots, await captureSnapshot(roots));
  }

  async finish(): Promise<RunDiff> {
    const after = await captureSnapshot(this.roots);
    const files: FileDiff[] = [];
    const allPaths = new Set([...this.before.files.keys(), ...after.files.keys()]);

    for (const filePath of allPaths) {
      const oldText = this.before.files.get(filePath);
      const newText = after.files.get(filePath);
      if (oldText === newText) continue;

      const patch = structuredPatch(
        filePath,
        filePath,
        oldText ?? "",
        newText ?? "",
        "",
        "",
        { context: 3 },
      );
      const hunks = patch.hunks.map((hunk) => ({
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        lines: hunk.lines,
      }));
      const additions = hunks.reduce(
        (count, hunk) => count + hunk.lines.filter((line) => line.startsWith("+")).length,
        0,
      );
      const deletions = hunks.reduce(
        (count, hunk) => count + hunk.lines.filter((line) => line.startsWith("-")).length,
        0,
      );
      files.push({
        path: filePath,
        relativePath: this.displayPath(filePath),
        status: oldText === undefined ? "added" : newText === undefined ? "deleted" : "modified",
        additions,
        deletions,
        hunks,
      });
    }

    let incomplete = this.before.truncated || after.truncated;
    const ignoredPaths = new Set([...this.before.ignored.keys(), ...after.ignored.keys()]);
    for (const filePath of ignoredPaths) {
      const before = this.before.ignored.get(filePath);
      const current = after.ignored.get(filePath);
      if (!before || !current || before.size !== current.size || before.modified !== current.modified) {
        incomplete = true;
        break;
      }
    }

    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return {
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      files,
      incomplete,
    };
  }

  private displayPath(filePath: string): string {
    const root = this.roots
      .filter((item) => filePath === item.path || filePath.startsWith(`${item.path}${path.sep}`))
      .sort((left, right) => right.path.length - left.path.length)[0];
    if (!root) return filePath;
    const relative = path.relative(root.path, filePath);
    return this.roots.length > 1 ? path.join(root.label, relative) : relative;
  }
}

async function captureSnapshot(roots: RootInfo[]): Promise<Snapshot> {
  const files = new Map<string, string>();
  const ignored = new Map<string, FileFingerprint>();
  const visited = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let totalBytes = 0;
  let fileCount = 0;
  let truncated = false;

  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      truncated = true;
      return;
    }
    for (const entry of entries) {
      if (fileCount >= MAX_FILES) {
        truncated = true;
        return;
      }
      const absolutePath = path.join(directory, entry.name);
      const normalized = path.resolve(absolutePath);
      if (visited.has(normalized)) continue;
      visited.add(normalized);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name.toLocaleLowerCase())) await visit(normalized);
        continue;
      }
      if (!entry.isFile()) continue;
      fileCount += 1;
      try {
        const info = await stat(normalized);
        const fingerprint = { size: info.size, modified: info.mtimeMs };
        if (info.size > MAX_FILE_BYTES || totalBytes + info.size > MAX_TOTAL_BYTES) {
          ignored.set(normalized, fingerprint);
          if (totalBytes + info.size > MAX_TOTAL_BYTES) truncated = true;
          continue;
        }
        const buffer = await readFile(normalized);
        if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) {
          ignored.set(normalized, fingerprint);
          continue;
        }
        try {
          files.set(normalized, decoder.decode(buffer));
          totalBytes += buffer.length;
        } catch {
          ignored.set(normalized, fingerprint);
        }
      } catch {
        truncated = true;
      }
    }
  };

  for (const root of roots) await visit(root.path);
  return { files, ignored, truncated };
}
