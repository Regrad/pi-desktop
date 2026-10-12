// Never clean the backup here: failed activation AND failed rollback must leave
// the original installation available for manual recovery.
export async function activatePortableBuild({ target, next, previous }, { exists, rename }) {
  if (await exists(previous)) throw new Error(`Backup already exists: ${previous}`);
  const hadTarget = await exists(target);
  if (hadTarget) await rename(target, previous, "move old aside");
  try {
    await rename(next, target, "activate new build");
  } catch (error) {
    if (hadTarget) {
      try {
        if (await exists(target)) throw new Error(`Target unexpectedly exists: ${target}`);
        await rename(previous, target, "restore original build");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Activation and rollback failed. Original installation preserved at: ${previous}`);
      }
    }
    throw error;
  }
  return hadTarget;
}
