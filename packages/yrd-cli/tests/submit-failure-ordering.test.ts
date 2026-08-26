/**
 * @failure A failing submit's diagnostic is not the last thing on the terminal: the child check's entire buffered stdout replays to fd1 before the exit code is even tested, burying the failure line in human mode and corrupting the --json stream with raw child output.
 * @level l3
 * @consumer @yrd/cli pr submit
 *
 * host.test.ts's historical accumulators kept stdout and stderr in two
 * independent strings, so output ORDER was unrepresentable — that harness gap
 * is why this failure mode had no test. These tests use the shared
 * sequence-stamped sink (tests/support/ordered-io.ts) so the interleaving is
 * part of the assertion. The existing host.test.ts submit fixtures pass only
 * because their checks write nothing to stdout.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runYrdProcess } from "../src/host.ts"
import { installDeclaredYrdEntry } from "./support/declared-yrd-entry.ts"
import { orderedOutputIO } from "./support/ordered-io.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(repo: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

/** A real repository whose one managed required check is `checkScript`. */
async function repository(checkScript: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-submit-ordering-"))
  roots.push(root)
  const repo = join(root, "repo")
  await git(root, "init", "-q", "-b", "main", repo)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await installDeclaredYrdEntry(repo)
  await writeFile(join(repo, "README.md"), "main\n")
  await writeFile(join(repo, ".yrd.yml"), `checks: [{noisy: {run: ${JSON.stringify(checkScript)}}}]\n`)
  await git(repo, "add", "README.md", ".yrd.yml", "bin/yrd")
  await git(repo, "commit", "-qm", "main")
  await git(repo, "switch", "-qc", "issue/feature")
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, "add", "feature.txt")
  await git(repo, "commit", "-qm", "feature")
  await git(repo, "switch", "-q", "main")
  return repo
}

describe("pr submit failure ordering", () => {
  it("a failing required check's diagnostic is the LAST thing written, with no raw check stdout around it", async () => {
    const repo = await repository("echo CHECK-STDOUT-NOISE; echo 'broken build detail' >&2; exit 1")
    const output = orderedOutputIO()

    const exitCode = await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "submit", "issue/feature"], {
      cwd: repo,
      ...output.io,
    })

    expect(exitCode, output.stderr()).toBe(1)
    const last = output.last()
    expect(last?.stream, "the failure diagnostic must be the final write").toBe("stderr")
    expect(output.stderr()).toContain("required check failed: 'noisy' exited 1")
    // The check already failed; replaying its entire buffered stdout to fd1
    // (before the exit code was even tested) buries the failure line under
    // check noise on a real terminal. The diagnostic carries check stderr.
    const noise = output.events.filter((event) => event.stream === "stdout" && event.text.includes("CHECK-STDOUT-NOISE"))
    expect(noise, "a failing check's raw stdout must not be replayed to fd1").toEqual([])
  })

  it("--json submit writes no raw child stdout to fd1", async () => {
    const repo = await repository("echo RAW-CHECK-NOISE")
    const output = orderedOutputIO()

    const exitCode = await runYrdProcess(
      ["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "submit", "issue/feature", "--json"],
      { cwd: repo, ...output.io },
    )

    expect(exitCode, output.stderr()).toBe(0)
    // fd1 is a machine stream under --json (output.tsx protects every other
    // path); the passing check's stdout must not corrupt it.
    expect(output.stdout(), "raw child stdout corrupts the --json stream").not.toContain("RAW-CHECK-NOISE")
    const lines = output
      .stdout()
      .split("\n")
      .filter((line) => line.trim() !== "")
    for (const line of lines) {
      expect(() => JSON.parse(line), `non-JSON bytes on fd1: ${line}`).not.toThrow()
    }
  })
})
