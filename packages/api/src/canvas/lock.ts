type Task<T> = () => Promise<T>;

const chains = new Map<string, Promise<unknown>>();

/**
 * Serializes async tasks per key through an in-process promise queue: a task
 * waits for the prior task on the same key to settle before it runs, so a
 * single user's canvas-doc mutations never interleave their read-modify-write
 * of the git repo and index. This guarantee holds only within one process — the
 * deployment runs a single backend process, so no cross-process writer can race
 * the same user's repo. A key's chain entry is dropped once it drains, keeping
 * the map bounded by the set of users with in-flight work.
 */
export const withUserLock = <T>(key: string, task: Task<T>): Promise<T> => {
  const prior = chains.get(key) ?? Promise.resolve();
  const run = prior.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, settled);
  settled.then(() => {
    if (chains.get(key) === settled) {
      chains.delete(key);
    }
  });
  return run;
};
