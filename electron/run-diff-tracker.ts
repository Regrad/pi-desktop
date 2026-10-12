import { realpathSync } from "node:fs";
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

export type ModelFileSnapshot =
  | { kind: "missing" }
  | { kind: "text"; text: string }
  | { kind: "unsupported"; size?: number; modified?: number };

export interface ModelFileMutation {
  path: string;
  before: ModelFileSnapshot;
  after: ModelFileSnapshot;
}

interface RootInfo {
  path: string;
  label: string;
  aliases: string[];
}

interface MutationSegment {
  before: Extract<ModelFileSnapshot, { kind: "missing" | "text" }>;
  after: Extract<ModelFileSnapshot, { kind: "missing" | "text" }>;
}

interface FileMutations {
  path: string;
  segments: MutationSegment[];
}

interface TrackerCallbacks {
  virtualFilesystem?: boolean;
  onLiveChange?: () => void;
  onScanComplete?: () => void;
}

function emptyRunDiff(): RunDiff {
  return { additions: 0, deletions: 0, files: [], incomplete: false };
}

/**
 * Tracks only successful write/edit operations reported by the Pi RPC bridge.
 *
 * The bridge captures the target file immediately before and after each tool
 * execution. This tracker never scans or re-reads the workspace, so changes
 * made before, after, or between model operations cannot leak into the diff.
 * Contiguous operations on one file are collapsed into a net diff. If an
 * external process changes the file between model operations, a new segment is
 * started and the external transition itself is deliberately excluded.
 */
export class RunDiffTracker {
  private readonly roots: RootInfo[];
  private readonly rootPaths: string[];
  private readonly files = new Map<string, FileMutations>();
  private readonly onLiveChange?: () => void;
  private closed = false;
  private readonly virtualFilesystem: boolean;
  private notifyTimer?: NodeJS.Timeout;

  private constructor(rootPaths: string[], callbacks?: TrackerCallbacks) {
    this.virtualFilesystem = callbacks?.virtualFilesystem ?? false;
    this.rootPaths = [...new Set(rootPaths.map((item) => path.resolve(item)))];
    const byCanonical = new Map<string, RootInfo>();
    for (const raw of this.rootPaths) {
      const canonical = this.virtualFilesystem ? path.resolve(raw) : canonicalizePath(raw);
      const key = canonical.toLocaleLowerCase();
      let info = byCanonical.get(key);
      if (!info) {
        info = {
          path: canonical,
          label: path.basename(canonical) || canonical,
          aliases: [],
        };
        byCanonical.set(key, info);
      }
      if (raw !== canonical && !info.aliases.includes(raw))
        info.aliases.push(raw);
    }
    this.roots = [...byCanonical.values()];
    this.onLiveChange = callbacks?.onLiveChange;
    queueMicrotask(() => {
      if (!this.closed) callbacks?.onScanComplete?.();
    });
  }

  static start(
    rootPaths: string[],
    callbacks?: TrackerCallbacks,
  ): RunDiffTracker {
    return new RunDiffTracker(rootPaths, callbacks);
  }

  covers(rootPaths: string[]): boolean {
    const wanted = [...new Set(rootPaths.map((item) => path.resolve(item)))];
    if (wanted.length !== this.rootPaths.length) return false;
    const known = new Set(
      this.rootPaths.map((item) => item.toLocaleLowerCase()),
    );
    return wanted.every((item) => known.has(item.toLocaleLowerCase()));
  }

  /** Kept for the runtime lifecycle; no workspace baseline is needed. */
  async beginRun(): Promise<void> {}

  recordModelMutation(mutation: ModelFileMutation): void {
    if (this.closed) return;
    const target = this.resolveTrackablePath(mutation.path);
    if (!target) return;
    if (
      mutation.before.kind === "unsupported" ||
      mutation.after.kind === "unsupported" ||
      snapshotsEqual(mutation.before, mutation.after)
    )
      return;

    const key = target.toLocaleLowerCase();
    let file = this.files.get(key);
    if (!file) {
      file = { path: target, segments: [] };
      this.files.set(key, file);
    }
    const segment: MutationSegment = {
      before: mutation.before,
      after: mutation.after,
    };
    const previous = file.segments[file.segments.length - 1];
    if (previous && snapshotsEqual(previous.after, segment.before)) {
      previous.after = segment.after;
      if (snapshotsEqual(previous.before, previous.after)) file.segments.pop();
    } else {
      file.segments.push(segment);
    }
    if (file.segments.length === 0) this.files.delete(key);
    this.scheduleLiveChange();
  }

  async endRun(): Promise<RunDiff> {
    const diff = this.buildDiff();
    this.files.clear();
    return diff;
  }

  async live(): Promise<RunDiff> {
    return this.buildDiff();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = undefined;
    this.files.clear();
  }

