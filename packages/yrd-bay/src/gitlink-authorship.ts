/**
 * One definition of "the changes this branch authored", shared by the queue's
 * composition gate and the CLI's pre-admission gate.
 *
 * A branch's authored delta is measured from where it actually diverged —
 * `git merge-base <base> <head>`, computed live at check time — never from a
 * base recorded on the PR. A recorded base moves on its own: it is set at
 * `pr create`, re-set at recut, and chased forward to track current main while
 * the author's head stays exactly where they left it. Diffing that field
 * against the head therefore reports every pin that moved on main as if this
 * branch had authored it, and refuses the branch for a gitlink it never touched.
 *
 * Both gates ask the same question, so they compute it the same way.
 */

export type GitlinkAuthorshipGit = (
  repo: string,
  args: readonly string[],
) => Promise<Readonly<{ code: number; stdout: string; stderr: string }>>

export type AuthoredDeltaBase =
  | Readonly<{ status: "resolved"; sha: string }>
  | Readonly<{ status: "unreadable"; detail: string }>

/**
 * The commit a branch's own changes are measured from: the merge base of the
 * current base and the branch head. `base` is whatever names the authoritative
 * base where the caller stands — `HEAD` on the queue's composing branch, the
 * base branch ref in a client checkout.
 */
export async function authoredDeltaBase(
  git: GitlinkAuthorshipGit,
  repo: string,
  base: string,
  headSha: string,
): Promise<AuthoredDeltaBase> {
  const result = await git(repo, ["merge-base", base, headSha])
  const sha = result.stdout.trim()
  if (result.code !== 0 || sha === "") {
    return { status: "unreadable", detail: result.stderr.trim() || result.stdout.trim() || "no merge base" }
  }
  return { status: "resolved", sha }
}
