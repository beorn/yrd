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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { createProcess } from "@yrd/process"
import { admitPinIntent } from "../src/intent-admission.ts"

const process = createProcess()
const ISSUE = "km:@yrd/core/22668-admit-intents"

/**
 * Every fixture root this file created, removed when the file is done.
 *
 * Each root holds three real git repositories, so a run that leaves them behind
 * costs a few hundred inodes; hundreds of accumulated runs exhausted the tmpfs
 * inode table outright and every suite on the host began failing ENOSPC with
 * bytes still free. A temp directory is only temporary if something deletes it.
 */
const fixtureRoots: string[] = []
afterAll(async () => {
  await Promise.all(fixtureRoots.map(async (root) => rm(root, { recursive: true, force: true })))
})

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
  fixtureRoots.push(root)
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

/** The submodule checkout admission actually reads — never the source clone. */
function checkoutOf(repo: string): string {
  return join(repo, "components", "alpha")
}

/**
 * Break `git fetch` in the component checkout while leaving `git ls-remote`
 * working.
 *
 * FETCH_HEAD becomes a directory, so the fetch cannot open it, exits non-zero,
 * and leaves the remote-tracking refs exactly as stale as it found them.
 * `ls-remote` never writes FETCH_HEAD, so it still answers — which is the
 * asymmetry the remote fallback exists to exploit, and the shape of a checkout
 * that cannot refresh itself while the remote is perfectly reachable.
 */
async function breakFetchRefs(repo: string): Promise<void> {
  const gitDir = await git(checkoutOf(repo), "rev-parse", "--absolute-git-dir")
  await rm(join(gitDir, "FETCH_HEAD"), { force: true })
  await mkdir(join(gitDir, "FETCH_HEAD"))
}

/**
 * A commit PRESENT in the submodule checkout yet contained by no
 * remote-tracking ref: published to a scratch branch, fetched into the
 * checkout, then withdrawn from the origin so admission's own `--prune` drops
 * the ref while the object stays behind.
 *
 * This is the genuinely-unpublished shape, and it is NOT the same as a commit
 * the checkout has never seen — which is why admission has to tell them apart.
 */
