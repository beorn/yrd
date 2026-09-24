/**
 * @failure A read of ONE remote ref asked for the remote's whole advertisement: `git ls-remote
 *          <remote> <ref>` filters its patterns on the client, so the server sent every ref it
 *          holds (11,382 on hh-dev's origin, 2026-09-24) for each moved submodule of every submit
 *          and for the publication marker of every landing (25570).
 * @level   l2 (real repositories behind a PATH git that records every command)
 * @consumer yrd submit (gitlink retention) and the queue's child publication
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitIn } from "../src/git.ts"
import { publishCheckedChildren } from "../src/publication.ts"
import { publishMovedGitlinks, retentionRef } from "../src/submit.ts"

const roots: string[] = []
const author = ["-c", "user.email=exact-reads@yrd.test", "-c", "user.name=yrd"] as const

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

/**
 * A scratch root whose `bin/git` records each command line in `commands.log`, then runs git; a
 * fetch also traces its packets to `fetch-packets.log`, so a test counts the refs a server advertised.
 */
async function recordingGit(): Promise<
  Readonly<{ root: string; commands: () => string[]; fetchAdvertised: () => number }>
> {
  const root = mkdtempSync(join(tmpdir(), "yrd-exact-reads-"))
  roots.push(root)
  const real = (await gitIn(root)(["--exec-path"])).trim()
  const log = join(root, "commands.log")
  const packets = join(root, "fetch-packets.log")
  mkdirSync(join(root, "bin"))
  writeFileSync(
    join(root, "bin", "git"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${log}'`,
      `case " $* " in *" fetch "*) GIT_TRACE_PACKET='${packets}'; export GIT_TRACE_PACKET;; esac`,
      `exec '${join(real, "git")}' "$@"`,
      "",
    ].join("\n"),
  )
  chmodSync(join(root, "bin", "git"), 0o755)
  writeFileSync(log, "")
  writeFileSync(packets, "")
  // The root Vitest project seals PATH before each test, so this runs inside the test body.
  process.env.PATH = `${join(root, "bin")}:${process.env.PATH ?? ""}`
  return {
    root,
    commands: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== ""),
    fetchAdvertised: () =>
      readFileSync(packets, "utf8")
        .split("\n")
        .filter((line) => /packet:.*< [0-9a-f]{40} refs\//u.test(line)).length,
  }
}

async function commitFile(dir: string, file: string): Promise<string> {
  const git = gitIn(dir)
  writeFileSync(join(dir, file), `${file}\n`)
  await git(["add", "--all"])
  await git([...author, "commit", "--quiet", "--message", `add ${file}`])
  return (await git(["rev-parse", "HEAD"])).trim()
}

/** A bare remote that advertises `count` task branches beside `main`. */
async function crowdedRemote(root: string, name: string, count: number): Promise<string> {
  const seed = join(root, `${name}-seed`)
  mkdirSync(seed)
  const git = gitIn(seed)
  await git(["init", "--quiet", "--initial-branch=main"])
  await commitFile(seed, `${name}.txt`)
  for (let index = 0; index < count; index++) await git(["branch", `task/crowd-${String(index)}`])
  const remote = join(root, `${name}.git`)
  await gitIn(root)(["clone", "--quiet", "--bare", seed, remote])
  return remote
}

describe("one remote ref is read by name, never from the whole advertisement", () => {
  it("submit publishes, then retains, a moved gitlink with no ls-remote of the submodule's remote", async () => {
    const recording = await recordingGit()
    const dependency = await crowdedRemote(recording.root, "dep", 40)
    const work = join(recording.root, "work")
    mkdirSync(work)
    const git = gitIn(work)
    await git(["init", "--quiet", "--initial-branch=main"])
    await git(["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", dependency, "vendor/dep"])
    await git([...author, "commit", "--quiet", "--message", "add vendor/dep"])
    const from = (await git(["rev-parse", "HEAD"])).trim()
    const pin = await commitFile(join(work, "vendor/dep"), "moved.txt")
    await git(["add", "vendor/dep"])
    await git([...author, "commit", "--quiet", "--message", "move vendor/dep"])
    const to = (await git(["rev-parse", "HEAD"])).trim()

    const first = await publishMovedGitlinks(git, work, from, to)
    const again = await publishMovedGitlinks(git, work, from, to)

    expect(first.map(({ sha, state }) => ({ sha, state }))).toEqual([{ sha: pin, state: "published" }])
    expect(again.map(({ sha, state }) => ({ sha, state }))).toEqual([{ sha: pin, state: "retained" }])
    expect((await gitIn(dependency)(["rev-parse", retentionRef(pin)])).trim()).toBe(pin)
    expect(recording.commands().filter((line) => line.startsWith("ls-remote"))).toEqual([])
    // The first read finds no pin (nothing advertised), the second finds the one just pushed.
    expect(recording.fetchAdvertised()).toBe(1)
  }, 60_000)

  it("the publication marker is read by name: a moved or absent marker still refuses, with no ls-remote", async () => {
    const recording = await recordingGit()
    const remote = await crowdedRemote(recording.root, "root", 40)
    const work = join(recording.root, "root-work")
    await gitIn(recording.root)(["clone", "--quiet", remote, work])
    const git = gitIn(work)
    const tip = (await git(["rev-parse", "HEAD"])).trim()
    const marker = "refs/yrd/main/changes/task/landing"
    await git(["push", "--quiet", "origin", `${tip}:${marker}`])
    const other = await commitFile(work, "other.txt")

    const publish = (ref: string) =>
      publishCheckedChildren({
        git,
        cwd: work,
        candidate: tip,
        remote: "origin",
        branch: "main",
        marker: { ref, tip: other },
      })

    await expect(publish(marker)).rejects.toThrow(
      `publication marker origin ${marker}: expected ${other}, found ${tip}`,
    )
    await expect(publish("refs/yrd/main/changes/task/absent")).rejects.toThrow(
      `publication marker origin refs/yrd/main/changes/task/absent: expected ${other}, found absent`,
    )
    expect(recording.commands().filter((line) => line.startsWith("ls-remote"))).toEqual([])
    // The present marker is the one ref advertised; the absent one advertises none.
    expect(recording.fetchAdvertised()).toBe(1)
  }, 60_000)
})