  private resolveTrackablePath(rawPath: string): string | undefined {
    if (typeof rawPath !== "string" || !rawPath.trim()) return undefined;
    const trimmed = rawPath.trim();
    const candidates = path.isAbsolute(trimmed)
      ? [path.resolve(trimmed)]
      : this.roots.map((root) => path.resolve(root.path, trimmed));

    for (let candidate of candidates) {
      const lowered = candidate.toLocaleLowerCase();
      for (const root of this.roots) {
        for (const alias of root.aliases) {
          const aliasLower = alias.toLocaleLowerCase();
          if (
            lowered === aliasLower ||
            lowered.startsWith(`${aliasLower}${path.sep}`)
          ) {
            candidate = path.resolve(
              root.path,
              path.relative(alias, candidate),
            );
            break;
          }
        }
      }
      const canonical = this.virtualFilesystem ? path.resolve(candidate) : canonicalizePath(candidate);
      const root = this.deepestContainingRoot(canonical);
      if (root && isTrackablePath(root.path, canonical)) return canonical;
    }
    return undefined;
  }

  private deepestContainingRoot(filePath: string): RootInfo | undefined {
    const lowered = filePath.toLocaleLowerCase();
    return this.roots
      .filter((root) => {
        const rootLower = root.path.toLocaleLowerCase();
        return (
          lowered === rootLower || lowered.startsWith(`${rootLower}${path.sep}`)
        );
      })
      .sort((left, right) => right.path.length - left.path.length)[0];
  }

  private buildDiff(): RunDiff {
    if (this.files.size === 0) return emptyRunDiff();
    const files: FileDiff[] = [];
    for (const file of this.files.values()) {
      const built = this.buildFileDiff(file);
      if (built) files.push(built);
    }
    files.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    );
    return {
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      files,
      incomplete: false,
    };
  }

  private buildFileDiff(file: FileMutations): FileDiff | undefined {
    const hunks = file.segments.flatMap((segment) => {
      const patch = structuredPatch(
        file.path,
        file.path,
        snapshotText(segment.before),
        snapshotText(segment.after),
        "",
        "",
        { context: 3 },
      );
      return patch.hunks.map((hunk) => ({
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        lines: hunk.lines,
      }));
    });
    const existenceChanged = file.segments.some(
      (segment) => segment.before.kind !== segment.after.kind,
    );
    if (hunks.length === 0 && !existenceChanged) return undefined;
    const additions = hunks.reduce(
      (count, hunk) =>
        count + hunk.lines.filter((line) => line.startsWith("+")).length,
      0,
    );
    const deletions = hunks.reduce(
      (count, hunk) =>
        count + hunk.lines.filter((line) => line.startsWith("-")).length,
      0,
    );
    const first = file.segments[0];
    const last = file.segments[file.segments.length - 1];
    return {
      path: file.path,
      relativePath: this.displayPath(file.path),
      status:
        first.before.kind === "missing" && last.after.kind === "text"
          ? "added"
          : first.before.kind === "text" && last.after.kind === "missing"
            ? "deleted"
            : "modified",
      additions,
      deletions,
      hunks,
    };
  }

  private displayPath(filePath: string): string {
    const root = this.deepestContainingRoot(filePath);
    if (!root) return filePath;
    const relative = path.relative(root.path, filePath);
    return this.roots.length > 1 ? path.join(root.label, relative) : relative;
  }

  private scheduleLiveChange(): void {
    if (!this.onLiveChange || this.notifyTimer || this.closed) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      if (!this.closed) this.onLiveChange?.();
    }, 50);
    this.notifyTimer.unref();
  }
}

function snapshotText(
  snapshot: Extract<ModelFileSnapshot, { kind: "missing" | "text" }>,
): string {
  return snapshot.kind === "text" ? snapshot.text : "";
}

function snapshotsEqual(
  left: ModelFileSnapshot,
  right: ModelFileSnapshot,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "missing") return true;
  if (left.kind === "text" && right.kind === "text")
    return left.text === right.text;
  return (
    left.kind === "unsupported" &&
    right.kind === "unsupported" &&
    left.size === right.size &&
    left.modified === right.modified
  );
}

function isTrackablePath(rootPath: string, filePath: string): boolean {
  const relative = path.relative(rootPath, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    return false;
  const segments = relative.split(path.sep);
  return !segments
    .slice(0, -1)
    .some((segment) => EXCLUDED_DIRECTORIES.has(segment.toLocaleLowerCase()));
}

function canonicalizePath(absolute: string): string {
  try {
    return realpathSync(absolute);
  } catch {
    // A newly created or deleted file itself may not exist.
  }
  try {
    return path.join(
      realpathSync(path.dirname(absolute)),
      path.basename(absolute),
    );
  } catch {
    return path.resolve(absolute);
  }
}
