/**
 * @failure Bay provisioning serializes one config-locking `submodule init` process per path, and borrows objects from reference paths that may not exist in the base checkout.
 * @level l2
 * @consumer @yrd/bay materializeSubmodules
 */
import { existsSync } from "node:fs"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { materializeSubmodules, type SubmoduleGit, type SubmoduleGitResult } from "../src/submodule-materialization.ts"

const success = (): SubmoduleGitResult => ({ code: 0, stdout: "", stderr: "" })

describe("materializeSubmodules", () => {
  it("initializes every sibling path in one config mutation before updating them in parallel", async () => {
    const worktree = "/worktree"
    const paths = ["vendor/one", "vendor/two", "vendor/three"]
    const commands: Array<Readonly<{ repo: string; args: readonly string[]; mutation: boolean }>> = []
    const git: SubmoduleGit = {
      async run(repo, args) {
        commands.push({ repo, args, mutation: false })
        if (args[0] === "cat-file" && args.at(-1) === "HEAD:.gitmodules") {
          return repo === worktree ? success() : { ...success(), code: 1 }
        }
        if (args[0] === "config" && args[1] === "--blob") {
          return {
            ...success(),
            stdout: paths.map((path, index) => `submodule.module-${index}.path ${path}`).join("\n"),
          }
        }
        if (args[0] === "ls-tree") {
          const path = args.at(-1)
          return path === undefined
            ? { ...success(), code: 1 }
            : { ...success(), stdout: `160000 commit ${"a".repeat(40)}\t${path}\n` }
        }
        if (args[0] === "config" && args[1] === "--get") {
          return { ...success(), stdout: `https://example.invalid/${args[2]}.git\n` }
        }
        return success()
      },
      async mutateConfig(repo, args) {
        commands.push({ repo, args, mutation: true })
        return success()
      },
    }

    await expect(materializeSubmodules(git, { worktree })).resolves.toMatchObject({
      code: 0,
      borrowed: 0,
      remoteFallbacks: 0,
    })

    const init = commands.filter(({ args }) => args[0] === "submodule" && args[1] === "init")
    expect(init).toEqual([
      {
        repo: worktree,
        args: ["submodule", "init", "--", ...paths],
        mutation: true,
      },
    ])
    const firstUrlRead = commands.findIndex(({ args }) => args[0] === "config" && args[1] === "--get")
    const initCommand = init[0]
    if (initCommand === undefined) throw new Error("expected one batched submodule init")
    expect(commands.indexOf(initCommand)).toBeLessThan(firstUrlRead)
    expect(
      commands
        .filter(({ args }) => args.includes("update"))
        .map(({ args }) => {
          const path = args.at(-1)
          if (path === undefined) throw new Error("expected every update to name a submodule path")
          return path
        })
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(paths.toSorted((left, right) => left.localeCompare(right)))
  })

  it("falls back to the remote instead of spawning git in a reference path that is not on disk", async () => {
    // A candidate that ADDS a nested submodule names a reference path the base
    // checkout never had. Spawning git there fails in posix_spawn itself — an
    // ENOENT indistinguishable from a missing executable, which no allowFailure
    // can contain — so the only borrow decision an absent path can support is
    // "borrow nothing, fetch from the configured remote".
    const root = await mkdtemp(join(tmpdir(), "yrd-reference-borrow-"))
    const worktree = join(root, "candidate")
    const reference = join(root, "reference")
    const path = "apps/maddoc"
    const url = "https://example.invalid/maddoc.git"
    const required = "b".repeat(40)
    // The candidate carries the new submodule; the reference root exists but has
    // never contained that path.
    await mkdir(join(worktree, path), { recursive: true })
    await mkdir(reference, { recursive: true })

    const commands: Array<Readonly<{ repo: string; args: readonly string[] }>> = []
    const logs: string[] = []
    const git: SubmoduleGit = {
      async run(repo, args) {
        if (!existsSync(repo)) {
          throw Object.assign(new Error("No such file or directory"), { code: "ENOENT", syscall: "posix_spawn" })
        }
        commands.push({ repo, args })
        if (args[0] === "cat-file" && args.at(-1) === "HEAD:.gitmodules") {
          return repo === worktree ? success() : { ...success(), code: 1 }
        }
        if (args[0] === "config" && args[1] === "--blob") {
          return { ...success(), stdout: `submodule.maddoc.path ${path}` }
        }
        if (args[0] === "ls-tree") return { ...success(), stdout: `160000 commit ${required}\t${path}\n` }
        if (args[0] === "config" && args[1] === "--get") return { ...success(), stdout: `${url}\n` }
        return success()
      },
      async mutateConfig(repo, args) {
        commands.push({ repo, args })
        return success()
      },
    }

    await expect(
      materializeSubmodules(git, {
        worktree,
        referenceWorktree: reference,
        log: (message) => logs.push(message),
      }),
    ).resolves.toMatchObject({ code: 0, borrowed: 0, remoteFallbacks: 1 })

    // The absent reference path never became a spawn cwd.
    expect(commands.map(({ repo }) => repo)).not.toContain(join(reference, path))
    // …and the update carries no borrow flags, so Git resolves the gitlink from
    // the configured remote.
    const update = commands.find(({ args }) => args.includes("update"))
    expect(update?.args).toBeDefined()
    expect(update?.args).not.toContain("--reference")
    expect(update?.args.join(" ")).not.toContain("insteadOf")
    // The fallback is loud and names the absolute path that was missing.
    expect(logs.join("\n")).toContain(join(reference, path))
  })
})
