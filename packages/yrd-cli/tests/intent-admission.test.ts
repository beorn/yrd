/**
 * @failure  `yrd intent submit` records a pin advance without checking it, so a
 *           typo'd component, an unpushed target, or a divergent lineage is
 *           discovered at merge time instead of while the submitter's context
 *           is warm. Admission is advisory — main moves, merge time is the only
 *           authority — but advisory is not the same as absent, and a verb that
 *           accepts anything is the silent-error class.
 * @level    l2 (real git repositories with a real submodule; no fakes)
 * @consumer @yrd/core/21679-integration-model-v2/22668-admit-intents
 */
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createProcess } from "@yrd/process"
import { admitPinIntent } from "../src/intent-admission.ts"

const process = createProcess()

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await process.run({
    argv: ["git", "-c", "protocol.file.allow=always", "-C", cwd, ...args],
    cwd,
    timeoutMs: 30_000,
  })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

async function commit(cwd: string, message: string): Promise<string> {
  await git(cwd, "add", "-A")
  await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", message)
  return git(cwd, "rev-parse", "HEAD")
}

/**
 * A root repo with one real submodule at `components/alpha`, plus a bare origin
 * for the component so publication is a real fetch, not a stub.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "yrd-intent-"))
  const component = join(root, "component-src")
  const origin = join(root, "component-origin.git")
  const repo = join(root, "repo")

  await git(root, "init", "--bare", "-b", "main", origin)
  await git(root, "init", "-b", "main", component)
  await writeFile(join(component, "one.txt"), "one\n")
  const basePin = await commit(component, "one")
  await git(component, "remote", "add", "origin", origin)
  await git(component, "push", "--quiet", "origin", "main")

  await git(root, "init", "-b", "main", repo)
  await writeFile(join(repo, "README.md"), "root\n")
  await commit(repo, "root")
  await git(repo, "submodule", "add", "--quiet", origin, "components/alpha")
  await commit(repo, "add component")

  return { root, repo, component, origin, basePin }
}

/** Advance the component and publish the new tip. */
async function publish(component: string, name: string): Promise<string> {
  await writeFile(join(component, `${name}.txt`), `${name}\n`)
  const sha = await commit(component, name)
  await git(component, "push", "--quiet", "origin", "main")
  return sha
}

/** Advance the component WITHOUT pushing — the unpublished-target case. */
async function local(component: string, name: string): Promise<string> {
  await writeFile(join(component, `${name}.txt`), `${name}\n`)
  return commit(component, name)
}

/**
 * Advance on a side line and publish it to a NON-trunk ref.
 *
 * The off-trunk shape: a real commit, really published, really descended from
 * the pin — every existing precondition says yes — that the component's own
 * `main` never took.
 */
async function publishSideline(component: string, name: string, from: string): Promise<string> {
  await git(component, "checkout", "--quiet", "-b", name, from)
  await writeFile(join(component, `${name}.txt`), `${name}\n`)
  const sha = await commit(component, name)
  await git(component, "push", "--quiet", "origin", name)
  await git(component, "checkout", "--quiet", "main")
  return sha
}

