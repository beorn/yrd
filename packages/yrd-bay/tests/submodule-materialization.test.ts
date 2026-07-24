/**
 * @failure Bay provisioning serializes one config-locking `submodule init` process per path.
 * @level l2
 * @consumer @yrd/bay materializeSubmodules
 */
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
})
