import { cp, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";

async function exists(filename) {
  try { await lstat(filename); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

// Stage on the release volume and retain every old module until all writes,
// including the manifest, have succeeded. A failed rollback retains recovery data.
export async function createReleaseTransaction(releaseRoot, io = {}) {
  const root = path.resolve(releaseRoot);
  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(path.join(root, ".pi-desktop-update-"));
  const move = io.rename ?? rename;
  const operations = [];
  let finished = false;
  let preserveRecovery = false;

  function checkedTarget(target) {
    if (finished) throw new Error("Release transaction already finished.");
    const absolute = path.resolve(target);
    const relative = path.relative(root, absolute);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || absolute === staging || absolute.startsWith(staging + path.sep)) {
      throw new Error(`Release target must be inside the release directory: ${target}`);
    }
    for (const operation of operations) {
      if (absolute === operation.target || absolute.startsWith(operation.target + path.sep)
        || operation.target.startsWith(absolute + path.sep)) throw new Error(`Overlapping release targets: ${target}`);
    }
    return absolute;
  }

  async function stage(source, target) {
    const absolute = checkedTarget(target);
    // Do not follow a portable-data junction outside the release during writes.
    for (let parent = absolute; parent !== root; parent = path.dirname(parent)) {
      if (await exists(parent) && (await lstat(parent)).isSymbolicLink()) throw new Error(`Linked release target: ${parent}`);
    }
    const index = operations.length;
    const next = source ? path.join(staging, `next-${index}`) : undefined;
    if (next) await cp(source, next, { recursive: true, errorOnExist: true, force: false });
    operations.push({ target: absolute, next, old: path.join(staging, `old-${index}`), oldMoved: false, installed: false });
  }

  return {
    stagingRoot: staging,
    replace: (source, target) => stage(source, target),
    remove: target => stage(undefined, target),
    async commit(validate = async () => {}) {
      if (finished) throw new Error("Release transaction already finished.");
      try {
        await validate("before");
        for (const operation of operations) {
          await mkdir(path.dirname(operation.target), { recursive: true });
          if (await exists(operation.target)) {
            await move(operation.target, operation.old);
            operation.oldMoved = true;
          }
          if (operation.next) {
            await move(operation.next, operation.target);
            operation.installed = true;
          }
        }
        await validate("after");
      } catch (error) {
        const failures = [];
        for (const operation of [...operations].reverse()) {
          try {
            if (operation.installed) await rm(operation.target, { recursive: true, force: true });
            if (operation.oldMoved) await move(operation.old, operation.target);
          } catch (rollbackError) { failures.push(rollbackError); }
        }
        finished = true;
        if (failures.length) {
          preserveRecovery = true;
          throw new AggregateError([error, ...failures], `Release rollback incomplete. Recovery files preserved at: ${staging}`);
        }
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
      finished = true;
      // Cleanup failure after commit must not pretend the activation failed.
      await rm(staging, { recursive: true, force: true }).catch(error => {
        console.warn(`Release updated; temporary files could not be removed at ${staging}: ${error.message}`);
      });
    },
    async dispose() {
      if (!finished && !preserveRecovery) await rm(staging, { recursive: true, force: true });
      finished = true;
    },
  };
}