async function publishThenWithdraw(repo: string, component: string, name: string): Promise<string> {
  await git(component, "checkout", "--quiet", "-b", name)
  await writeFile(join(component, `${name}.txt`), `${name}\n`)
  const sha = await commit(component, name)
  await git(component, "push", "--quiet", "origin", name)
  await git(component, "checkout", "--quiet", "main")
  await git(checkoutOf(repo), "fetch", "--quiet", "origin")
  await git(component, "push", "--quiet", "--delete", "origin", name)
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

    const verdict = await admitPinIntent({
      process,
      repo,
      base: "main",
      component: "components/alpha",
      issue: ISSUE,
      target,
    })

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
      issue: ISSUE,
      target,
      tombstones: [{ sha: tombstoned }],
    })

    expect(verdict.admitted).toBe(false)
    if (verdict.admitted) throw new Error("unreachable")
    expect(verdict.code).toBe("intent-target-tombstoned")
    expect(verdict.evidence).toMatchObject({ target, tombstone: tombstoned })
    expect(verdict.remedy.at(-1)?.argv).toEqual([
      "yrd",
      "intent",
      "submit",
      "--component",
      "components/alpha",
      "--target",
      "<safe-sha>",
      "--issue",
      ISSUE,
    ])
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
      issue: ISSUE,
      target: basePin,
    })

    if (!verdict.admitted) throw new Error(`unexpected refusal: ${verdict.code}`)
    expect(verdict.relation).toBe("noop")
  })

  it("calls an intent targeting the exact current pin a noop", async () => {
    const { repo, basePin } = await fixture()

    const verdict = await admitPinIntent({
      process,
      repo,
      base: "main",
      component: "components/alpha",
      issue: ISSUE,
      target: basePin,
    })

    if (!verdict.admitted) throw new Error(`unexpected refusal: ${verdict.code}`)
    expect(verdict.currentPin).toBe(basePin)
    expect(verdict.target).toBe(basePin)
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
      issue: ISSUE,
      target,
      expectedCurrentPin: "f".repeat(40),
    })

    expect(verdict.admitted).toBe(false)
    if (verdict.admitted) throw new Error("unreachable")
    expect(verdict.code).toBe("intent-pin-moved")
    expect(verdict.evidence).toEqual({ component: "components/alpha", target, currentPin: basePin })
    expect(verdict.remedy[0]?.argv).toEqual([
      "yrd",
      "intent",
      "submit",
      "--component",
      "components/alpha",
      "--target",
      target,
      "--issue",
      ISSUE,
    ])
  })

  it("refuses an unknown component and names the declared ones", async () => {
    const { repo, component } = await fixture()
    const target = await publish(component, "two")

    const verdict = await admitPinIntent({
      process,
      repo,
      base: "main",
      component: "components/typo",
      issue: ISSUE,
      target,
    })

    expect(verdict.admitted).toBe(false)
    if (verdict.admitted) throw new Error("unreachable")
    expect(verdict.code).toBe("intent-component-unknown")
    expect(verdict.evidence.declared).toEqual(["components/alpha"])
    expect(verdict.remedy[0]?.argv).toEqual([
      "yrd",
      "intent",
      "submit",
      "--component",
      "components/alpha",
      "--target",
      target,
      "--issue",
      ISSUE,
    ])
  })

  it("refuses an unpublished target, names the actor in the message, and remedies with a resubmit", async () => {
    const { repo, component } = await fixture()
    const target = await local(component, "two")

    const verdict = await admitPinIntent({
      process,
      repo,
      base: "main",
      component: "components/alpha",
      issue: ISSUE,
      target,
    })

    expect(verdict.admitted).toBe(false)
    if (verdict.admitted) throw new Error("unreachable")
    expect(verdict.code).toBe("intent-target-unpublished")
    // Pipeline-routed: no remedy step may instruct a hand-write to a component ref.
    for (const step of verdict.remedy) {
      expect(step.argv.some((argument) => argument.includes("refs/heads/"))).toBe(false)
    }
    // The actor who must publish is named in the MESSAGE (the only field a
    // reader sees) — never a `note`, which is never rendered.
    expect(verdict.message).toContain("whoever holds it must publish it through")
    expect(verdict.remedy[0]?.argv).toEqual([
      "yrd",
      "intent",
      "submit",
      "--component",
      "components/alpha",
      "--target",
      target,
      "--issue",
      ISSUE,
    ])

    // The remedy is not decoration: running the publish it describes clears the refusal.
    await git(component, "push", "--quiet", "origin", `${target}:refs/heads/main`)
    const retry = await admitPinIntent({
      process,
      repo,
      base: "main",
      component: "components/alpha",
      issue: ISSUE,
      target,
    })
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

    const verdict = await admitPinIntent({
      process,
      repo,
      base: "main",
      component: "components/alpha",
      issue: ISSUE,
      target,
    })

    expect(verdict.admitted).toBe(false)
    if (verdict.admitted) throw new Error("unreachable")
    expect(verdict.code).toBe("intent-pin-divergent")
    expect(verdict.evidence.currentPin).toBe(basePin)
    expect(verdict.remedy.at(-1)?.argv).toEqual([
      "yrd",
      "intent",
      "submit",
      "--component",
      "components/alpha",
      "--target",
      "<merge-sha>",
      "--issue",
      ISSUE,
    ])
  })

  it("admits an intent with NO target without touching the component at all", async () => {
    const { repo, basePin } = await fixture()

    const verdict = await admitPinIntent({
      process,
      repo,
      base: "main",
      component: "components/alpha",
      issue: ISSUE,
    })

    if (!verdict.admitted) throw new Error(`unexpected refusal: ${verdict.code}`)
    expect(verdict.currentPin).toBe(basePin)
    expect(verdict.relation).toBe("deferred")
  })

  it("refuses a published target that descends from the pin but is off the component trunk", async () => {
    const { repo, component, basePin } = await fixture()
    const target = await publishSideline(component, "sideline", basePin)

    const verdict = await admitPinIntent({
      process,
      repo,
      base: "main",
      component: "components/alpha",
      issue: ISSUE,
      target,
    })

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
      "--issue",
      ISSUE,
    ])
    expect(verdict.remedy[1]?.argv).toEqual([
      "yrd",
      "intent",
      "submit",
      "--component",
      "components/alpha",
      "--target",
      target,
      "--issue",
      ISSUE,
      "--allow-off-trunk",
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
      issue: ISSUE,
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

    const verdict = await admitPinIntent({
      process,
      repo,
      base: "main",
      component: "components/alpha",
      issue: ISSUE,
      target,
    })

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
      issue: ISSUE,
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
      issue: ISSUE,
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

    const verdict = await admitPinIntent({
      process,
      repo,
      base: "main",
      component: "README.md",
      issue: ISSUE,
      target,
    })

    expect(verdict.admitted).toBe(false)
    if (verdict.admitted) throw new Error("unreachable")
    expect(verdict.code).toBe("intent-component-unknown")
  })
})

