/**
 * @failure A `git push bay HEAD:refs/for/main/<issue>` minted change PR2081,
 * and read surfaces (`yrd pr view`) asked the GitHub origin about the
 * receiver-minted `issue/…` carrier: origin answered an authoritative "absent"
 * about a branch it never hosted, and the view refused a perfectly live
 * change (@i/10-merge-queue/refsfor-withdrawn-carrier). The store, not
 * origin, owns a receiver-minted branch. (The habitant's tracked-observation
 * pass — the arm that WITHDREW the change outright — is retired with the
 * change-record store; branch-is-change, @i/10 22991: a re-push is the fresh
 * submission, so no observation sweep re-judges liveness.)
 * @level l2
 * @consumer `yrd pr view`
 *
 * Drives the REAL observation arm: no `io.pruneGit`, a real repository with a
 * real origin AND a real receiver store at `<git-common-dir>/yrd/prs.git`, and
 * the installed `@yrd/process`.
 */
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createProcess } from "@yrd/process"
import { observeLiveBranch } from "../src/remote-branch.ts"

/** The live incident's shape: a carrier the refs/for push named after its issue. */
const CARRIER = "issue/@i/10-merge-queue/22991-branch-is-change-delete-the-pr-record"

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: {
      ...Bun.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString() || result.stdout.toString()}`)
  }
  return result.stdout.toString().trim()
}

/**
 * A real repository whose `origin` carries ONLY `main`, whose receiver store at
 * `.git/yrd/prs.git` owns the refs/for-minted carrier as its accepted
 * `refs/yrd/submit/<branch>` approval, and whose local `refs/heads/<carrier>`
 * is the intake-materialized carrier — the exact post-push state PR2081 was
 * refused from.
 */
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "yrd-receiver-store-observation-"))
  const origin = join(root, "origin.git")
  const repo = join(root, "repo")
  await git(root, ["init", "-q", "--bare", "origin.git"])
  await git(root, ["init", "-q", "-b", "main", "repo"])
  const commit = async (file: string, message: string): Promise<string> => {
    await Bun.write(join(repo, file), `${file}\n`)
    await git(repo, ["add", "--", file])
    await git(repo, ["commit", "-q", "-m", message])
    return git(repo, ["rev-parse", "HEAD"])
  }
  const mainSha = await commit("base.txt", "base")
  await git(repo, ["remote", "add", "origin", origin])
  await git(repo, ["push", "-q", "origin", "main"])

  // The receiver-minted carrier: real content, materialized as a local branch
  // (what `materializeCarrier` does at intake), never pushed to origin.
  await git(repo, ["checkout", "-q", "-b", CARRIER])
  const carrierHead = await commit("carrier.txt", "refs/for payload")

  // The receiver store, at the layout `discoverYrdRepository` names, owning the
  // carrier as its accepted submit ref — the refs/for mint's store-side fact.
  const store = join(repo, ".git", "yrd", "prs.git")
  await git(root, ["init", "-q", "--bare", store])
  await git(repo, ["push", "-q", store, `refs/heads/${CARRIER}:refs/yrd/submit/${CARRIER}`])
  await git(repo, ["checkout", "-q", "main"])
  return { repo, mainSha, carrierHead }
}

describe("a receiver-owned carrier resolves from the store, not origin", () => {
  it("resolves the carrier for read surfaces (`pr view`) at the store's accepted head", async () => {
    // `viewPr` refuses with pr-view-branch-absent purely on this observation's
    // verdict, so the mechanism-level assertion covers the surface: a
    // store-owned branch observes ok at the store's accepted head.
    const fixture = await repository()
    await using process = createProcess({ env: { PATH: Bun.env.PATH } })
    const observed = await observeLiveBranch(process, fixture.repo, CARRIER)
    expect(observed).toEqual({
      ok: true,
      head: fixture.carrierHead,
      target: `refs/yrd/submit/${CARRIER}`,
    })
  })
})
