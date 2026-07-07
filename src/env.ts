/** Env with repo-scoped GIT_* variables stripped. Inside receive hooks git
 *  exports GIT_DIR=. (and, pre-receive, a quarantine path), which silently
 *  repoints any `git -C <other-repo>` — or a bare `git config` — at the hook's
 *  own repo: the "fatal: not a git repository: '.'" / wrong-config class.
 *  Every subprocess that targets an explicit repo path must use this env. */
export function repoScopedCleanEnv(): Record<string, string> {
  const STRIP =
    /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|QUARANTINE_PATH|COMMON_DIR|NAMESPACE|PREFIX|IMPLICIT_WORK_TREE)$/
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || STRIP.test(k)) continue
    env[k] = v
  }
  return env
}
