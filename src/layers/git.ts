// Thin git-spawn helpers for effect handlers (spec § enforcement floor,
// § How it's built — effects execute real git via hosts). These sit at the
// filesystem boundary: pure reducers never call them; only async effect
// handlers do. Every helper is fail-loud — a caller that needs a guarantee
// (worktree created, tree clean) throws with git's own stderr, never a
// silent fallback (principles § Fail Loud, Fail Now).

import { spawn } from "node:child_process"
import { repoScopedCleanEnv } from "../env.ts"

export { repoScopedCleanEnv } from "../env.ts"

export type GitResult = { code: number; stdout: string; stderr: string }

/** Run git, capturing stdout/stderr/exit code. Never throws on nonzero — the
 *  caller decides whether a nonzero exit is fatal (fail-loud is the caller's).
 *  A spawn error (git missing, ENOENT) DOES reject: that is a broken host, not
 *  a git verdict. Uses node:child_process (Bun implements it) so the same code
 *  runs under the Bun binary and the Node-based test harness alike. */
export async function git(args: string[], cwd?: string): Promise<GitResult> {
  return await new Promise<GitResult>((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: repoScopedCleanEnv() })
    let stdout = ""
    let stderr = ""
    child.stdout!.on("data", (chunk) => (stdout += chunk))
    child.stderr!.on("data", (chunk) => (stderr += chunk))
    child.on("error", (err) => reject(new Error(`bay: failed to spawn git ${args.join(" ")}: ${err.message}`)))
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

/** origin/main if the ref exists, else HEAD (spec: bays branch off the current
 *  mainline; a fresh repo with no remote falls back to its own HEAD). */
export async function resolveBaseRef(repo: string): Promise<string> {
  const res = await git(["-C", repo, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], repo)
  return res.code === 0 ? "origin/main" : "HEAD"
}

/** `git worktree add -b <branch> <path> <baseRef>` — throws the literal git
 *  stderr on failure (a stale gitlink, an existing path, a taken branch all
 *  surface verbatim, per design law 7 "name the remedy"). */
export async function worktreeAdd(
  repo: string,
  branch: string,
  path: string,
  baseRef: string,
): Promise<void> {
  const res = await git(["-C", repo, "worktree", "add", "-b", branch, path, baseRef], repo)
  if (res.code !== 0) {
    throw new Error(`bay: git worktree add failed (exit ${res.code}):\n${res.stderr.trim()}`)
  }
}

/** The provisioned bay's HEAD commit — the changeset's baseSha for this repo. */
export async function headSha(path: string): Promise<string> {
  const res = await git(["-C", path, "rev-parse", "HEAD"], path)
  if (res.code !== 0) {
    throw new Error(`bay: git rev-parse HEAD failed at ${path} (exit ${res.code}):\n${res.stderr.trim()}`)
  }
  return res.stdout.trim()
}

/** Porcelain status of a worktree — empty string means clean. Used to guard
 *  retire: the loan closes without destroying uncommitted work (spec law 5). */
export async function porcelainStatus(path: string): Promise<string> {
  const res = await git(["-C", path, "status", "--porcelain"], path)
  if (res.code !== 0) {
    throw new Error(`bay: git status failed at ${path} (exit ${res.code}):\n${res.stderr.trim()}`)
  }
  return res.stdout.trim()
}

/** `git worktree remove --force <path>` — only ever called after a clean check;
 *  --force is for locked/submodule-bearing (but clean) worktrees, never to
 *  discard work. Throws the literal stderr on failure. */
export async function worktreeRemove(repo: string, path: string): Promise<void> {
  const res = await git(["-C", repo, "worktree", "remove", "--force", path], repo)
  if (res.code !== 0) {
    throw new Error(`bay: git worktree remove failed (exit ${res.code}):\n${res.stderr.trim()}`)
  }
}

/** Resolve a ref to its commit sha (fail-loud). Used for the lease baseSha
 *  (the resolved base ref) and the abandon snapshot (a branch tip). */
export async function revParse(repo: string, ref: string): Promise<string> {
  const res = await git(["-C", repo, "rev-parse", ref], repo)
  if (res.code !== 0) {
    throw new Error(`bay: git rev-parse ${ref} failed at ${repo} (exit ${res.code}):\n${res.stderr.trim()}`)
  }
  return res.stdout.trim()
}

/** `git update-ref <ref> <sha>` — writes a findability ref (fail-loud). Abandon
 *  snapshots the branch tip here so the work is discoverable after the worktree
 *  is gone; the branch itself is never deleted. */
export async function updateRef(repo: string, ref: string, sha: string): Promise<void> {
  const res = await git(["-C", repo, "update-ref", ref, sha], repo)
  if (res.code !== 0) {
    throw new Error(`bay: git update-ref ${ref} failed (exit ${res.code}):\n${res.stderr.trim()}`)
  }
}

/** Point remote <name> at <url>, creating it if missing. `remote add` is tried
 *  first; an "already exists" failure falls back to `remote set-url` (both
 *  fail-loud on any other error). Idempotent by design — re-provisioning or a
 *  second worktree sharing the repo config both land on the same url. */
export async function ensureRemote(repo: string, name: string, url: string): Promise<void> {
  const add = await git(["-C", repo, "remote", "add", name, url], repo)
  if (add.code === 0) return
  if (/already exists/i.test(add.stderr)) {
    const setUrl = await git(["-C", repo, "remote", "set-url", name, url], repo)
    if (setUrl.code !== 0) {
      throw new Error(`bay: git remote set-url ${name} failed (exit ${setUrl.code}):\n${setUrl.stderr.trim()}`)
    }
    return
  }
  throw new Error(`bay: git remote add ${name} failed (exit ${add.code}):\n${add.stderr.trim()}`)
}

/** `git config <key> <value>` in a repo/worktree (fail-loud). */
export async function setConfig(repo: string, key: string, value: string): Promise<void> {
  const res = await git(["-C", repo, "config", key, value], repo)
  if (res.code !== 0) {
    throw new Error(`bay: git config ${key} failed (exit ${res.code}):\n${res.stderr.trim()}`)
  }
}
