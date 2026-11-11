/**
 * @failure A Yrd round stores every identical git output twice (33388: ~56% of round bytes), or a dedup loses or
 *          corrupts a recorded artifact.
 * @level l1
 * @consumer @i/4-supervision/27335-streamline-host-resources/33388-yrd-log-tree-grows-net
 * @reach fs-walk <fixture-only: the temporary run's git output folder>
 * @testonly none
 */
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { GitInvocation } from "../src/git.ts"
import { openLog, readRunLog } from "../src/log.ts"

function capture(log: ReturnType<typeof openLog>, stdout: string, stderr = "") {
  const sink = log.openGitOutput({} as GitInvocation)
  if (stdout.length > 0) sink.onOutput({ stream: "stdout", chunk: Buffer.from(stdout) })
  if (stderr.length > 0) sink.onOutput({ stream: "stderr", chunk: Buffer.from(stderr) })
  sink.close()
  return sink
}

describe("a run's identical git outputs share one file (33388)", () => {
  it("links an identical closed output to the first, keeps different bytes apart, and every path reads its bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-dedup-"))
    const log = openLog(join(root, "logs"))
    const tree = "100644 blob abc\tpath/one\n".repeat(200)
    const first = capture(log, tree)
    const second = capture(log, tree)
    const other = capture(log, `${tree}extra\n`)
    expect(statSync(second.stdout).ino).toBe(statSync(first.stdout).ino)
    expect(statSync(first.stdout).nlink).toBe(2)
    expect(statSync(other.stdout).ino).not.toBe(statSync(first.stdout).ino)
    for (const sink of [first, second]) expect(readFileSync(sink.stdout, "utf8")).toBe(tree)
    expect(readFileSync(other.stdout, "utf8")).toBe(`${tree}extra\n`)
    // Empty stderr files are never linked to one another, and no temporary link is left behind.
    expect(statSync(second.stderr).ino).not.toBe(statSync(first.stderr).ino)
    expect(readdirSync(join(root, "logs", log.id, "git")).filter((name) => name.includes(".link-"))).toEqual([])
  })

  it("keeps the written copy and journals a warning when the link cannot be made", () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-dedup-"))
    const log = openLog(join(root, "logs"))
    const first = capture(log, "same bytes\n")
    // The second output's folder refuses new names, so the temporary link fails after the file is written.
    const gitDirectory = join(root, "logs", log.id, "git")
    const sink = log.openGitOutput({} as GitInvocation)
    sink.onOutput({ stream: "stdout", chunk: Buffer.from("same bytes\n") })
    chmodSync(gitDirectory, 0o555)
    try {
      sink.close()
    } finally {
      chmodSync(gitDirectory, 0o755)
    }
    expect(statSync(sink.stdout).ino).not.toBe(statSync(first.stdout).ino)
    expect(readFileSync(sink.stdout, "utf8")).toBe("same bytes\n")
    const warnings = readRunLog(join(root, "logs"), log.id).filter((record) => record.kind === "warning")
    expect(warnings).toEqual([
      expect.objectContaining({ subject: "git-output-dedup", reason: expect.stringContaining(sink.stdout) }),
    ])
  })
})
