/**
 * `derive:` (27176): the queue's compose regenerates a file whose inputs are the merged gitlinks, inside the merge,
 * and the candidate that leaves is still one two-parent merge whose submodule pin is the derived commit.
 *
 * @failure An author regenerates a derived file against gitlinks the merge has not decided, and two honest changes
 * conflict on it; or the queue's regeneration leaves the candidate without a frozen publication intent.
 * @level l2
 * @consumer the event queue's compose step (event-run.ts) through verifyCandidate
 * @testonly none
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { createProcess, type Process } from "@yrd/process"
import { gitSuperBin } from "../../../tests/support/git-super-bin.ts"
import { testGitIn as rawGitIn } from "../../../tests/support/test-git-in.ts"
import { DeriveFailed, deriveInWorktree } from "../src/derive.ts"
import { verifyCandidate } from "../src/verifying.ts"
import type { Git } from "../src/git.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

type World = Readonly<{
  root: string
  work: string
  git: Git
  childRemote: string
  target: string
  head: string
  env: NodeJS.ProcessEnv
}>

const ROOT_URL = "https://github.com/example/derive-root.git"
const LIB_URL = "https://github.com/example/derive-lib.git"

/** git-super freezes a push intent only for hosted remotes: the fixture names GitHub-shaped URLs and rewrites them to the local bare repositories. */
function hostedEnv(rootRemote: string, childRemote: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${gitSuperBin}:${process.env.PATH ?? ""}`,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "protocol.file.allow",
    GIT_CONFIG_VALUE_0: "always",
    GIT_CONFIG_KEY_1: `url.${rootRemote}.insteadOf`,
    GIT_CONFIG_VALUE_1: ROOT_URL,
    GIT_CONFIG_KEY_2: `url.${childRemote}.insteadOf`,
    GIT_CONFIG_VALUE_2: LIB_URL,
  }
}

/**
 * A root with one submodule `lib`, both with bare remotes; `main` pins lib at L1 and the change `task/bump` pins it
 * at L2 (a commit on lib's main). `lib/derived.txt` is the file a derive regenerates from the pin.
 */
/**
 * `componentMain`: the change and the target pin lib EQUALLY (at L2, so the compose never examines lib) while lib's
 * main stands elsewhere — `descends`: at L3, a child of L2 that rewrote derived.txt, the shape a deferred round's
 * publication leaves (27170, 2026-10-02 18:02 PDT); `forks`: at L3', a child of L1 that rewrote derived.txt, so no
 * derived commit on L2 can fast-forward it; `published`: at L3 holding EXACTLY the derivation this change produces,
 * the shape a deferred round's publication leaves on retry (27170 round 2; dev11 run e1975a26).
 */
async function world(
  options: Readonly<{ privateChild?: boolean; componentMain?: "descends" | "forks" | "published" }> = {},
): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-derive-"))
  roots.push(root)
  const rootRemote = join(root, "root.git")
  const childRemote = join(root, "lib.git")
  const env = hostedEnv(rootRemote, childRemote)
  const gitIn = (cwd: string) => rawGitIn(cwd, undefined, undefined, { env })
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", rootRemote])
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", childRemote])
  const libWork = join(root, "lib-work")
  await seed(["clone", "--quiet", LIB_URL, libWork])
  const lib = gitIn(libWork)
  await lib(["config", "user.email", "lib@yrd.test"])
  await lib(["config", "user.name", "lib"])
  await lib(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(libWork, "lib.txt"), "one\n")
  writeFileSync(join(libWork, "derived.txt"), "derived-from: (none)\n")
  await lib(["add", "-A"])
  await lib(["commit", "--quiet", "-m", "lib one"])
  await lib(["push", "--quiet", "origin", "main"])
  const l1 = (await lib(["rev-parse", "HEAD"])).trim()

  const work = join(root, "work")
  await seed(["clone", "--quiet", ROOT_URL, work])
  const git = gitIn(work)
  await git(["config", "user.email", "queue@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, "target.txt"), "base\n")
  writeFileSync(join(work, ".yrd.yml"), "{}\n")
  await git(["submodule", "add", "--quiet", LIB_URL, "lib"])
  if (options.privateChild === true) {
    // 27147: a child declared private is never materialized; the compose excludes it, and so must the derived one.
    await git(["config", "--file", ".gitmodules", "submodule.vendor/secret.path", "vendor/secret"])
    await git(["config", "--file", ".gitmodules", "submodule.vendor/secret.url", "https://example.invalid/secret.git"])
    await git(["config", "--file", ".gitmodules", "submodule.vendor/secret.private", "true"])
  }
  await git(["add", "-A"])
  // The gitlink is staged by plumbing AFTER add -A: with no directory on disk, add -A would drop it again.
  if (options.privateChild === true) {
    await git(["update-index", "--add", "--cacheinfo", `160000,${"f".repeat(40)},vendor/secret`])
  }
  await git(["commit", "--quiet", "-m", "base"])
  await git(["push", "--quiet", "origin", "main"])
  const target = (await git(["rev-parse", "HEAD"])).trim()

  // lib moves on its main; the change records the new pin.
  writeFileSync(join(libWork, "lib.txt"), "two\n")
  await lib(["commit", "--quiet", "-am", "lib two"])
  await lib(["push", "--quiet", "origin", "main"])
  const l2 = (await lib(["rev-parse", "HEAD"])).trim()
  expect(l2).not.toBe(l1)
  await git(["checkout", "--quiet", "-b", "task/bump", "main"])
  await gitIn(join(work, "lib"))(["fetch", "--quiet", "origin"])
  await gitIn(join(work, "lib"))(["checkout", "--quiet", l2])
  await git(["add", "lib"])
  await git(["commit", "--quiet", "-m", "bump lib"])
  await git(["push", "--quiet", "origin", "task/bump"])
  const head = (await git(["rev-parse", "HEAD"])).trim()
  await git(["checkout", "--quiet", "main"])
  if (options.componentMain === undefined) return { root, work, git, childRemote, target, head, env }

  // Equal pins: the target takes the bump too, and the change moves only a root file on top of it.
  await git(["merge", "--quiet", "--ff-only", "task/bump"])
  await git(["push", "--quiet", "origin", "main"])
  const equalTarget = (await git(["rev-parse", "HEAD"])).trim()
  await git(["checkout", "--quiet", "-B", "task/bump", "main"])
  writeFileSync(join(work, "target.txt"), "changed\n")
  await git(["commit", "--quiet", "-am", "a root-only change over the equal pin"])
  await git(["push", "--quiet", "--force", "origin", "task/bump"])
  const equalHead = (await git(["rev-parse", "HEAD"])).trim()
  await git(["checkout", "--quiet", "main"])
  // lib's main moves past (or beside) the pin, rewriting the derived file as a published derivation would.
  if (options.componentMain === "forks") await lib(["checkout", "--quiet", l1])
  writeFileSync(
    join(libWork, "derived.txt"),
    options.componentMain === "published" ? "derived-from: two\n" : "derived-from: a published derivation\n",
  )
  await lib(["commit", "--quiet", "-am", "chore(lib): derived.txt follows lib (published by an earlier round)"])
  await lib(["push", "--quiet", "--force", "origin", "HEAD:main"])
  // The queue clone's store still holds the main it last observed (L2 = the pin) under a FRESH git-super refresh
  // stamp, as the round that stopped the line did: its compose trusted that observation, derived on the pin, and the
  // recompose's own fresh read met the fork.
  await gitIn(join(work, "lib"))([
    "update-ref",
    "-m",
    `git-super component-main refresh ${LIB_URL}`,
    "refs/remotes/origin/main",
    l2,
  ])
  return { root, work, git, childRemote, target: equalTarget, head: equalHead, env }
}

/**
 * A derive that writes lib/derived.txt from lib's CONTENT (lib.txt at the settled pin) and prints its subject. It is
 * a function of the merged gitlinks: run again on the derived candidate it writes the same bytes. (A derive that
 * copied the pin of the submodule it writes into would never be — the compose's second run catches that.)
 */
function deriveScript(root: string, variant: "ok" | "root" | "fail" = "ok"): string {
  const script = join(root, `derive-${variant}.sh`)
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      "set -e",
      'pin=$(git -C "$YRD_REPO/lib" show HEAD:lib.txt)',
      variant === "fail" ? 'echo "derive broke on purpose" >&2; exit 7' : "",
      'printf "derived-from: %s\\n" "$pin" > "$YRD_REPO/lib/derived.txt"',
      variant === "root" ? 'printf "root\\n" > "$YRD_REPO/root-derived.txt"' : "",
      'echo "chore(lib): derived.txt follows lib ${pin}"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
  return script
}

async function compose(w: World, run: string | undefined, path: string, process?: Process) {
  const logDir = join(w.root, "logs", path)
  mkdirSync(logDir, { recursive: true })
  return verifyCandidate({
    git: w.git,
    env: w.env,
    ...(process === undefined ? {} : { process }),
    repo: w.work,
    targetHead: w.target,
    head: w.head,
    path: join(w.root, "candidates", path),
    message: "merge task/bump into main\n\nChange: task/bump\nMerged-By: yrd",
    noFetch: true,
    // As the queue runs it: the derived child objects are adopted into the queue clone's stores before the
    // worktree goes, which is where publication reads them.
    worktree: { env: w.env, populateReference: true },
    ...(run === undefined ? {} : { derive: { run, logDir, tmpdir: join(w.root, "tmp") } }),
  })
}

describe("derive: the compose regenerates what the merged gitlinks decide", () => {
  it("commits the regenerated file on the settled pin and composes it in as a two-parent merge", async () => {
    const w = await world()
    const verified = await compose(w, deriveScript(w.root), "ok")
    if (verified.state !== "verified") throw new Error(`compose failed: ${verified.verifying.detail.message}`)
    const { candidate, derived } = verified.verifying
    expect(derived).toBeDefined()
    if (derived === undefined) throw new Error("no derivation recorded")
    const parents = (await w.git(["show", "-s", "--format=%P", candidate])).trim().split(" ")
    expect(parents).toHaveLength(2)
    expect(parents[0]).toBe(derived.composed)
    expect(parents[1]).toBe(derived.carrier)
    const pin = (await w.git(["rev-parse", `${candidate}:lib`])).trim()
    expect(derived.submodules).toEqual([{ path: "lib", from: expect.any(String), to: pin }])
    const l2 = (await w.git(["rev-parse", `${w.head}:lib`])).trim()
    expect(derived.submodules[0]?.from).toBe(l2)
    const lib = rawGitIn(join(w.work, "lib"), undefined, undefined, { env: w.env })
    expect((await lib(["show", "-s", "--format=%s", pin])).trim()).toBe("chore(lib): derived.txt follows lib two")
    expect(derived.subject).toBe("chore(lib): derived.txt follows lib two")
    expect((await lib(["show", `${pin}:derived.txt`])).trim()).toBe("derived-from: two")
    expect((await lib(["show", "-s", "--format=%P", pin])).trim()).toBe(l2)
    // The candidate's message keeps the change's trailers and says what it is.
    const message = await w.git(["show", "-s", "--format=%B", candidate])
    expect(message).toContain("derived into")
    expect(message).toContain("Change: task/bump")
    expect(message).toMatch(/Git-Super-Push:/u)
    // The pin is reachable from the queue clone, where publication reads it.
    await lib(["cat-file", "-e", `${pin}^{commit}`])
  })

  it("leaves the plain merge alone when the command changes nothing", async () => {
    const w = await world()
    const noop = join(w.root, "noop.sh")
    writeFileSync(noop, "#!/bin/sh\necho nothing to derive\n", { mode: 0o755 })
    const verified = await compose(w, noop, "noop")
    if (verified.state !== "verified") throw new Error(`compose failed: ${verified.verifying.detail.message}`)
    expect(verified.verifying.derived).toBeUndefined()
    const parents = (await w.git(["show", "-s", "--format=%P", verified.verifying.candidate])).trim().split(" ")
    expect(parents).toEqual([w.target, w.head])
    const plain = await compose(w, undefined, "plain")
    if (plain.state !== "verified") throw new Error("plain compose failed")
    expect((await w.git(["rev-parse", `${plain.verifying.candidate}:lib`])).trim()).toBe(
      (await w.git(["rev-parse", `${verified.verifying.candidate}:lib`])).trim(),
    )
  })

  it("the derived recompose excludes the same private submodules as the first compose (27147 × 27176)", async () => {
    const w = await world({ privateChild: true })
    await using real = createProcess({ cwd: w.work, env: w.env })
    const merges: (readonly string[])[] = []
    const recording: Process = {
      ...real,
      async run(request) {
        if (request.argv.includes("super") && request.argv.includes("merge")) merges.push(request.argv)
        return real.run(request)
      },
    }
    const verified = await compose(w, deriveScript(w.root), "private", recording)
    if (verified.state !== "verified") throw new Error(`compose failed: ${verified.verifying.detail.message}`)
    expect(verified.verifying.derived).toBeDefined()
    expect(merges).toHaveLength(2)
    for (const argv of merges) {
      const at = argv.indexOf("--exclude-submodule")
      expect(at, argv.join(" ")).toBeGreaterThan(0)
      expect(argv[at + 1]).toBe("vendor/secret")
    }
  })

  it("builds the derived commit on the component's main when main already descends from the merged pin", async () => {
    // Run the derive step itself on the queue clone standing at the change (lib at the pin, as a compose that
    // trusted its cached main observation leaves it): git-super raises an equal pin only when it reads main afresh.
    const w = await world({ componentMain: "descends" })
    const lib = rawGitIn(join(w.work, "lib"), undefined, undefined, { env: w.env })
    const pin = (await w.git(["rev-parse", `${w.head}:lib`])).trim()
    const main = (await lib(["ls-remote", "origin", "refs/heads/main"])).split("\t")[0]?.trim()
    if (main === undefined) throw new Error("lib has no main at its remote")
    expect(main).not.toBe(pin)
    expect((await lib(["rev-parse", "refs/remotes/origin/main"])).trim()).toBe(pin)
    await w.git(["checkout", "--quiet", "task/bump"])
    await w.git(["submodule", "--quiet", "update", "--init", "lib"])
    expect((await lib(["rev-parse", "HEAD"])).trim()).toBe(pin)
    const logDir = join(w.root, "logs", "on-main")
    mkdirSync(logDir, { recursive: true })
    const derived = await deriveInWorktree({
      cwd: w.work,
      repo: w.work,
      candidate: w.head,
      targetHead: w.target,
      derive: { run: deriveScript(w.root), logDir, tmpdir: join(w.root, "tmp") },
      env: w.env,
    })
    if (derived === undefined) throw new Error("no derivation recorded")
    const to = derived.submodules[0]?.to
    expect(derived.submodules).toEqual([{ path: "lib", from: pin, to }])
    // main's child, so publication fast-forwards main; the content is the derive's, not the stale publication's.
    expect((await lib(["show", "-s", "--format=%P", to as string])).trim()).toBe(main)
    expect((await lib(["show", `${to}:derived.txt`])).trim()).toBe("derived-from: two")
    expect(readFileSync(join(logDir, "derive-base.log"), "utf8")).toContain("built on main")
    expect((await w.git(["rev-parse", `${derived.carrier}:lib`])).trim()).toBe(to)
  })

  it("reuses the derivation the component's main already holds: the pin is main and no sibling commit is written", async () => {
    const w = await world({ componentMain: "published" })
    const lib = rawGitIn(join(w.work, "lib"), undefined, undefined, { env: w.env })
    const pin = (await w.git(["rev-parse", `${w.head}:lib`])).trim()
    const main = (await lib(["ls-remote", "origin", "refs/heads/main"])).split("\t")[0]?.trim()
    if (main === undefined) throw new Error("lib has no main at its remote")
    await w.git(["checkout", "--quiet", "task/bump"])
    await w.git(["submodule", "--quiet", "update", "--init", "lib"])
    const logDir = join(w.root, "logs", "published")
    mkdirSync(logDir, { recursive: true })
    const derived = await deriveInWorktree({
      cwd: w.work,
      repo: w.work,
      candidate: w.head,
      targetHead: w.target,
      derive: { run: deriveScript(w.root), logDir, tmpdir: join(w.root, "tmp") },
      env: w.env,
    })
    if (derived === undefined) throw new Error("no derivation recorded")
    expect(derived.submodules).toEqual([{ path: "lib", from: pin, to: main }])
    expect((await lib(["rev-parse", "HEAD"])).trim()).toBe(main)
    expect((await w.git(["rev-parse", `${derived.carrier}:lib`])).trim()).toBe(main)
    expect(readFileSync(join(logDir, "derive-base.log"), "utf8")).toContain("reuses it, no commit written")
  })

  it("a recompose the component refuses sticks the change by name, never the run", async () => {
    const w = await world({ componentMain: "forks" })
    const failure = await compose(w, deriveScript(w.root), "forked").catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DeriveFailed)
    if (!(failure instanceof DeriveFailed)) throw new Error("expected DeriveFailed")
    expect(failure.message).toMatch(/composing the carrier \S+ into \S+ returned failed/u)
    expect(failure.message).toMatch(/derived\.txt/u)
    expect(readFileSync(join(w.root, "logs", "forked", "derive-base.log"), "utf8")).toContain("does not descend")
  })

  it("a change outside every submodule stops the compose by name and says root derivation is not admitted", async () => {
    const w = await world()
    await expect(compose(w, deriveScript(w.root, "root"), "root")).rejects.toThrow(
      /root-derived\.txt outside every submodule; root derivation is not admitted yet/u,
    )
  })

  it("a failing command stops the compose with its exit and log, never a candidate", async () => {
    const w = await world()
    const failure = await compose(w, deriveScript(w.root, "fail"), "fail").catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DeriveFailed)
    if (!(failure instanceof DeriveFailed)) throw new Error("expected DeriveFailed")
    expect(failure.message).toMatch(/exit 7/u)
    expect(failure.message).toMatch(/log /u)
    const log = /log (\S+)/u.exec(failure.message)?.[1]
    expect(log).toBeDefined()
    expect(readFileSync(log as string, "utf8")).toContain("derive broke on purpose")
  })
})
