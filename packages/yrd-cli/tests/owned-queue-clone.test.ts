/**
 * @failure hh's cas-rejections reads a durable zero for the merging round because it looks for the round's lease
 *          journal somewhere other than the queue-owned clone the round composes in (hh 25626, @cto 30c9eaaa), or the
 *          lookup asks GitHub for the queue name and so adds to the session count it measures
 * @level   l1
 * @consumer hh tools/cas-rejections.ts (the merging round's journal home)
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runYrdProcess } from "../src/cli.ts"
import { ownedQueueClone, resolveQueueLocation } from "../src/queue-location.ts"
import type { YrdCliIO } from "../src/types.ts"
import { outsideRepositoryRoot } from "../../../tests/support/outside-repository.ts"

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

/**
 * The caller's environment with every Git transport refused, so "offline" is proved rather than assumed: a seat's
 * GIT_SSH_COMMAND or a url.insteadOf rewrite could otherwise let a remote read reach GitHub and pass (@dev/review2 on
 * bea4683cef). yrd's gitEnvironment keeps both variables; only its routing variables are dropped.
 */
function offlineEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, GIT_ALLOW_PROTOCOL: "none", GIT_SSH_COMMAND: "false", ...extra }
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A clone whose origin names a GitHub repository, with the real upstream gone: any remote read now fails. */
function offlineClone(): { root: string; clone: string; state: string } {
  const root = mkdtempSync(join(tmpdir(), "yrd-owned-queue-clone 'quoted-"))
  roots.push(root)
  const upstream = join(root, "upstream")
  git(root, "init", "-q", "-b", "main", upstream)
  git(upstream, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--allow-empty", "-m", "c")
  git(root, "clone", "-q", upstream, "clone")
  const clone = join(root, "clone")
  git(clone, "remote", "set-url", "origin", "git@github.com:beorn/hh-dev.git")
  renameSync(upstream, join(root, "gone"))
  return { root, clone, state: join(root, "state") }
}

describe("ownedQueueClone (hh 25626)", () => {
  it("names the queue-owned clone from local records alone, as the queue resolves it", async () => {
    const { clone, state } = offlineClone()
    const env = offlineEnv({ XDG_STATE_HOME: state })

    const owned = await ownedQueueClone(clone, env)

    expect(owned).toBe(join(state, "yrd", "github.com", "beorn", "hh-dev~main", "repo"))
    // The same address and workdir the queue's own resolver answers (its reader path clones nothing).
    const location = await resolveQueueLocation(clone, undefined, env, "reader")
    expect(owned).toBe(join(location.workdir, "repo"))
  })

  it("follows the repository's yrd.workdir, as the live service does", async () => {
    const { root, clone } = offlineClone()
    const workdir = join(root, "declared-workdir")
    git(clone, "config", "yrd.workdir", workdir)

    await expect(ownedQueueClone(clone, offlineEnv())).resolves.toBe(
      join(workdir, "github.com", "beorn", "hh-dev~main", "repo"),
    )
  })

  it("fails loud, naming the fix, when the clone records no origin/HEAD, rather than asking GitHub", async () => {
    const { root, clone, state } = offlineClone()
    git(clone, "remote", "set-head", "origin", "-d")
    const refusal = await ownedQueueClone(clone, offlineEnv({ XDG_STATE_HOME: state })).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(Error)
    expect(String(refusal)).toContain("records no refs/remotes/origin/HEAD")
    const command = /run `([^`]+)`/u.exec(String(refusal))?.[1]
    if (command === undefined) throw new Error("origin/HEAD refusal supplied no repair command")
    git(clone, "config", `url.${join(root, "gone")}.insteadOf`, "git@github.com:beorn/hh-dev.git")
    const outside = outsideRepositoryRoot()
    roots.push(outside)
    const repaired = spawnSync("/bin/sh", ["-c", command], {
      cwd: outside,
      encoding: "utf8",
      env: offlineEnv({ GIT_ALLOW_PROTOCOL: "file" }),
    })
    expect(repaired.status, repaired.stderr).toBe(0)
    expect(git(clone, "symbolic-ref", "refs/remotes/origin/HEAD")).toBe("refs/remotes/origin/main")
    await expect(ownedQueueClone(clone, offlineEnv({ XDG_STATE_HOME: state }))).resolves.toBe(
      join(state, "yrd", "github.com", "beorn", "hh-dev~main", "repo"),
    )
  })
})

describe("container repository with nested checkout (hh 30719)", () => {
  it("refuses unaddressed yrd commands in the container root before cloning or reporting ENOENT health", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-container-root-"))
    roots.push(root)
    const state = join(root, "xdg-state")
    const containerUpstream = join(root, "container-upstream")
    git(root, "init", "-q", "-b", "main", containerUpstream)
    git(
      containerUpstream,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "state",
    )
    const container = join(root, "hh")
    git(root, "clone", "-q", containerUpstream, container)
    mkdirSync(join(container, "pm"), { recursive: true })

    const devUpstream = join(root, "dev-upstream")
    git(root, "init", "-q", "-b", "main", devUpstream)
    git(devUpstream, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--allow-empty", "-m", "code")
    const dev = join(container, "dev")
    git(root, "clone", "-q", devUpstream, dev)
    git(dev, "remote", "set-url", "origin", "git@github.com:beorn/hh-dev.git")
    writeFileSync(join(dev, ".yrd.yml"), "target:\n  branch: main\n")

    const previousState = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = state
    try {
      for (const cwd of [container, join(container, "pm")]) {
        await expect(resolveQueueLocation(cwd, undefined, offlineEnv({ XDG_STATE_HOME: state }))).rejects.toThrow(
          new RegExp(
            `is inside container repository .* \\(no \\.yrd\\.yml\\), not the nested checkout .*; run from .*, or address the queue with --queue <repo>#<branch>`,
            "u",
          ),
        )
        await expect(ownedQueueClone(cwd, offlineEnv({ XDG_STATE_HOME: state }))).rejects.toThrow(
          /run from .*, or address the queue with --queue <repo>#<branch>/u,
        )

        for (const argv of [
          ["queue", "health"],
          ["queue", "list", "--json"],
          ["env", "list", "--json"],
          ["issues", "view", "30719"],
        ]) {
          let stdout = ""
          let stderr = ""
          const io: YrdCliIO = {
            localBranchProtections: null,
            color: false,
            cwd,
            stdout(text) {
              stdout += text
            },
            stderr(text) {
              stderr += text
            },
          }
          const exitCode = await runYrdProcess([process.execPath, "/usr/local/bin/yrd", ...argv], io)
          expect(exitCode, argv.join(" ")).toBe(2)
          expect(stdout, argv.join(" ")).toBe("")
          expect(stderr, argv.join(" ")).toContain(`not the nested checkout ${dev}`)
          expect(stderr, argv.join(" ")).toContain(`run from ${dev}, or address the queue with --queue <repo>#<branch>`)
        }
      }
      // Proves ensureOwnedClone never ran against the container repo's origin.
      expect(existsSync(state)).toBe(false)
      // And from the nested dev checkout itself, resolution succeeds.
      await expect(ownedQueueClone(dev, offlineEnv({ XDG_STATE_HOME: state }))).resolves.toBe(
        join(state, "yrd", "github.com", "beorn", "hh-dev~main", "repo"),
      )
    } finally {
      if (previousState === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previousState
    }
  })

  it("discovers any immediate child checkout with .git and .yrd.yml without hardcoding dev", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-container-generic-"))
    roots.push(root)
    const state = join(root, "xdg-state")
    const container = join(root, "workspace")
    git(root, "init", "-q", "-b", "main", container)

    const nested = join(container, "code-repo")
    git(root, "init", "-q", "-b", "main", nested)
    writeFileSync(join(nested, ".yrd.yml"), "target:\n  branch: main\n")

    await expect(resolveQueueLocation(container, undefined, offlineEnv({ XDG_STATE_HOME: state }))).rejects.toThrow(
      `${container} is inside container repository ${container} (no .yrd.yml), not the nested checkout ${nested}; run from ${nested}, or address the queue with --queue <repo>#<branch>`,
    )
    expect(existsSync(state)).toBe(false)
  })
})
