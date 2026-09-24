/**
 * @failure The host's mirror store is refreshed by nothing an operator can run or read, so an aged
 *          or missing mirror is found only when a compose refuses on it.
 * @level   l2 (real repositories through the command's own entry point)
 * @consumer the operator, the round's refresh (slice 2) and 25567's service, which runs the same verb
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gitIn } from "@yrd/queue-core"
import { afterAll, describe, expect, it } from "vitest"
import { refreshMirrors } from "../src/mirror-commands.ts"
import type { YrdCliIO } from "../src/types.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

const author = ["-c", "user.email=mirror@yrd.test", "-c", "user.name=yrd"] as const

function capture(cwd: string): YrdCliIO & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { cwd, out, err, stdout: (text) => out.push(text), stderr: (text) => err.push(text) }
}

/** A product declaring one hosted child, where the hosted URL is a local bare repository. */
async function product(): Promise<Readonly<{ root: string; repo: string }>> {
  const root = mkdtempSync(join(tmpdir(), "yrd-mirror-cli-"))
  roots.push(root)
  const upstream = join(root, "upstream", "beorn")
  mkdirSync(upstream, { recursive: true })
  // Scoped to this file's process: the command reads the caller's environment, as it would on the host.
  process.env.GIT_SSH_COMMAND = "false"
  // The host running the suite may declare its own store; only this repository's setting may count.
  process.env.GIT_CONFIG_GLOBAL = "/dev/null"
  process.env.GIT_CONFIG_NOSYSTEM = "1"
  process.env.GIT_CONFIG_COUNT = "2"
  process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
  process.env.GIT_CONFIG_VALUE_0 = "always"
  process.env.GIT_CONFIG_KEY_1 = `url.file://${upstream}/.insteadOf`
  process.env.GIT_CONFIG_VALUE_1 = "git@github.com:beorn/"
  const child = join(root, "child")
  mkdirSync(child)
  const childGit = gitIn(child)
  await childGit(["init", "--quiet", "--initial-branch=main"])
  writeFileSync(join(child, "child.txt"), "child\n")
  await childGit(["add", "--all"])
  await childGit([...author, "commit", "--quiet", "--message", "child"])
  await gitIn(root)(["clone", "--quiet", "--bare", child, join(upstream, "child.git")])
  const sha = (await childGit(["rev-parse", "HEAD"])).trim()
  const repo = join(root, "product")
  mkdirSync(repo)
  const git = gitIn(repo)
  await git(["init", "--quiet", "--initial-branch=main"])
  writeFileSync(
    join(repo, ".gitmodules"),
    `[submodule "child"]\n\tpath = child\n\turl = git@github.com:beorn/child.git\n`,
  )
  await git(["update-index", "--add", "--cacheinfo", `160000,${sha},child`])
  await git(["add", ".gitmodules"])
  await git([...author, "commit", "--quiet", "--message", "declare child"])
  return { root, repo }
}

describe("yrd mirror refresh", () => {
  it("refuses, naming the setting, when this host declares no store", async () => {
    const { repo } = await product()
    const io = capture(repo)
    expect(await refreshMirrors({}, io)).toBe(1)
    expect(io.err.join("")).toContain("git config --global yrd.mirror <directory>")
    expect(io.out).toEqual([])
  })

  it("refreshes every declared mirror into the configured store and reports each one", async () => {
    const { root, repo } = await product()
    const store = join(root, "git-mirror")
    await gitIn(repo)(["config", "yrd.mirror", store])

    const io = capture(repo)
    expect(await refreshMirrors({ json: true }, io)).toBe(0)
    const report = JSON.parse(io.out.join("")) as {
      store: string
      refreshed: Array<{ path: string; outcome: string; bytes: number; refreshedAt: string }>
      skipped: unknown[]
    }
    expect(report.store).toBe(store)
    expect(report.refreshed).toMatchObject([{ path: join(store, "github.com/beorn/child.git"), outcome: "created" }])
    expect(Number.isNaN(new Date(report.refreshed[0]?.refreshedAt ?? "").getTime())).toBe(false)
    expect(report.skipped).toEqual([])

    const again = capture(repo)
    expect(await refreshMirrors({}, again)).toBe(0)
    expect(again.out.join("")).toMatch(/^fetched github\.com\/beorn\/child\.git \d+ bytes \d+ms\n$/u)
  })
})
