import { join } from 'node:path';

import { realTmpdir } from './tmpdir.js';

/**
 * The environment variable that carries the test run's temporary root.
 *
 * The name deliberately does not start with `MEMPHIS_`: the test isolation
 * helper strips every `MEMPHIS_*` variable from the environment it hands
 * to a test, and this one has to survive that.
 */
export const TEST_TMP_ROOT_ENV = 'MEPHIS_TEST_TMP_ROOT';

/** The run directory carries the pid of the process that created it. */
const RUN_DIR_PATTERN = /memphis-test-run-(\d+)$/;

export type TestTmpRoot = {
  /** The directory this run puts its fixtures in. */
  root: string;
  /**
   * True when this process created the directory, false when it inherited
   * it from an enclosing run.
   */
  owned: boolean;
};

/**
 * Does this directory belong to the given process?
 *
 * Ownership is read from the pid in the directory name, not from "was the
 * environment variable already set". The Vitest config sets that variable
 * before the global setup file is loaded, so an "already set" check would
 * make the top-level run believe it had inherited its own directory and
 * never clean it up. The pid is the same answer whichever module asks
 * first.
 */
function isOwnedBy(root: string, pid: number): boolean {
  return RUN_DIR_PATTERN.exec(root)?.[1] === String(pid);
}

/**
 * Resolve the temporary root for a test run.
 *
 * `owned` is the part that matters. A nested Vitest run inherits the
 * parent's root through the environment, and its teardown must NOT delete
 * that directory: the parent is still using it, and the parent's own
 * teardown removes it when the parent finishes. Removing an inherited root
 * deletes the enclosing run's fixtures mid-flight — measured on this host:
 * a nested run wiped the parent's fixture file.
 *
 * The root travels in the environment because the process that sets it
 * (the Vitest main process) is not the process that runs the tests (a
 * worker has a different pid).
 *
 * It lives in the system temp dir and NOT inside the repository: a fixture
 * created under the run root is walked upwards by `resolveInstallRoot`, and
 * from inside a Memphis checkout that walk finds the checkout and resolves
 * where the test expects the discovery to miss. Two tests depend on that
 * miss — install-root and service.command.
 */
export function resolveTestTmpRoot(inherited: string | undefined, pid: number): TestTmpRoot {
  const trimmed = inherited?.trim();
  if (trimmed) {
    // Inherited from an enclosing run: use it, but only its owner removes it.
    return { root: trimmed, owned: isOwnedBy(trimmed, pid) };
  }
  return { root: join(realTmpdir(), `memphis-test-run-${pid}`), owned: true };
}

const resolved = resolveTestTmpRoot(process.env[TEST_TMP_ROOT_ENV], process.pid);

export const TEST_TMP_ROOT: string = resolved.root;
export const TEST_TMP_ROOT_OWNED: boolean = resolved.owned;