/**
 * @failure  Admission judged publication from the submodule checkout's local
 *           remote-tracking refs and reported the verdict as fact. When the
 *           refreshing fetch failed, the failure was discarded, the stale read
 *           stood in for a fresh one, and a commit that WAS the component's
 *           published main tip came back "not reachable from any published
 *           branch" — with the message naming neither the repository it read
 *           nor how old that read was. Three distinct states (never saw the
 *           commit / saw it and no ref contains it / could not read at all)
 *           printed as one sentence.
 * @level    l2 (real git repositories with a real submodule; no fakes)
 * @consumer @yrd/core/21679-integration-model-v2/22668-admit-intents
 */
describe("pin-intent admission: publication is a scoped, dated read", () => {
  // The success measure, first: when the target IS the published tip, admission
  // must never refuse it as unreachable. The checkout has never seen the commit
  // at call time, so only admission's own fetch can save this.
  it("admits a target published to component main that the checkout has not seen", async () => {
    const { repo, component } = await fixture()
    const target = await publish(component, "two")

    const unseen = await process.run({
      argv: ["git", "-C", checkoutOf(repo), "cat-file", "-e", `${target}^{commit}`],
      cwd: checkoutOf(repo),
      timeoutMs: 30_000,
    })
    expect(unseen.exitCode).not.toBe(0)

    const verdict = await admitPinIntent({
      process,
      repo,
      base: "main",
      component: "components/alpha",
      issue: ISSUE,
      target,
    })

    if (!verdict.admitted) throw new Error(`false unreachable-refusal: ${verdict.code}: ${verdict.message}`)
    expect(verdict.relation).toBe("advance")
  })

  it("refuses a genuinely unpublished target and discloses where and how it looked", async () => {
    const { repo, component } = await fixture()
    const target = await publishThenWithdraw(repo, component, "withdrawn")

    const verdict = await admitPinIntent({
      process,
      repo,
      base: "main",
      component: "components/alpha",
      issue: ISSUE,
      target,
    })

    expect(verdict.admitted).toBe(false)
    if (verdict.admitted) throw new Error("unreachable")
    expect(verdict.code).toBe("intent-target-unpublished")
    // Still names the actor who must publish — the pre-existing contract.
    expect(verdict.message).toContain("whoever holds it must publish it through")
    // ...and now names the scope, in the MESSAGE, the only field a reader sees.
    expect(verdict.message).toContain(checkoutOf(repo))
    expect(verdict.message).toContain("refs/remotes/origin/*")
    expect(verdict.message).toContain("last fetched")
    expect(verdict.evidence.readRepo).toBe(checkoutOf(repo))
    expect(verdict.evidence.fetchOutcome).toBe("ok")
    expect(verdict.evidence.publicationReason).toBe("no-containing-ref")
  })

  it("tells a commit it has never seen apart from one no remote ref contains", async () => {
    const { repo, component } = await fixture()
    const unseen = await local(component, "never-pushed")

    const verdict = await admitPinIntent({
      process,
      repo,
      base: "main",
      component: "components/alpha",
      issue: ISSUE,
      target: unseen,
    })

    expect(verdict.admitted).toBe(false)
    if (verdict.admitted) throw new Error("unreachable")
    expect(verdict.code).toBe("intent-target-unpublished")
    expect(verdict.evidence.publicationReason).toBe("commit-absent")
    expect(verdict.message).toContain("not present in that checkout")
  })

  it("falls back to the stale read when the component fetch fails, and says the read is stale", async () => {
    const { root, repo, component } = await fixture()
    const target = await local(component, "never-pushed")
    // Neither the fetch nor a direct remote read can reach the origin.
    await git(checkoutOf(repo), "remote", "set-url", "origin", join(root, "vanished.git"))

    const verdict = await admitPinIntent({
      process,
      repo,
      base: "main",
      component: "components/alpha",
      issue: ISSUE,
      target,
    })

    expect(verdict.admitted).toBe(false)
    if (verdict.admitted) throw new Error("unreachable")
    expect(verdict.code).toBe("intent-target-unpublished")
    // A failed refresh may never masquerade as a clean negative.
    expect(verdict.message).toContain("fetch FAILED")
    expect(verdict.message).toContain("possibly-stale")
    expect(verdict.message).toContain(checkoutOf(repo))
    expect(verdict.evidence.fetchOutcome).toBe("failed")
    expect(verdict.evidence.fetchDetail ?? "").not.toBe("")
    // Both failures are disclosed, not just the first one.
    expect(verdict.message).toContain("ls-remote")
    expect(verdict.message).toContain("neither this checkout nor the remote could answer")
    expect(verdict.evidence.remoteRead).toBe("failed")
    // The remedy must offer the retry, not only "go publish something you already published".
    expect(verdict.remedy.some((step) => step.note?.includes("retry") === true)).toBe(true)
  })

  // THIS MORNING'S REFUSAL, end to end: the commit really is the component's
  // published main tip, `ls-remote` really does say so, and only the local
  // fetch is broken. The verdict must be an admit.
  it("admits a published tip the fetch could not see, crediting the remote read", async () => {
    const { repo, component } = await fixture()
    const target = await publish(component, "two")
    await breakFetchRefs(repo)

    const verdict = await admitPinIntent({
      process,
      repo,
      base: "main",
      component: "components/alpha",
      issue: ISSUE,
      target,
    })

    if (!verdict.admitted) throw new Error(`false unreachable-refusal: ${verdict.code}: ${verdict.message}`)
    expect(verdict.relation).toBe("deferred")
    expect(verdict.disclosure ?? "").toContain("ls-remote")
    expect(verdict.disclosure ?? "").toContain("refs/heads/main")
    // The admit says plainly that it knows less than usual.
    expect(verdict.disclosure ?? "").toContain("deferred to merge-time evaluation")
  })

  it("keeps refusing when the remote read runs and does not show the target as a tip", async () => {
    const { repo, component } = await fixture()
    const target = await local(component, "never-pushed")
    // The fetch cannot refresh, but ls-remote still answers from the origin.
    await breakFetchRefs(repo)

    const verdict = await admitPinIntent({
      process,
      repo,
      base: "main",
      component: "components/alpha",
      issue: ISSUE,
      target,
    })

    expect(verdict.admitted).toBe(false)
    if (verdict.admitted) throw new Error("unreachable")
    expect(verdict.code).toBe("intent-target-unpublished")
    expect(verdict.evidence.remoteRead).toBe("ok")
    expect(verdict.message).toContain("does not show the target as the tip of any ref")
    // The honest limit of an ls-remote answer is stated, not glossed.
    expect(verdict.message).toContain("cannot rule out the target being an ancestor")
  })
})
