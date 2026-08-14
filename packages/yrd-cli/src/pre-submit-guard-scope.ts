/**
 * Which of a candidate's changed files a pre-submit guard is about — the pure
 * half, so the rule can be tested against literals instead of a booted host.
 *
 * A guard exists to refuse in the second it takes to spawn one process, so the
 * decision NOT to spawn it has to be just as cheap and just as explicit. A
 * guard that declares `paths` is asking a question about a subset of the tree;
 * when the candidate touches nothing in that subset there is no question to
 * ask, and running the command anyway is how a repository-wide authoring lint
 * becomes a tax on every code-only carrier.
 *
 * The globs are matched against repository-relative POSIX paths exactly as
 * `git diff --name-only` emits them. `Bun.Glob` treats `**` as crossing
 * directory separators and a bare `*` as not crossing them, which is the
 * behaviour a `.gitignore`-literate author already expects.
 *
 * NO SILENT ERRORS: an empty changed-path list is a real answer (the candidate
 * changed nothing) and a guard with no declared paths always runs. Neither is
 * inferred from a failed diff — resolving the diff is the caller's job, and a
 * diff that could not be computed must raise there rather than arriving here
 * disguised as "nothing matched".
 */
import { Glob } from "bun"

/**
 * The changed paths a guard's declared globs select, in the order git listed
 * them. An empty result means the guard has nothing to look at.
 *
 * `globs` is required and must be non-empty: "no declared scope" is the
 * caller's `undefined`, and collapsing that into an empty glob list here would
 * silently turn an unscoped, always-run guard into one that never runs.
 */
export function guardScopedPaths(changed: readonly string[], globs: readonly string[]): readonly string[] {
  if (globs.length === 0) {
    throw new Error("yrd: a declared guard scope needs at least one path glob")
  }
  const matchers = globs.map((pattern) => new Glob(pattern))
  return changed.filter((path) => matchers.some((matcher) => matcher.match(path)))
}
