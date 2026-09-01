/**
 * @failure `submitRefRetirementCommand` used to print a bare
 * `git push bay :refs/yrd/submit/<branch>`. Git treats deleting an ABSENT ref
 * as SUCCESS — no error, exit 0 — so that command silently no-opped for any
 * branch whose real standing fact was not that exact ref: measured live, a
 * derived-lane withdraw refusal named this shape for a branch whose actual
 * fact lived under a different namespace entirely, and an operator who ran
 * the "cure" got a clean exit and a row that stayed live
 * (@i/10-yrd/a-cure-string-names-a-ref-that-does-not-exist).
 *
 * @level l1
 * @consumer @yrd/queue `submitRefRetirementCommand` — the one function every
 *   refusal, warn row and sweep directive calls to print this cure, so its
 *   own correctness is exactly what this file proves end to end: not just
 *   that the returned STRING looks right, but that running it through a real
 *   shell against a real git remote does what it claims and never lies.
 *
 * Both controls run the printed string through `sh -c` exactly as an
 * operator would paste it — not a reimplementation of what it "should" do.
 */
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemove } from "removely"
import { afterEach, describe, expect, it } from "vitest"
import { submitRefRetirementCommand } from "../src/derived-admission.ts"

const ENV = {
  GIT_AUTHOR_NAME: "Yrd Test",
  GIT_AUTHOR_EMAIL: "yrd@example.invalid",
  GIT_COMMITTER_NAME: "Yrd Test",
  GIT_COMMITTER_EMAIL: "yrd@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
} as const

async function run(
  cwd: string,
  argv: readonly string[],
): Promise<Readonly<{ code: number; stdout: string; stderr: string }>> {
  const child = Bun.spawn(argv as string[], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...ENV } })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

/** Run the exact string `submitRefRetirementCommand` returns, through a real
 * shell, from `cwd` — precisely how an operator would paste it into a
 * terminal sitting in a clone that has `bay` configured as a remote. */
async function runCure(cwd: string, command: string): ReturnType<typeof run> {
  return run(cwd, ["sh", "-c", command])
}

describe("submitRefRetirementCommand — the printed cure, executed for real", () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => safeRemove(root, { within: tmpdir(), allowMissing: true })))
  })

  /** A bare `bay`-shaped remote plus a clone that already has it configured
   * under the exact remote name `submitRefRetirementCommand` prints
   * (`RECEIVER_REMOTE_NAME`), so the printed command runs unmodified. */
  async function makeReceiverAndClone(): Promise<Readonly<{ receiver: string; clone: string }>> {
    const root = await mkdtemp(join(tmpdir(), "yrd-submit-ref-retirement-cmd-"))
    roots.push(root)
    const receiver = join(root, "bay.git")
    const clone = join(root, "clone")
    expect((await run(root, ["git", "init", "-q", "--bare", "-b", "main", receiver])).code).toBe(0)
    expect((await run(root, ["git", "init", "-q", "-b", "main", clone])).code).toBe(0)
    await Bun.write(join(clone, "base.txt"), "base\n")
    expect((await run(clone, ["git", "add", "--", "base.txt"])).code).toBe(0)
    expect((await run(clone, ["git", "commit", "-q", "-m", "chore: base"])).code).toBe(0)
    expect((await run(clone, ["git", "remote", "add", "bay", receiver])).code).toBe(0)
    expect((await run(clone, ["git", "push", "-q", "bay", "main"])).code).toBe(0)
    return { receiver, clone }
  }

  it("NEGATIVE CONTROL: an absent ref refuses loudly, names the branch, and deletes nothing", async () => {
    const { receiver, clone } = await makeReceiverAndClone()
    const branch = "issue/never-submitted"
    const command = submitRefRetirementCommand(branch)

    expect(command, "the printed ref path is the one this receiver mints").toContain(
      `refs/yrd/submit/${branch}`,
    )

    const before = await run(clone, ["git", "ls-remote", "bay", `refs/yrd/submit/${branch}`])
    expect(before.stdout, "nothing stands under this name before the cure runs").toBe("")

    const result = await runCure(clone, command)

    // The exact contract: never a clean exit that changed nothing.
    expect(result.code, "an absent ref must refuse, never report success").not.toBe(0)
    expect(result.stderr).toContain(`no submit ref found for '${branch}'; nothing to retire`)

    const after = await run(clone, ["git", "ls-remote", "bay", `refs/yrd/submit/${branch}`])
    expect(after.stdout, "still nothing — the refusal did not fabricate or touch anything").toBe("")
  })

  it("POSITIVE CONTROL: a real standing ref is the one the cure finds and retires", async () => {
    const { receiver, clone } = await makeReceiverAndClone()
    const branch = "issue/sop-sherif-sort-recut"
    const command = submitRefRetirementCommand(branch)

    // Mint the ref exactly the way the receiver's own writeSubmitRefForCarrier
    // does (yrd-bay/src/receiver.ts): update-ref under SUBMIT_REF_PREFIX at
    // the branch's tip. This is the fixture's only privileged step — proving
    // the CURE finds and removes a ref planted independently of it.
    const tip = (await run(clone, ["git", "rev-parse", "HEAD"])).stdout
    expect((await run(receiver, ["git", "update-ref", `refs/yrd/submit/${branch}`, tip])).code).toBe(0)

    const before = await run(clone, ["git", "ls-remote", "bay", `refs/yrd/submit/${branch}`])
    expect(before.stdout, "the receiver really holds this ref before the cure runs").toContain(
      `refs/yrd/submit/${branch}`,
    )

    const result = await runCure(clone, command)
    expect(result.code, result.stderr).toBe(0)

    const after = await run(clone, ["git", "ls-remote", "bay", `refs/yrd/submit/${branch}`])
    expect(after.stdout, "ls-remote on the receiver now returns nothing for this ref — genuinely retired").toBe("")
  })
})