describe("pin-intent admission (22668 phase 1)", () => {
  it("admits an advance and reports the current pin plus the relation", async () => {
    const { repo, component, basePin } = await fixture()
    const target = await publish(component, "two")

    const verdict = await admitPinIntent({ process, repo, base: "main", component: "components/alpha", target })

    if (!verdict.admitted) throw new Error(`unexpected refusal: ${verdict.code}`)
    expect(verdict.currentPin).toBe(basePin)
    expect(verdict.relation).toBe("advance")
  })

  it("refuses a target descended from a rollback tombstone", async () => {
    const { repo, component } = await fixture()
    const tombstoned = await publish(component, "regression")
    const target = await publish(component, "later-work")

    const verdict = await admitPinIntent({
      process,
      repo,
      base: "main",
      component: "components/alpha",
      target,
      tombstones: [{ sha: tombstoned }],
    })

    expect(verdict.admitted).toBe(false)
    if (verdict.admitted) throw new Error("unreachable")
    expect(verdict.code).toBe("intent-target-tombstoned")
    expect(verdict.evidence).toMatchObject({ target, tombstone: tombstoned })
  })

  it("admits a target already contained by the pin and calls it a noop", async () => {
    const { repo, component, basePin } = await fixture()
    const ahead = await publish(component, "two")
    await git(repo, "-C", "components/alpha", "fetch", "--quiet", "origin")
    await git(repo, "-C", "components/alpha", "checkout", "--quiet", ahead)
    await commit(repo, "advance pin")

    const verdict = await admitPinIntent({
      process,
      repo,
      base: "main",
      component: "components/alpha",
      target: basePin,
    })

    if (!verdict.admitted) throw new Error(`unexpected refusal: ${verdict.code}`)
    expect(verdict.relation).toBe("noop")
  })

  it("refuses when the merge-time pin no longer matches the authored CAS guard", async () => {
    const { repo, component, basePin } = await fixture()
    const target = await publish(component, "two")

    const verdict = await admitPinIntent({
      process,
      repo,
      base: "main",
      component: "components/alpha",
      target,
      expectedCurrentPin: "f".repeat(40),
    })

    expect(verdict.admitted).toBe(false)
    if (verdict.admitted) throw new Error("unreachable")
    expect(verdict.code).toBe("intent-pin-moved")
    expect(verdict.evidence).toEqual({ component: "components/alpha", target, currentPin: basePin })
  })

  it("refuses an unknown component and names the declared ones", async () => {
    const { repo, component } = await fixture()
    const target = await publish(component, "two")

    const verdict = await admitPinIntent({ process, repo, base: "main", component: "components/typo", target })

    expect(verdict.admitted).toBe(false)
    if (verdict.admitted) throw new Error("unreachable")
    expect(verdict.code).toBe("intent-component-unknown")
    expect(verdict.evidence.declared).toEqual(["components/alpha"])
  })

  it("refuses an unpublished target and its remedy is the push that fixes it", async () => {
    const { repo, component } = await fixture()
    const target = await local(component, "two")

    const verdict = await admitPinIntent({ process, repo, base: "main", component: "components/alpha", target })

    expect(verdict.admitted).toBe(false)
    if (verdict.admitted) throw new Error("unreachable")
    expect(verdict.code).toBe("intent-target-unpublished")
    expect(verdict.remedy[0]?.argv).toEqual(["git", "push", "origin", `${target}:refs/heads/main`])
    expect(verdict.remedy[0]?.cwd).toBe("components/alpha")

    // The remedy is not decoration: running it clears the refusal.
    await git(component, "push", "--quiet", "origin", `${target}:refs/heads/main`)
    const retry = await admitPinIntent({ process, repo, base: "main", component: "components/alpha", target })
    expect(retry.admitted).toBe(true)
  })

  it("refuses a divergent target whose lineage never met the pin", async () => {
    const { repo, component, basePin } = await fixture()
    await git(component, "checkout", "--quiet", "-b", "sideways", basePin)
    await git(
      component,
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "root-of-a-second-line",
    )
    await git(component, "checkout", "--quiet", "--orphan", "unrelated")
    await writeFile(join(component, "unrelated.txt"), "unrelated\n")
    const target = await commit(component, "unrelated")
    await git(component, "push", "--quiet", "origin", "unrelated")

    const verdict = await admitPinIntent({ process, repo, base: "main", component: "components/alpha", target })

    expect(verdict.admitted).toBe(false)
    if (verdict.admitted) throw new Error("unreachable")
    expect(verdict.code).toBe("intent-pin-divergent")
    expect(verdict.evidence.currentPin).toBe(basePin)
  })

  it("admits an intent with NO target without touching the component at all", async () => {
    const { repo, basePin } = await fixture()

    const verdict = await admitPinIntent({ process, repo, base: "main", component: "components/alpha" })

    if (!verdict.admitted) throw new Error(`unexpected refusal: ${verdict.code}`)
    expect(verdict.currentPin).toBe(basePin)
    expect(verdict.relation).toBe("deferred")
  })

  it("refuses a published target that descends from the pin but is off the component trunk", async () => {
    const { repo, component, basePin } = await fixture()
    const target = await publishSideline(component, "sideline", basePin)

    const verdict = await admitPinIntent({ process, repo, base: "main", component: "components/alpha", target })

    expect(verdict.admitted).toBe(false)
    if (verdict.admitted) throw new Error("unreachable")
    expect(verdict.code).toBe("intent-target-off-trunk")
    expect(verdict.evidence).toMatchObject({ target, currentPin: basePin, trunk: basePin })
    // The trunk tip is the fact the submitter is missing, so the refusal states it.
    expect(verdict.message).toContain(basePin)
    // Pipeline-routed: no remedy may instruct a hand-write to a component ref.
    for (const step of verdict.remedy) {
      expect(step.argv.some((argument) => argument.includes("refs/heads/"))).toBe(false)
    }
    expect(verdict.remedy[0]?.argv).toEqual([
      "yrd",
      "intent",
      "submit",
      "--component",
      "components/alpha",
      "--target",
      basePin,
    ])
  })

  it("admits a deliberate off-trunk pin when the submitter declares it", async () => {
    const { repo, component, basePin } = await fixture()
    const target = await publishSideline(component, "sideline", basePin)

    const verdict = await admitPinIntent({
      process,
      repo,
      base: "main",
      component: "components/alpha",
      target,
      allowOffTrunk: true,
    })

    if (!verdict.admitted) throw new Error(`unexpected refusal: ${verdict.code}`)
    expect(verdict.relation).toBe("advance")
    expect(verdict.currentPin).toBe(basePin)
  })

  it("replays the I137 shape: trunk took one line, the pin took the other", async () => {
    const { repo, component, basePin } = await fixture()
    // Both lines fork from the pin. Trunk takes `trunkTip`; the intent names the
    // other. Every existing precondition passes and the advance still drops the
    // trunk's line, because a pin advance is a pointer move nobody diffs.
    const target = await publishSideline(component, "sideline", basePin)
    const trunkTip = await publish(component, "trunk-line")

    const verdict = await admitPinIntent({ process, repo, base: "main", component: "components/alpha", target })

    expect(verdict.admitted).toBe(false)
    if (verdict.admitted) throw new Error("unreachable")
    expect(verdict.code).toBe("intent-target-off-trunk")
    expect(verdict.evidence).toMatchObject({ target, currentPin: basePin, trunk: trunkTip })
    expect(verdict.message).toContain(trunkTip)
  })

  it("derives the trunk tip at merge time and admits it — the derived target IS trunk", async () => {
    const { repo, component } = await fixture()
    const trunkTip = await publish(component, "trunk-line")
    await publishSideline(component, "sideline", trunkTip)

    const verdict = await admitPinIntent({
      process,
      repo,
      base: "main",
      component: "components/alpha",
      deriveTarget: true,
    })

    if (!verdict.admitted) throw new Error(`unexpected refusal: ${verdict.code}`)
    expect(verdict.target).toBe(trunkTip)
    expect(verdict.relation).toBe("advance")
  })

  it("refuses an off-trunk target at merge time, where evaluation is the authority", async () => {
    const { repo, component, basePin } = await fixture()
    const target = await publishSideline(component, "sideline", basePin)
    const trunkTip = await publish(component, "trunk-line")

    const verdict = await admitPinIntent({
      process,
      repo,
      base: "main",
      component: "components/alpha",
      target,
      deriveTarget: true,
    })

    expect(verdict.admitted).toBe(false)
    if (verdict.admitted) throw new Error("unreachable")
    expect(verdict.code).toBe("intent-target-off-trunk")
    expect(verdict.evidence.trunk).toBe(trunkTip)
  })

  it("refuses a component path that is a tracked FILE, not a gitlink", async () => {
    const { repo, component } = await fixture()
    const target = await publish(component, "two")

    const verdict = await admitPinIntent({ process, repo, base: "main", component: "README.md", target })

    expect(verdict.admitted).toBe(false)
    if (verdict.admitted) throw new Error("unreachable")
    expect(verdict.code).toBe("intent-component-unknown")
  })
})
