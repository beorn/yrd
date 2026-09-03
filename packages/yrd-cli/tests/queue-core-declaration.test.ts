/**
 * @failure  The question "is there a queue here" was answered by a `remote:`
 *           line, read TWICE and by two different readers: a regex for
 *           `^remote:` decided the command belonged here, and the YAML parser
 *           two lines later decided what it said. A `.yrd.yml` that names
 *           `remote:` and does not parse passed the first and lost everything
 *           to the second, so the command went on against origin/main — a guess
 *           about which queue this repository belongs to — with the parse
 *           problem said once at debug level, which nobody runs at.
 * @level    l2 (`coreQueueCommand` driven directly against a real directory;
 *           the reading runs before any git does, so no repository is needed)
 * @consumer every seat and the service, which must be told their declaration is
 *           unreadable rather than left to guess from a silent default
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { coreQueueCommand } from "../src/queue-core-commands.ts"
import type { YrdCliIO } from "../src/types.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

function capture(): Readonly<{ io: YrdCliIO; stderr(): string }> {
  let stderr = ""
  return { io: { color: false, stderr: (text) => void (stderr += text), stdout: () => {} }, stderr: () => stderr }
}

/** A directory holding one `.yrd.yml`, which is all this reads. */
function declaring(text: string): string {
  const root = declaringNothing()
  writeFileSync(join(root, ".yrd.yml"), text)
  return root
}

/** A directory with no declaration at all, and none above it: the walk stops
 * at a `.git`, so this is a repository root that declares nothing. Without the
 * `.git` the walk would climb out of the temp directory and read whatever
 * `.yrd.yml` stands above it, which on this host is yrd's own. */
function declaringNothing(): string {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-declaration-"))
  roots.push(root)
  mkdirSync(join(root, ".git"))
  return root
}

describe("a queue is a branch whose commit carries a declaration that parses", () => {
  it("a declaration naming remote: that does not parse says so, naming the file, and never goes quiet", async () => {
    const root = declaring("remote: origin\nchecks: [{\n")
    const run = capture()

    // Whatever the command then fails on is beside the point: the file was
    // unreadable and the operator was told, rather than judged against a guess.
    await coreQueueCommand(root, run.io, { command: "list" }).catch(() => undefined)

    expect(run.stderr()).toContain(join(root, ".yrd.yml"))
    expect(run.stderr()).toContain("does not parse")
  })

  it("no declaration here refuses, naming the command and where it looked", async () => {
    const root = declaringNothing()
    const run = capture()

    const exit = await coreQueueCommand(root, run.io, { command: "list" })

    expect(exit).toBe(2)
    expect(run.stderr()).toContain("queue list needs a queue")
    expect(run.stderr()).toContain(root)
  })

  it("a declaration that names no remote: is NOT refused for that: the key is optional", async () => {
    // `remote:` used to be the switch that chose this core over the incumbent,
    // so a repository that declared everything else and not that line was told
    // it had no queue. The incumbent is gone; the key defaults to `origin`.
    const root = declaring("target: main\n")
    const run = capture()

    // Whatever it then fails on is git's business: this directory is no
    // repository. What it must not say is that there is no queue here.
    await coreQueueCommand(root, run.io, { command: "list" }).catch(() => undefined)

    expect(run.stderr()).not.toContain("needs a queue")
  })

  it("POSITIVE CONTROL: a declaration that parses says nothing about parsing", async () => {
    // Without this, the line above is satisfied just as well by a switch that
    // complains about every declaration it is handed.
    const root = declaring("remote: origin\n")
    const run = capture()

    await coreQueueCommand(root, run.io, { command: "list" }).catch(() => undefined)

    expect(run.stderr()).not.toContain("does not parse")
  })
})
