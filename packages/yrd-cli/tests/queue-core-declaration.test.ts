/**
 * @failure  The switch that selects this queue read the declaration TWICE and
 *           by two different readers: a regex for `^remote:` decided the
 *           command belonged here, and the YAML parser two lines later decided
 *           what it said. A `.yrd.yml` that names `remote:` and does not parse
 *           passed the first and lost everything to the second, so the command
 *           went on against origin/main — a guess about which queue this
 *           repository belongs to — with the parse problem said once at debug
 *           level, which nobody runs at.
 * @level    l2 (`coreQueueCommand` driven directly against a real directory;
 *           the switch runs before any git does, so no repository is needed)
 * @consumer every seat and the service, which must be told their declaration is
 *           unreadable rather than left to guess from a silent default
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

/** A directory holding one `.yrd.yml`, which is all the switch reads. */
function declaring(text: string): string {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-declaration-"))
  roots.push(root)
  writeFileSync(join(root, ".yrd.yml"), text)
  return root
}

describe("the declaration that selects this queue is the parsed one", () => {
  it("a declaration naming remote: that does not parse says so, naming the file, and never goes quiet", async () => {
    const root = declaring("remote: origin\nchecks: [{\n")
    const run = capture()

    // Whatever the command then fails on is beside the point: the file was
    // unreadable and the operator was told, rather than judged against a guess.
    await coreQueueCommand(root, run.io, { command: "list" }).catch(() => undefined)

    expect(run.stderr()).toContain(join(root, ".yrd.yml"))
    expect(run.stderr()).toContain("does not parse")
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
