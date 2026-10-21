/**
 * @reach fs-walk <fixture-only: temporary repositories, bare remotes and retained worktrees>
 * @failure A fresh environment ignored its commit's setup or ran it before
 *          dependencies existed; closing an unsafe environment discarded work.
 * @level   l2 (real bare remote and real retained Git worktree)
 * @consumer every seat opening a fresh environment through `yrd env open`
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as removely from "removely"
import { inspectCheckoutGitMetadata, verifyRetainedEntry, worktreeHomeRoot } from "git-super"
import { createEventStore, freshWorktree, previewCloneKey, previewSubjectPrefix } from "@yrd/queue-core"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { runYrdProcess } from "../src/cli.ts"
import { closeEnvironment } from "../src/env-commands.ts"
import * as publicCli from "../src/index.ts"
import { admitEnvironmentClose, environmentCwdHolder } from "../src/env-close-holders.ts"
import {
  closeRequestFile,
  closeRequestsDirectory,
  listCloseRequests,
  readCloseRequest,
  requesterOf,
} from "../src/env-close-requests.ts"
import { workdirOf } from "../src/workdir.ts"
import { environmentProvenance } from "../src/env-cleanup-provenance.ts"
import type { YrdCliIO } from "../src/types.ts"
import { birthEventQueue } from "./support/event-queue-birth.ts"

process.env.GIT_CONFIG_COUNT = "1"
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
process.env.GIT_CONFIG_VALUE_0 = "always"

// A spy cannot replace a binding of an installed ESM package's namespace (standalone CI), so the seam is a module mock.
vi.mock("removely", async (importOriginal) => {
  const actual = await importOriginal<typeof import("removely")>()
  return { ...actual, inspectProcessCensus: vi.fn(actual.inspectProcessCensus) }
})

const roots: string[] = []
const realProcessCensus = (await vi.importActual<typeof import("removely")>("removely")).inspectProcessCensus
const processCensus = vi.mocked(removely.inspectProcessCensus)
// Non-holder lifecycle rows inject this external boundary; host process churn is not their subject.
beforeEach(async () => {
  if (process.platform !== "linux") return
  const observed = await realProcessCensus({ scope: "same-uid", sources: ["cwd"], deadlineMs: 2_000 })
  processCensus.mockResolvedValue({
    ...observed,
    rows: [],
    coverage: { ...observed.coverage, complete: true, unreadable: [] },
  })
})
afterEach(() => {
  processCensus.mockReset()
  vi.unstubAllEnvs()
})

/** Scope real kernel observations to the native fixture; missing expected PIDs fail loudly. */
function fixtureCensus(census: removely.ProcessCensus<"same-uid">, pids: readonly number[]) {
  for (const pid of pids) {
    if (!census.rows.some((row) => row.pid === pid)) throw new Error(`fixture process ${pid} missing from real census`)
  }
  const unreadable = (census.coverage.unreadable ?? []).filter((row) => pids.includes(row.pid))
  return {
    ...census,
    rows: census.rows.filter((row) => pids.includes(row.pid)),
    coverage: { ...census.coverage, unreadable, complete: unreadable.length === 0 },
  }
}
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

function capture(cwd: string): Readonly<{ io: YrdCliIO; stderr(): string; stdout(): string }> {
  let stdout = ""
  let stderr = ""
  return {
    io: {
      localBranchProtections: null,
      color: false,
      cwd,
      stderr: (text) => void (stderr += text),
      stdout: (text) => void (stdout += text),
    },
    stderr: () => stderr,
    stdout: () => stdout,
  }
}

async function openEnvironment(cwd: string, commit: string): Promise<Readonly<{ path: string; head: string }>> {
  const run = capture(cwd)
  expect(await runYrdProcess(["bun", "yrd", "env", "open", commit, "--json"], run.io), run.stderr()).toBe(0)
  expect(JSON.parse(run.stdout())).toMatchObject({ base: commit, head: commit })
  expect(run.stderr()).not.toMatch(/reus/iu)
  return JSON.parse(run.stdout()) as { path: string; head: string }
}

type World = Readonly<{ git: ReturnType<typeof gitIn>; work: string }>

it("cleanup provenance excludes inherited history and refuses incomplete or unknown HEAD evidence", async () => {
  const w = await world(":")
  const head = (await w.git(["rev-parse", "HEAD"])).trim()
  const log = (await w.git(["rev-parse", "--git-path", "logs/HEAD"])).trim()
  const path = join(w.work, log)
  const entry = (old: string, message: string) => `${old} ${head} yrd <env-open@yrd.test> 1 +0000\t${message}\n`
  const creation = entry("0".repeat(40), "")
  writeFileSync(path, creation + entry(head, "checkout: moving from task/27723 to main"))
  expect(await environmentProvenance(w.work, w.git, "main")).toEqual({
    commits: [],
    branches: ["main", "task/27723"],
  })
  writeFileSync(path, creation + entry(head, "commit (amend): own binding") + entry(head, "reset: moving to HEAD"))
  expect((await environmentProvenance(w.work, w.git)).commits).toEqual([head])
  // A message-less NON-FIRST entry is CREATING: it is `env open`'s binding
  // update-ref, which git mirrors into HEAD's reflog with no -m (27723
  // addendum). Its trailers are read from that commit, never its ancestry.
  writeFileSync(path, creation + entry(head, ""))
  expect((await environmentProvenance(w.work, w.git)).commits).toEqual([head])
  // `git branch -m` writes this message as a delete/create pair. It creates no
  // commit, and BOTH names join the branch set so a renamed branch still finds
  // the change chain stored under its old name (ruling 27723 post-adoption).
  writeFileSync(path, creation + entry(head, "Branch: renamed refs/heads/task/a to refs/heads/task/b"))
  expect(await environmentProvenance(w.work, w.git)).toEqual({ commits: [], branches: ["task/a", "task/b"] })
  // Newer Yrd names that same binding move with -m; the prefix stays CREATING.
  writeFileSync(path, creation + entry(head, "yrd env open: bind 27723"))
  expect((await environmentProvenance(w.work, w.git)).commits).toEqual([head])
  // `rebase: fast-forward` is a non-creating move, like merge/pull's.
  for (const message of ["rebase: fast-forward", "merge: Fast-forward", "pull: Fast-forward"]) {
    writeFileSync(path, creation + entry(head, message))
    expect((await environmentProvenance(w.work, w.git)).commits, message).toEqual([])
  }
  for (const message of [
    "commit: own",
    "commit (merge): own",
    "commit (initial): own",
    "rebase (pick): own",
    "rebase -i (reword): own",
    "pull --rebase (edit): own",
    "rebase (squash): own",
    "rebase (fixup): own",
    "rebase (continue): own",
    "cherry-pick: own",
    "revert: own",
    "am: own",
    "merge topic: Merge made by the 'ort' strategy.",
    "pull: Merge made by the 'ort' strategy.",
  ]) {
    writeFileSync(path, creation + entry(head, message))
    expect((await environmentProvenance(w.work, w.git)).commits, message).toEqual([head])
  }
  writeFileSync(path, entry(head, "commit: truncated beginning"))
  await expect(environmentProvenance(w.work, w.git)).rejects.toThrow(/creation evidence/u)
  writeFileSync(path, creation + entry(head, "future-command: unknown"))
  await expect(environmentProvenance(w.work, w.git)).rejects.toThrow(/future-command/u)
})

/** One denied same-UID cwd read exactly as removely records it: identity evidence, no readable row. */
function unreadableDenial(
  argv: readonly string[] = ["bun", "private-argument-must-not-be-reported"],
): removely.UnreadableProcess {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("this case needs a real unix uid")
  return {
    pid: 4242,
    uid,
    comm: "bun",
    denied: ["process"],
    issues: [{ source: "process", resource: "cwd", reason: "denied", code: "EACCES" }],
    argv: [...argv],
  }
}

/** The census this caller cannot complete: one uncleared denial, no readable row. */
async function incompleteCensus(): Promise<removely.ProcessCensus<"same-uid">> {
  const observed = await removely.inspectProcessCensus({ scope: "same-uid", sources: ["cwd"], deadlineMs: 2_000 })
  return { rows: [], coverage: { ...observed.coverage, complete: false, unreadable: [unreadableDenial()] } }
}

/** A census the caller read completely, carrying one readable holder. */
async function holderCensus(pid: number, cwd: string): Promise<removely.ProcessCensus<"same-uid">> {
  const observed = await removely.inspectProcessCensus({ scope: "same-uid", sources: ["cwd"], deadlineMs: 2_000 })
  return {
    rows: [{ pid, sources: { cwd: { availability: "readable", value: cwd, issues: [] } }, issues: [] }],
    coverage: { ...observed.coverage, complete: true, unreadable: [] },
  }
}

async function command(
  cwd: string,
  argv: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<Readonly<{ exit: number; stderr: string; stdout: string }>> {
  const child = Bun.spawn([...argv], { cwd, env, stderr: "pipe", stdin: "ignore", stdout: "pipe" })
  const [exit, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ])
  return { exit, stderr, stdout }
}

async function world(setup: string, teardown?: string): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-env-open-"))
  roots.push(root)
  const seed = gitIn(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "env-open@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(
    join(work, ".yrd.yml"),
    `setup: ${JSON.stringify(setup)}\n${teardown === undefined ? "" : `teardown: ${JSON.stringify(teardown)}\n`}`,
  )
  await git(["add", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "declare environment setup"])
  await git(["push", "--quiet", "origin", "main"])
  return { git, work }
}

/** @failure A merged branch kept while checked out receives no retirement retry after native close releases it.
 * @level l3 @consumer yrd env close after a standing author environment survives its landing round
 * Exact young jobs now close at landing (29367); a standing environment preserves the later native-release probe.
 */
it.each(["released", "held", "advanced", "failed"] as const)(
  "retries a held merged author branch after native close: %s",
  async (mode) => {
    const w = await world(":")
    await birthEventQueue(w.work, "main", { localStore: false })
    const opened = capture(w.work)
    expect(
      await runYrdProcess(["bun", "yrd", "env", "open", "--bay", "release-retirement", "--keep", "--json"], opened.io),
      opened.stderr(),
    ).toBe(0)
    const author = (JSON.parse(opened.stdout()) as { path: string }).path
    const authorGit = gitIn(author)
    const branch = "task/release-retirement"
    await authorGit(["commit", "--quiet", "--allow-empty", "-m", "author work\n\nRefs: @example/29340-release"])
    const head = (await authorGit(["rev-parse", "HEAD"])).trim()
    const submitted = capture(author)
    expect(await runYrdProcess(["bun", "yrd", "submit", "--json"], submitted.io), submitted.stderr()).toBe(0)
    const landed = capture(w.work)
    expect(
      await runYrdProcess(["bun", "yrd", "queue", "run", "--queue", "main", "--json"], landed.io),
      landed.stderr(),
    ).toBe(0)
    expect(JSON.parse(landed.stdout())).toMatchObject({ merged: [branch] })
    expect(existsSync(author)).toBe(true)
    expect((await w.git(["rev-parse", `refs/heads/${branch}`])).trim()).toBe(head)
    const journals = dirname((JSON.parse(landed.stdout()) as { log: string }).log)
    const beforeClose = new Set(readdirSync(journals))
    let expectedHead = head
    if (mode === "advanced") {
      await authorGit(["commit", "--quiet", "--allow-empty", "-m", "new unsubmitted author work"])
      expectedHead = (await authorGit(["rev-parse", "HEAD"])).trim()
    }
    const closed = capture(w.work)
    if (mode === "held") {
      closed.io.localBranchProtections = async () => ({ protections: ["fixture external hold"], evidence: [] })
    }
    if (mode === "failed") {
      // Release admission succeeds before capture, then loses certification before removal.
      const observed = await realProcessCensus({ scope: "same-uid", sources: ["cwd"], deadlineMs: 2_000 })
      const permitted = { ...observed, rows: [], coverage: { ...observed.coverage, complete: true, unreadable: [] } }
      processCensus
        .mockResolvedValueOnce(permitted)
        .mockResolvedValueOnce({ ...permitted, coverage: { ...permitted.coverage, complete: false } })
    }
    expect(await runYrdProcess(["bun", "yrd", "env", "close", author, "--json"], closed.io), closed.stderr()).toBe(
      mode === "failed" ? 2 : 0,
    )
    expect(existsSync(author)).toBe(mode === "failed")
    expect((await w.git(["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`])).trim()).toBe(
      mode === "released" ? "" : expectedHead,
    )
    const archives = (await w.git(["for-each-ref", "--format=%(objectname)", "refs/archive/"])).trim().split("\n")
    if (mode === "released") expect(archives).toContain(head)
    else expect(archives).not.toContain(head)
    if (mode === "failed") {
      const records = readdirSync(journals)
        .filter((file) => file.endsWith(".jsonl") && !beforeClose.has(file))
        .flatMap((file) =>
          readFileSync(join(journals, file), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { kind: string }),
        )
      expect(records.some((row) => row.kind === "local-branch-retirement")).toBe(false)
    }
  },
  60_000,
)

/** @failure Native close skips a released component author or mutates a copied retained store after its proof is sealed.
 * @level l3 @consumer automatic component retirement after native environment release
 * Root-only release and component landing coverage do not observe post-removal component custody or retained-copy bytes.
 */
it.each(["snapshot", "shared", "advanced", "unsealed"] as const)(
  "native component release preserves retained custody: %s",
  async (mode) => {
    const seeded = await world(":")
    await addMaterializedDependency(seeded)
    const rootRemote = (await seeded.git(["remote", "get-url", "origin"])).trim()
    const childRemote = (await gitIn(join(seeded.work, "vendor/dependency"))(["remote", "get-url", "origin"])).trim()
    // Match the existing native component-landing fixture's hosted ownership and local transport.
    vi.stubEnv("GIT_CONFIG_COUNT", "3")
    for (const [index, local, hosted] of [
      [1, rootRemote, `https://git-super.test/owned/release-root-${mode}.git`],
      [2, childRemote, `https://git-super.test/owned/release-child-${mode}.git`],
    ] as const) {
      vi.stubEnv(`GIT_CONFIG_KEY_${index}`, `url.${local}.insteadOf`)
      vi.stubEnv(`GIT_CONFIG_VALUE_${index}`, hosted)
    }
    const w = { ...seeded, git: gitIn(seeded.work) }
    await w.git(["remote", "set-url", "origin", `https://git-super.test/owned/release-root-${mode}.git`])
    await gitIn(join(w.work, "vendor/dependency"))([
      "remote",
      "set-url",
      "origin",
      `https://git-super.test/owned/release-child-${mode}.git`,
    ])
    await w.git([
      "config",
      "--file",
      ".gitmodules",
      "submodule.vendor/dependency.url",
      `https://git-super.test/owned/release-child-${mode}.git`,
    ])
    await w.git(["config", "submodule.vendor/dependency.url", `https://git-super.test/owned/release-child-${mode}.git`])
    await w.git(["add", ".gitmodules"])
    await w.git(["commit", "--quiet", "-m", "declare hosted component ownership"])
    await w.git(["push", "--quiet", "origin", "main"])
    await birthEventQueue(w.work, "main", { localStore: false })
    const rootBranch = `task/component-release-${mode}`
    const author = join(worktreeHomeRoot({ repo: w.work }), `component-release-${mode}`)
    const base = (await w.git(["rev-parse", "HEAD"])).trim()
    await freshWorktree(w.git, w.work, base, author, { selection: w.git.selection })
    const authorGit = gitIn(author)
    await authorGit(["checkout", "--quiet", "-b", rootBranch])
    const componentBranch = `topic/released-component-${mode}`
    const component = join(author, "vendor/dependency")
    const primaryComponent = join(w.work, "vendor/dependency")
    if (mode === "shared") {
      // A native linked component uses the surviving primary's ref store, not a copied snapshot.
      // raw-delete-allow: this isolated fixture replaces its own clean component clone before authoring
      rmSync(component, { recursive: true })
      await gitIn(primaryComponent)(["worktree", "add", "--quiet", "-b", componentBranch, component, "HEAD"])
    } else {
      await gitIn(component)(["checkout", "--quiet", "-b", componentBranch])
    }
    const componentGit = gitIn(component)
    await componentGit(["remote", "set-url", "origin", `https://git-super.test/owned/release-child-${mode}.git`])
    expect((await componentGit(["config", "--get", "remote.origin.url"])).trim()).toBe(
      `https://git-super.test/owned/release-child-${mode}.git`,
    )
    await componentGit(["config", "user.email", "component-release@yrd.test"])
    await componentGit(["config", "user.name", "component release"])
    writeFileSync(join(component, "READY"), "authored component\n")
    await componentGit(["commit", "--quiet", "-am", "component author work"])
    const componentTip = (await componentGit(["rev-parse", "HEAD"])).trim()
    const componentStore = (await inspectCheckoutGitMetadata(component)).commonDirectory
    await authorGit(["add", "vendor/dependency"])
    await authorGit(["commit", "--quiet", "-m", "deliver component\n\nRefs: @example/29340-component-release"])
    const rootTip = (await authorGit(["rev-parse", "HEAD"])).trim()
    await w.git(["worktree", "lock", "--reason", "component custody fixture awaiting explicit close", author])
    const submitted = capture(author)
    expect(await runYrdProcess(["bun", "yrd", "submit", "--json"], submitted.io), submitted.stderr()).toBe(0)
    const landed = capture(w.work)
    expect(
      await runYrdProcess(["bun", "yrd", "queue", "run", "--queue", "main", "--json"], landed.io),
      landed.stderr(),
    ).toBe(0)
    expect(JSON.parse(landed.stdout())).toMatchObject({ merged: [rootBranch] })
    expect(existsSync(author)).toBe(true)
    expect((await componentGit(["rev-parse", `refs/heads/${componentBranch}`])).trim()).toBe(componentTip)
    const advancedTip =
      mode === "advanced"
        ? (
            await componentGit([
              "commit-tree",
              `${componentTip}^{tree}`,
              "-p",
              componentTip,
              "-m",
              "new component work after author capture",
            ])
          ).trim()
        : undefined

    await w.git(["worktree", "unlock", author])

    const closed = capture(w.work)
    const stderr = closed.io.stderr
    let proofPath = ""
    let sealedManifest: Buffer | undefined
    closed.io.stderr = (text) => {
      stderr(text)
      const prefix = "retained environment removal proof "
      if (text.startsWith(prefix)) {
        proofPath = text.slice(prefix.length).trim()
        sealedManifest = readFileSync(proofPath)
      }
    }
    let releaseReads = 0
    if (mode === "unsealed") {
      const prepared = await publicCli.prepareAuthorRelease(author, closed.io)
      expect(prepared.kind).toBe("eligible")
      if (prepared.kind !== "eligible") throw new Error(JSON.stringify(prepared))
      using handle = prepared.handle
      // raw-delete-allow: simulate a worktree delegate removal that releases the checkout without a git-super sealed proof
      rmSync(author, { recursive: true })
      await w.git(["worktree", "prune"])
      const release = await handle.retireAfterRelease()
      expect(release).toMatchObject({
        retirement: "incomplete",
        reasons: [expect.stringContaining("root-owned component store kept: no sealed proof")],
      })
      expect(closed.stderr()).toContain("retirement incomplete; inspect ref and archive")
      expect(closed.stderr()).toContain("root-owned component store kept: no sealed proof")
    } else {
      const exit =
        mode === "advanced"
          ? await closeEnvironment(author, { json: true }, closed.io, undefined, "delegate", async () => {
              // The second existing intent check is after author capture and before retention seals.
              if (++releaseReads !== 2) return
              await componentGit(["checkout", "--quiet", "--detach", componentTip])
              await componentGit(["update-ref", `refs/heads/${componentBranch}`, advancedTip!, componentTip])
            })
          : await runYrdProcess(["bun", "yrd", "env", "close", author, "--json"], closed.io)
      expect(exit, closed.stderr()).toBe(0)
      expect(proofPath).not.toBe("")
      expect(readFileSync(proofPath)).toEqual(sealedManifest)
      const entry = dirname(proofPath)
      const verified = await verifyRetainedEntry({
        entry,
        root: dirname(entry),
        artifactDir: join(dirname(w.work), `copy-proof-${mode}`),
        allowTemporaryArtifactDir: true,
        clock: new Date("2099-01-01T00:00:00.000Z"),
        namespaceRoots: [w.work],
      })
      expect(
        verified.gates.find((gate) => gate.gate === "copy-manifest"),
        JSON.stringify(verified),
      ).toMatchObject({ status: "pass" })
      expect(readFileSync(proofPath)).toEqual(sealedManifest)
    }
    expect(existsSync(author)).toBe(false)
    expect((await w.git(["for-each-ref", "--format=%(objectname)", `refs/heads/${rootBranch}`])).trim()).toBe("")
    expect((await w.git(["for-each-ref", "--format=%(objectname)", "refs/archive/"])).trim().split("\n")).toContain(
      rootTip,
    )
    expect((await w.git(["ls-remote", "origin", "refs/archive/*"])).trim()).toContain(rootTip)
    if (mode === "shared") {
      const registrations = await gitIn(componentStore)(["worktree", "list", "--porcelain"])
      expect(registrations, `${closed.stderr()}\nNative child registrations:\n${registrations}`).not.toContain(
        `worktree ${component}\n`,
      )
      expect(
        (
          await gitIn(componentStore)(["for-each-ref", "--format=%(objectname)", `refs/heads/${componentBranch}`])
        ).trim(),
        closed.stderr(),
      ).toBe("")
      expect(
        (await gitIn(componentStore)(["for-each-ref", "--format=%(objectname)", "refs/archive/"])).trim().split("\n"),
      ).toContain(componentTip)
    } else if (mode === "advanced") {
      expect(releaseReads).toBe(2)
      expect(JSON.parse(closed.stdout())).toMatchObject({ closed: author, retirement: "incomplete" })
      expect(closed.stderr()).toContain("kept")
      expect(closed.stderr()).toContain(`refs/heads/${componentBranch}`)
      expect(closed.stderr()).toContain(advancedTip)
      expect(closed.stderr()).not.toContain("ended with its root")
    } else if (mode !== "unsealed") {
      const proof = JSON.parse(sealedManifest!.toString("utf8")) as { retainUntil: string }
      expect(closed.stderr()).toContain("ended with its root")
      expect(closed.stderr()).toContain(`refs/heads/${componentBranch}`)
      expect(closed.stderr()).toContain(componentTip)
      expect(closed.stderr()).toMatch(/landing [0-9a-f]{40}; sealed proof/u)
      expect(closed.stderr()).toContain(proofPath)
      expect(closed.stderr()).toContain(proof.retainUntil)
      expect(closed.stderr()).not.toContain("retirement incomplete")
      expect(closed.stderr()).not.toContain(`its cwd '${componentStore}' does not exist`)
    }
  },
  60_000,
)

/** @failure An external native release cannot retry merged refs without leaking private context,
 * or reuses a stale/disposed handle and retires a newly bound checkout.
 * @level l3 @consumer hosts composing successful native reset/remove with @yrd/cli
 * Native close alone cannot prove the public handle's release identity, named result or single-use contract.
 */
it.each(["released", "unreleased", "rebound", "reused", "disposed", "unreadable", "none"] as const)(
  "public author release preserves exact native identity: %s",
  async (mode) => {
    const w = await world(":")
    await birthEventQueue(w.work, "main", { localStore: false })
    const opened = capture(w.work)
    expect(
      await runYrdProcess(
        ["bun", "yrd", "env", "open", "--bay", `public-release-${mode}`, "--keep", "--json"],
        opened.io,
      ),
      opened.stderr(),
    ).toBe(0)
    const author = (JSON.parse(opened.stdout()) as { path: string }).path
    const authorGit = gitIn(author)
    const branch = `task/public-release-${mode}`
    await authorGit(["commit", "--quiet", "--allow-empty", "-m", "author work\n\nRefs: @example/29340-public-release"])
    const head = (await authorGit(["rev-parse", "HEAD"])).trim()
    if (mode !== "none") {
      const submitted = capture(author)
      expect(await runYrdProcess(["bun", "yrd", "submit", "--json"], submitted.io), submitted.stderr()).toBe(0)
      const landed = capture(w.work)
      expect(
        await runYrdProcess(["bun", "yrd", "queue", "run", "--queue", "main", "--json"], landed.io),
        landed.stderr(),
      ).toBe(0)
      expect(JSON.parse(landed.stdout())).toMatchObject({ merged: [branch] })
    }
    const output = capture(w.work)
    if (mode === "unreadable") await w.git(["remote", "set-url", "origin", join(dirname(w.work), "missing-remote.git")])
    const prepared = await publicCli.prepareAuthorRelease(author, output.io)
    if (mode === "none" || mode === "unreadable") {
      expect(prepared).toMatchObject({ kind: mode, reason: expect.any(String) })
      if (prepared.kind === "unreadable") expect(prepared.reads.length).toBeGreaterThan(0)
      expect((await w.git(["rev-parse", `refs/heads/${branch}`])).trim()).toBe(head)
      expect((await w.git(["for-each-ref", "refs/archive/"])).trim()).toBe("")
      return
    }
    expect(prepared.kind).toBe("eligible")
    if (prepared.kind !== "eligible") throw new Error(JSON.stringify(prepared))
    using handle = prepared.handle
    if (mode === "disposed") {
      handle[Symbol.dispose]()
      await expect(handle.retireAfterRelease()).rejects.toMatchObject({ name: "AuthorReleaseDisposed" })
    } else {
      let expectedHead = head
      if (mode === "reused") {
        await authorGit(["commit", "--quiet", "--allow-empty", "-m", "new unsubmitted work"])
        expectedHead = (await authorGit(["rev-parse", "HEAD"])).trim()
      }
      if (mode === "rebound") await authorGit(["checkout", "--quiet", "--detach", "main"])
      else if (mode !== "unreleased") await w.git(["worktree", "remove", author])
      await handle.retireAfterRelease()
      await expect(handle.retireAfterRelease()).rejects.toMatchObject({ name: "AuthorReleaseAlreadyUsed" })
      const retired = mode === "released" || mode === "rebound"
      expect((await w.git(["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`])).trim()).toBe(
        retired ? "" : expectedHead,
      )
      const archives = (await w.git(["for-each-ref", "--format=%(objectname)", "refs/archive/"])).trim().split("\n")
      if (retired) expect(archives).toContain(head)
      else expect(archives).not.toContain(head)
      if (mode === "unreleased") expect(output.stderr()).toContain("still bound")
    }
  },
  60_000,
)

async function addMaterializedDependency(w: World): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-env-submodule-"))
  roots.push(root)
  const seed = gitIn(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "env-open@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, "READY"), "materialized\n")
  await git(["add", "READY"])
  await git(["commit", "--quiet", "-m", "seed materialized dependency"])
  await git(["push", "--quiet", "origin", "main"])
  await w.git(["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", remote, "vendor/dependency"])
  await w.git(["commit", "--quiet", "-m", "add materialized dependency"])
  await w.git(["push", "--quiet", "origin", "main"])
}

describe("yrd env open prepares the retained environment", () => {
  it("resolves a configured relative workdir against the repository, not the caller's subdirectory", async () => {
    const w = await world(":")
    await w.git(["config", "yrd.workdir", "relative-state"])
    const nested = join(w.work, "nested")
    mkdirSync(nested)
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const cli = join(dirname(fileURLToPath(import.meta.url)), "../../../bin/yrd.ts")
    const run = await command(nested, [process.execPath, cli, "env", "open", selected, "--json"])
    expect(run, run.stderr).toMatchObject({ exit: 0 })
    const { path } = JSON.parse(run.stdout) as { path: string }
    // The queue root sits under the configured workdir since 25716 row 9; the root is what resolves (25848).
    expect(path.startsWith(join(w.work, "relative-state") + "/")).toBe(true)
    expect(path).toContain(`${sep}environments${sep}`)
    const listed = await command(nested, [process.execPath, cli, "env", "list", "--json"])
    expect(listed, listed.stderr).toMatchObject({ exit: 0 })
    expect(JSON.parse(listed.stdout)).toMatchObject({ environments: [{ path, head: selected }] })
  })

  // The library materializer cannot prove this process boundary: a plain
  // commit needs no tool, and a required CLI must return a trustworthy result.
  it.each(["plain", "missing", "malformed", "partial", "mismatched"])(
    "honours the git-super boundary when %s",
    async (mode) => {
      const w = await world(":")
      const plain = (await w.git(["rev-parse", "HEAD"])).trim()
      await addMaterializedDependency(w)
      const selected = mode === "plain" ? plain : (await w.git(["rev-parse", "HEAD"])).trim()
      const bin = join(w.work, "fixture-bin")
      mkdirSync(bin)
      const git = Bun.which("git")
      const sh = Bun.which("sh")
      expect(git).not.toBeNull()
      expect(sh).not.toBeNull()
      symlinkSync(git!, join(bin, "git"))
      symlinkSync(sh!, join(bin, "sh"))
      if (mode === "malformed") {
        writeFileSync(join(bin, "git-super"), "#!/bin/sh\nprintf 'not-json\\n'\n")
        chmodSync(join(bin, "git-super"), 0o755)
      } else if (mode === "partial" || mode === "mismatched") {
        // Valid JSON and exit zero are insufficient: the external report must
        // attest this exact path/commit and complete, not partial, success.
        writeFileSync(
          join(bin, "git-super"),
          `#!${process.execPath}\nconsole.log(JSON.stringify({
        state: "updated", partial: ${mode === "partial"},
        path: process.argv[5], requested: process.argv[6],
        commit: ${mode === "mismatched" ? '"0".repeat(40)' : "process.argv[6]"},
        gitmodules: true,
        gitlinks: {considered: 1, borrowed: 1, fetched: 0, absent: 0},
        repositories: [{repository: process.cwd(), state: "updated", refs: []}]
      }))\n`,
        )
        chmodSync(join(bin, "git-super"), 0o755)
      }
      const cli = join(dirname(fileURLToPath(import.meta.url)), "../../../bin/yrd.ts")
      const run = await command(w.work, [process.execPath, cli, "env", "open", selected, "--json"], {
        ...process.env,
        PATH: bin,
        YRD_GIT_SUPER_BIN: join(bin, "git-super"),
      })
      if (mode === "plain") {
        expect(run, run.stderr).toMatchObject({ exit: 0 })
        const { path } = JSON.parse(run.stdout) as { path: string }
        expect(existsSync(join(path, ".gitmodules"))).toBe(false)
        expect((await gitIn(path)(["rev-parse", "HEAD"])).trim()).toBe(plain)
      } else {
        expect(run, run.stderr).toMatchObject({ exit: 2, stdout: "" })
        expect(run.stderr).toContain(mode === "missing" ? "requires git-super" : "malformed git-super")
        const listed = capture(w.work)
        expect(await runYrdProcess(["bun", "yrd", "env", "list", "--json"], listed.io)).toBe(0)
        expect(JSON.parse(listed.stdout())).toEqual({ environments: [] })
      }
    },
  )

  it.each(["branch", "unknown", "blob"])("refuses a %s before creating an environment", async (kind) => {
    const w = await world(":")
    const operand =
      kind === "branch"
        ? "main"
        : kind === "unknown"
          ? "0".repeat(40)
          : (await w.git(["rev-parse", "HEAD:.yrd.yml"])).trim()
    const run = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "open", operand, "--json"], run.io)).toBe(2)
    expect(run.stderr()).toContain(operand)
    expect(run.stdout()).toBe("")
    const listed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "list", "--json"], listed.io)).toBe(0)
    expect(JSON.parse(listed.stdout())).toEqual({ environments: [] })
  })

  it("opens the exact commit detached and runs that commit's setup", async () => {
    const w = await world("printf 'selected commit\\n' > selected-setup.txt")
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    writeFileSync(join(w.work, ".yrd.yml"), "setup: printf 'newer commit\\n' > selected-setup.txt\n")
    await w.git(["add", ".yrd.yml"])
    await w.git(["commit", "--quiet", "-m", "change setup after selected commit"])
    await w.git(["push", "--quiet", "origin", "main"])
    const current = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(w.work, selected)
    expect((await gitIn(path)(["rev-parse", "HEAD"])).trim()).toBe(selected)
    expect((await gitIn(path)(["branch", "--show-current"])).trim()).toBe("")
    expect(readFileSync(join(path, "selected-setup.txt"), "utf8")).toBe("selected commit\n")
    expect((await w.git(["rev-parse", "HEAD"])).trim()).toBe(current)
  })

  it("runs the target's declared setup after materialization", async () => {
    const w = await world(
      "bun --version >/dev/null && test -f vendor/dependency/READY && printf '%s\\n' \"$YRD_REPO\" > setup-ready.txt",
    )
    await addMaterializedDependency(w)
    const run = capture(w.work)

    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    expect(await runYrdProcess(["bun", "yrd", "env", "open", selected], run.io), run.stderr()).toBe(0)

    const bay = run.stdout().trim()
    expect(run.stderr()).toContain("detached")
    expect(run.stderr()).toContain("cut from")
    expect(run.stderr()).not.toMatch(/reus/iu)
    expect(readFileSync(join(bay, "setup-ready.txt"), "utf8")).toBe(`${bay}\n`)
    expect((await gitIn(bay)(["branch", "--show-current"])).trim()).toBe("")
  })

  it("opens the same exact commit twice without attaching or moving its branch", async () => {
    const w = await world('printf \'%s\\n%s\\n\' "$YRD_BASE_SHA" "$YRD_CANDIDATE_SHA" > setup-tree.txt')
    await w.git(["checkout", "--quiet", "-b", "task/reopened"])
    writeFileSync(join(w.work, "branch.txt"), "branch change\n")
    await w.git(["add", "branch.txt"])
    await w.git(["commit", "--quiet", "-m", "change on retained branch"])
    const candidate = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    writeFileSync(join(w.work, "main.txt"), "target change\n")
    await w.git(["add", "main.txt"])
    await w.git(["commit", "--quiet", "-m", "advance target"])
    await w.git(["push", "--quiet", "origin", "main"])
    const { path: bay } = await openEnvironment(w.work, candidate)
    expect(readFileSync(join(bay, "setup-tree.txt"), "utf8")).toBe(`${candidate}\n${candidate}\n`)

    const { path: reopened } = await openEnvironment(w.work, candidate)
    expect(reopened).not.toBe(bay)
    expect(readFileSync(join(reopened, "setup-tree.txt"), "utf8")).toBe(`${candidate}\n${candidate}\n`)
    expect((await w.git(["rev-parse", "refs/heads/task/reopened"])).trim()).toBe(candidate)
  })

  it("keeps a failed environment and reports its command and output", async () => {
    const command = "printf 'setup exploded\\n' >&2; exit 23"
    const w = await world(command)
    const run = capture(w.work)

    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    expect(await runYrdProcess(["bun", "yrd", "env", "open", selected], run.io)).toBe(2)

    const listed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "list", "--json"], listed.io), listed.stderr()).toBe(0)
    const rows = JSON.parse(listed.stdout()) as { environments: { path: string }[] }
    expect(rows.environments).toHaveLength(1)
    const bay = rows.environments[0]!.path
    expect(run.stdout()).toBe("")
    expect(existsSync(bay)).toBe(true)
    expect(await w.git(["worktree", "list", "--porcelain"])).toContain(bay)
    expect((await gitIn(bay)(["branch", "--show-current"])).trim()).toBe("")
    expect(run.stderr()).toContain(command)
    expect(run.stderr()).toContain("exit 23")
    expect(run.stderr()).toContain("exit 23 is not a verdict")
    expect(run.stderr()).toContain("setup exploded")
    expect(run.stderr()).toContain(bay)
  })

  /**
   * @failure 26906: `yrd env open`'s failed-setup report dropped the frozen-lockfile diagnosis,
   *          and the retained bay's lockfile was left rewritten by it, so the caller could not
   *          tell its own starting bytes from the diagnosis's dependency change.
   * @level l2 (real `bun install --frozen-lockfile` refusal through `yrd env open`)
   * @consumer every seat whose environment setup fails a frozen install
   */
  it("keeps a failed frozen install's lockfile bytes and names the diagnosis (26906)", async () => {
    const w = await world("bun install --frozen-lockfile")
    const manifest = (version: string): string =>
      `${JSON.stringify(
        { dependencies: { "fixture-dep": `file:./vendor-${version}` }, name: "fixture-root", version: "0.0.0" },
        null,
        2,
      )}\n`
    await w.git(["checkout", "--quiet", "main"])
    for (const version of ["1.0.0", "2.0.0"]) {
      mkdirSync(join(w.work, `vendor-${version}`), { recursive: true })
      writeFileSync(
        join(w.work, `vendor-${version}`, "package.json"),
        `${JSON.stringify({ name: "fixture-dep", version }, null, 2)}\n`,
      )
    }
    writeFileSync(join(w.work, "package.json"), manifest("1.0.0"))
    // The one moment a lockfile is GENERATED rather than diffed: a real, offline `bun install`
    // against the BEFORE manifest, in the fixture's own work tree.
    const seeded = await command(w.work, ["bun", "install"])
    expect(seeded, seeded.stderr).toMatchObject({ exit: 0 })
    const locked = readFileSync(join(w.work, "bun.lock"), "utf8")
    // The candidate raises the dependency in package.json ALONE, never touching the lockfile:
    // 24140's own repro for a `bun install --frozen-lockfile` that refuses without naming what moved.
    writeFileSync(join(w.work, "package.json"), manifest("2.0.0"))
    await w.git(["add", "package.json", "bun.lock", "vendor-1.0.0", "vendor-2.0.0"])
    await w.git(["commit", "--quiet", "-m", "raise the dependency without the lockfile"])
    await w.git(["push", "--quiet", "origin", "main"])
    const run = capture(w.work)

    expect(await runYrdProcess(["bun", "yrd", "env", "open", "--bay", "frozen"], run.io), run.stderr()).toBe(2)

    const listed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "list", "--json"], listed.io), listed.stderr()).toBe(0)
    const rows = JSON.parse(listed.stdout()) as { environments: { path: string }[] }
    expect(rows.environments).toHaveLength(1)
    const bay = rows.environments[0]!.path
    expect(existsSync(bay), run.stderr()).toBe(true)
    // The failure text names the diagnosis and what moved.
    expect(run.stderr()).toContain("frozen-lockfile diagnosis")
    expect(run.stderr()).toContain("fixture-dep")
    // And the retained bay's tracked lockfile is byte-identical to the candidate's.
    expect(readFileSync(join(bay, "bun.lock"), "utf8")).toBe(locked)
  })
})

describe("yrd env close preserves anything it cannot safely remove", () => {
  /**
   * @failure 28120: symlinked environment paths missed kernel-resolved cwd holders.
   * @level l1 (real filesystem symlink at the shared containment boundary)
   * @consumer the queue's early holder filter and authoritative close admission
   */
  it("finds a holder through a symlinked environment path (28120)", () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-holder-symlink-"))
    roots.push(root)
    const target = join(root, "physical")
    const alias = join(root, "alias")
    mkdirSync(target)
    symlinkSync(target, alias, "dir")
    const holder = { pid: 4242, cwd: realpathSync(target) }
    expect(environmentCwdHolder(alias, { rows: [holder], unreadable: [], complete: true, mechanism: "proc" })).toEqual(
      holder,
    )
  })

  /**
   * @failure 28991: `yrd env close --retain --json` consumed the `--json` flag as
   *          the retention directory and resolved it against the caller's cwd, so
   *          the close wrote a git-super retention tree into a `--json/` directory
   *          in whatever directory yrd ran in - on Oct 13 00:39 the shared CODE
   *          projection /hh/dev, which the root-shape guard read as a new root entry.
   * @level   l2 (real CLI against a real retained worktree)
   * @consumer every caller whose `--retain` value is not an absolute path
   */
  it("refuses a non-absolute --retain instead of resolving it against the caller's cwd (28991)", async () => {
    const w = await world(":")
    const { path } = await openEnvironment(w.work, (await w.git(["rev-parse", "HEAD"])).trim())
    const run = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--retain", "--json"], run.io), run.stderr()).toBe(
      2,
    )
    expect(run.stderr()).toContain("--retain")
    expect(run.stderr()).toMatch(/\babsolute\b/)
    expect(existsSync(join(w.work, "--json"))).toBe(false)
    expect(existsSync(path)).toBe(true)
    expect(await w.git(["worktree", "list", "--porcelain"])).toContain(path)
  })

  /** @failure Automatic custody is lost on a plain checkout, its keep is mistaken for a removal,
   * or manual/no-rehome closes accidentally acquire the automatic policy.
   * @level l2
   * @consumer the automatic close caller crossing the selected GitSuper CLI boundary
   */
  it.each(["manual", "no-rehome", "blocked", "unknown", "malformed-status", "malformed-detail"] as const)(
    "forwards explicit automatic component custody through selected Git and handles %s",
    async (mode) => {
      const w = await world(":")
      const { path } = await openEnvironment(w.work, (await w.git(["rev-parse", "HEAD"])).trim())
      const shim = join(dirname(w.work), "custody-git-super")
      const calls = join(dirname(w.work), "custody-git-super.jsonl")
      writeFileSync(calls, "")
      const custody = {
        status: mode === "malformed-status" ? "unexpected" : mode === "unknown" ? "unknown" : "blocked",
        component: "component",
        source: "persistent primary",
        ...(mode === "malformed-detail" ? {} : { detail: "unproved component commit", oid: "a".repeat(40) }),
      }
      writeFileSync(
        shim,
        `#!${process.execPath}\nimport {appendFileSync} from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args, marker:process.env.YRD_SELECTED_TEST_MARKER})+"\\n");
console.log(JSON.stringify(args.includes("--component-custody")
  ? {state:"unchanged",path:args[3],reason:"component-custody",custody:${JSON.stringify(custody)}}
  : {state:"unchanged",path:args[3],reason:"borrowed",borrowers:["fixture borrower"]}));\n`,
        { mode: 0o700 },
      )
      vi.stubEnv("YRD_GIT_SUPER_BIN", shim)
      vi.stubEnv("YRD_SELECTED_TEST_MARKER", "custody-forwarding")
      const automatic = mode !== "manual" && mode !== "no-rehome"
      const policy = { primaryRoot: w.work, targetBranch: "main" }
      const closed = capture(w.work)
      const closing = closeEnvironment(
        path,
        {
          json: true,
          ...(mode === "no-rehome" ? { noRehome: true } : {}),
          ...(automatic ? { componentCustody: policy } : {}),
        },
        closed.io,
      )
      if (mode.startsWith("malformed")) {
        await expect(closing).rejects.toThrow("malformed git-super removal proof")
        expect(closed.stdout()).toBe("")
      } else {
        expect(await closing, closed.stderr()).toBe(0)
        expect(JSON.parse(closed.stdout())).toEqual(
          automatic
            ? { kept: path, reason: "component-custody", custody }
            : mode === "no-rehome"
              ? { kept: path, reason: "borrowed", borrowers: ["fixture borrower"] }
              : { closed: path },
        )
      }
      expect(existsSync(path)).toBe(mode !== "manual")
      const removes = readFileSync(calls, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const value: unknown = JSON.parse(line)
          if (
            typeof value !== "object" ||
            value === null ||
            !("marker" in value) ||
            typeof value.marker !== "string" ||
            !("args" in value) ||
            !Array.isArray(value.args)
          ) {
            throw new Error("malformed selected GitSuper shim record")
          }
          const args: unknown[] = value.args
          if (!args.every((argument): argument is string => typeof argument === "string")) {
            throw new Error("malformed selected GitSuper shim arguments")
          }
          return { marker: value.marker, args }
        })
      expect(removes).toHaveLength(mode === "manual" ? 0 : 1)
      if (removes[0] !== undefined) {
        expect(removes[0].marker).toBe("custody-forwarding")
        const flag = removes[0].args.indexOf("--component-custody")
        if (automatic) {
          expect(flag).toBeGreaterThan(-1)
          expect(JSON.parse(removes[0].args[flag + 1]!)).toEqual(policy)
        } else expect(flag).toBe(-1)
      }
    },
  )

  /**
   * 29073 (@cto shape A): yrd reaches the worktree preserve across the CLI boundary at
   * `${root}/tools/worktree.ts` (never a workspace dependency on bearly). This fixture stands in for
   * that CLI — the real verb and the real preserve are proven in vendor/bearly's own suite (the
   * `preserve` verb over preserveSlotState) — so these rows prove YRD's half of the contract: it
   * spawns the CLI, reads the JSON receipt, passes each ref to `git super worktree remove --preserved`,
   * and admits the dirty store only because the ref resolves in it. Like the real verb, the stub
   * writes one recovery ref in the ROOT store and one in each dirty component's own store, under the
   * SAME ref name, and returns them in the receipt.
   */
  function installStubWorktreePreserve(
    root: string,
    options: {
      badReceipt?: boolean
      badPath?: boolean
      exitOverride?: number
      stderr?: string
      noReceipt?: boolean
      /** Repositories the stub reports as consulted and skipped, as bearly does since 29392 (29406). */
      skipped?: ReadonlyArray<{ path: string; head: string; reason: string }>
    } = {},
  ): void {
    mkdirSync(join(root, "tools"), { recursive: true })
    const source = STUB_WORKTREE_PRESERVE_CLI.replace("__BAD_RECEIPT__", options.badReceipt === true ? "true" : "false")
      .replace("__BAD_PATH__", options.badPath === true ? "true" : "false")
      .replace("__STDERR__", JSON.stringify(options.stderr ?? ""))
      .replace("__NO_RECEIPT__", options.noReceipt === true ? "true" : "false")
      .replace("__EXIT_OVERRIDE__", options.exitOverride === undefined ? '""' : String(options.exitOverride))
      .replace("__SKIPPED__", JSON.stringify(options.skipped ?? []))
    writeFileSync(join(root, "tools", "worktree.ts"), source)
  }

  const STUB_WORKTREE_PRESERVE_CLI = `#!/usr/bin/env bun
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

const argv = process.argv.slice(2)
const target = argv[1]
if (argv[0] !== "preserve" || target === undefined) {
  console.error("stub worktree: usage: preserve <path> [--json]")
  process.exit(64)
}
const git = (cwd, args, env) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", ...(env === undefined ? {} : { env }) })
  if (r.status !== 0) {
    console.error("stub worktree: git " + args.join(" ") + " failed: " + r.stderr)
    process.exit(70)
  }
  return r.stdout.trim()
}
const dirty = (cwd) =>
  git(cwd, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=all"]).length > 0
const snapshot = (cwd) => {
  const index = join(mkdtempSync(join(tmpdir(), "stub-preserve-")), "index")
  const env = { ...process.env, GIT_INDEX_FILE: index }
  const parent = git(cwd, ["rev-parse", "HEAD"])
  git(cwd, ["read-tree", "HEAD"], env)
  git(cwd, ["add", "-A"], env)
  const tree = git(cwd, ["write-tree"], env)
  return git(cwd, ["commit-tree", tree, "-p", parent, "-m", "stub worktree preserve"], env)
}
const bad = __BAD_RECEIPT__
const badPath = __BAD_PATH__
// The preserve verb's exit code for the two honest endings: 0 (preserved) or 3
// (nothing preserved). An override forces an unexpected exit to prove yrd refuses it.
const exitOverride = __EXIT_OVERRIDE__
const skipped = __SKIPPED__
process.stderr.write(__STDERR__)
if (__NO_RECEIPT__) process.exit(exitOverride === "" ? 1 : Number(exitOverride))
const receipt = (body) => {
  const out = bad ? { ...body, schema: "stub-worktree-preserve/1" } : { ...body }
  if (badPath) delete out.path
  process.stdout.write(JSON.stringify(out) + "\\n")
}
const slot = basename(target)
const ref = "wip/" + slot + "-preserve-stub"
const components = []
if (existsSync(join(target, ".gitmodules"))) {
  for (const line of git(target, ["config", "-f", ".gitmodules", "--list"]).split("\\n")) {
    const eq = line.indexOf("=")
    if (eq < 0 || !line.slice(0, eq).endsWith(".path")) continue
    components.push(line.slice(eq + 1))
  }
}
const submodules = []
let rootDirty = dirty(target)
for (const path of components) {
  const component = join(target, path)
  if (!existsSync(component) || !dirty(component)) continue
  const sha = snapshot(component)
  git(component, ["update-ref", "refs/heads/" + ref, sha])
  submodules.push({ path, ref, sha })
  rootDirty = true
}
if (!rootDirty) {
  receipt({ schema: "bearly-worktree-preserve/1", slot, path: target, preserved: false, reason: "clean", ref: null, sha: null, submodules: [], skipped })
  process.exit(exitOverride === "" ? 3 : Number(exitOverride))
}
const sha = snapshot(target)
git(target, ["update-ref", "refs/heads/" + ref, sha])
receipt({ schema: "bearly-worktree-preserve/1", slot, path: target, preserved: true, reason: "dirty", ref, sha, submodules, skipped })
process.exit(exitOverride === "" ? 0 : Number(exitOverride))
`

  /**
   * @failure 29073: a dirty abandoned environment had NO sanctioned preserve-then-remove path -
   *          `yrd env close` refuses dirt and the destructive git verbs are banned, so an
   *          environment whose uncommitted bytes forensics judged worthless could not be retired
   *          at all. `--preserve` composes the ONE existing worktree preserve (bearly's
   *          preserveSlotState) before the clean gate. That implementation's own test
   *          (vendor/bearly tests/worktree-preserve.slow.test.ts) proves the live index and
   *          worktree are untouched; this test proves the flag composes it and that ROOT and
   *          COMPONENT dirt both land under the existing custody convention.
   * @level   l2 (real CLI, real bare remote, real materialized submodule)
   * @consumer every seat closing an abandoned environment whose dirt cannot be committed
   */
  it("env close --preserve composes the one worktree preserve for ROOT and COMPONENT dirt (29073)", async () => {
    const w = await world(":")
    await addMaterializedDependency(w)
    // yrd resolves the preserve CLI through the superproject root it already holds (one stated path).
    installStubWorktreePreserve(w.work)
    const { path } = await openEnvironment(w.work, (await w.git(["rev-parse", "HEAD"])).trim())

    // Dirty root AND dirty component: the class the plain close refuses.
    writeFileSync(join(path, "root-dirt.txt"), "root preserved\n")
    writeFileSync(join(path, "vendor/dependency/READY"), "component preserved\n")
    const refused = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], refused.io), refused.stderr()).toBe(2)
    expect(refused.stderr()).toContain("is dirty")
    expect(refused.stderr()).toContain("--preserve")
    expect(existsSync(path)).toBe(true)

    const run = capture(w.work)
    expect(
      await runYrdProcess(["bun", "yrd", "env", "close", path, "--preserve", "--json"], run.io),
      run.stderr(),
    ).toBe(0)
    expect(run.stderr()).toContain("preserved dirty state")
    // 29101 landed (bearly bda68df): the preserve now also keeps a divergent staged index,
    // recoverable at <ref>^2, so the retired working-tree-only claim must NOT reappear here.
    expect(run.stderr()).not.toContain("a staged version that differs from it is not kept")
    // yrd forwarded the COMPONENT ref too: the close SUCCEEDED with a dirty component, which
    // git super admits only against a preserved ref that resolves in that component's own store.
    expect(run.stderr()).toContain("submodules: vendor/dependency@")
    expect(existsSync(path)).toBe(false)

    // The retired limit must not resurface in the help a reader lands on; the truthful
    // teardown-after-preserve boundary stays stated there.
    const help = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", "--help"], help.io)).toBe(0)
    expect(help.stdout()).not.toContain("a staged version that differs from it is not kept")
    expect(help.stdout()).toContain("bytes a teardown writes afterwards are not preserved")

    // The root recovery ref resolves in the root store yrd handed `git super --preserved`, and
    // carries the ROOT dirt's bytes (the component's own custody lives in vendor/bearly's suite).
    const rootRefs = (await w.git(["for-each-ref", "--format=%(refname)", "refs/heads/wip/"]))
      .trim()
      .split("\n")
      .filter(Boolean)
    expect(rootRefs).toHaveLength(1)
    const rootRef = rootRefs[0]!
    expect((await w.git(["show", `${rootRef}:root-dirt.txt`])).trim()).toBe("root preserved")
  })

  /**
   * @failure 29073: `--preserve` on a commit that declares NO submodules (no `.gitmodules`) had no
   *          verified removal path — the plain `git worktree remove` refuses dirt, and the verified
   *          ref gate lived only on the git-super path. @cto ruled the no-submodule close takes the
   *          SAME git-super primitive when `--preserve` is set, so the gate has one home; without
   *          `--preserve` the plain path is unchanged.
   * @level   l2 (real CLI, real bare remote, no submodules)
   * @consumer every seat closing a dirty abandoned environment that records no submodules
   */
  it("env close --preserve routes a no-submodule dirty environment through the same verified gate (29073)", async () => {
    const w = await world(":")
    expect((await w.git(["ls-tree", "HEAD", "--", ".gitmodules"])).trim()).toBe("")
    installStubWorktreePreserve(w.work)
    const { path } = await openEnvironment(w.work, (await w.git(["rev-parse", "HEAD"])).trim())

    writeFileSync(join(path, "root-dirt.txt"), "root preserved\n")
    const refused = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], refused.io), refused.stderr()).toBe(2)
    expect(refused.stderr()).toContain("is dirty")
    expect(refused.stderr()).toContain("--preserve")
    expect(existsSync(path)).toBe(true)

    const run = capture(w.work)
    expect(
      await runYrdProcess(["bun", "yrd", "env", "close", path, "--preserve", "--json"], run.io),
      run.stderr(),
    ).toBe(0)
    expect(run.stderr()).toContain("preserved dirty state")
    expect(run.stderr()).toContain("retained environment removal proof")
    expect(existsSync(path)).toBe(false)
    const refs = (await w.git(["for-each-ref", "--format=%(refname)", "refs/heads/wip/"]))
      .trim()
      .split("\n")
      .filter(Boolean)
    expect(refs).toHaveLength(1)
    expect((await w.git(["show", `${refs[0]}:root-dirt.txt`])).trim()).toBe("root preserved")
  })

  /**
   * @failure 29406: bearly's receipt names the repositories it consulted and skipped (a child shared
   *          main has no primary store for, clean on its recorded pin — 29392), and yrd dropped that
   *          list at its boundary: the operator was never told vendor/brain8 was skipped.
   * @level   l2 (real CLI, real bare remote, stub preserve CLI printing one skipped repository)
   * @consumer every seat closing an environment with a storeless child
   */
  it("env close --preserve names each skipped repository in its stderr line and --json receipt (29406)", async () => {
    const w = await world(":")
    const skipped = {
      path: "vendor/brain8",
      head: "0123456789abcdef0123456789abcdef01234567",
      reason: "clean on its recorded pin; shared main has no primary store for it",
    }
    installStubWorktreePreserve(w.work, { skipped: [skipped] })
    const { path } = await openEnvironment(w.work, (await w.git(["rev-parse", "HEAD"])).trim())
    writeFileSync(join(path, "root-dirt.txt"), "root preserved\n")

    const run = capture(w.work)
    expect(
      await runYrdProcess(["bun", "yrd", "env", "close", path, "--preserve", "--json"], run.io),
      run.stderr(),
    ).toBe(0)
    expect(run.stderr()).toContain("preserved dirty state")
    expect(run.stderr()).toContain(`; skipped: vendor/brain8@0123456789ab (${skipped.reason})`)
    expect(existsSync(path)).toBe(false)
    expect(JSON.parse(run.stdout())).toEqual({ closed: path, skipped: [skipped] })
  })

  /**
   * @failure 29073 (@cto condition 3): the ONE stated preserve CLI path is
   *          `${superproject-root}/tools/worktree.ts`. When it is absent, `env close --preserve` must
   *          refuse BY NAME with that path and remove nothing — NEVER fall through to a plain
   *          removal, which is exactly the silent data loss the flag exists to prevent.
   * @level   l2 (real CLI, real bare remote, no preserve CLI installed)
   * @consumer every seat whose superproject has not installed the worktree preserve CLI
   */
  it("env close --preserve refuses by name when the preserve CLI is absent, removing nothing (29073)", async () => {
    const w = await world(":")
    const { path } = await openEnvironment(w.work, (await w.git(["rev-parse", "HEAD"])).trim())
    writeFileSync(join(path, "root-dirt.txt"), "never discarded silently\n")

    const run = capture(w.work)
    expect(
      await runYrdProcess(["bun", "yrd", "env", "close", path, "--preserve", "--json"], run.io),
      run.stderr(),
    ).toBe(2)
    expect(run.stderr()).toContain(join(w.work, "tools", "worktree.ts"))
    expect(run.stderr()).toContain("NOT removed")
    expect(existsSync(path)).toBe(true)
    expect(existsSync(join(path, "root-dirt.txt"))).toBe(true)
  })

  /** @failure 29383: a child exiting without a receipt loses its exit and actual stderr cause.
   * @level l2 @consumer seats diagnosing a refused env close --preserve
   * Existing receipt rows cover validation/removal, but never a no-stdout child or bounded stderr.
   */
  it.each(["short", "bounded"] as const)(
    "env close --preserve reports a child failure with %s stderr (29383)",
    async (mode) => {
      const w = await world(":")
      const cause = "km/apps/maddoc: ENOENT; preserve and resolve it before removal"
      const stderr = mode === "short" ? cause : `discarded earlier output\r\n${"noise".repeat(1200)}\r\n${cause}\r\n`
      installStubWorktreePreserve(w.work, { noReceipt: true, exitOverride: 7, stderr })
      const { path } = await openEnvironment(w.work, (await w.git(["rev-parse", "HEAD"])).trim())
      writeFileSync(join(path, "root-dirt.txt"), "must remain intact\n")

      const run = capture(w.work)
      expect(
        await runYrdProcess(["bun", "yrd", "env", "close", path, "--preserve", "--json"], run.io),
        run.stderr(),
      ).toBe(2)
      expect(run.stderr()).toContain("exited 7")
      expect(run.stderr()).toContain(cause)
      expect(run.stderr()).toContain("NOT removed")
      if (mode === "bounded") {
        expect(run.stderr()).not.toContain("discarded earlier output")
        expect(run.stderr().length).toBeLessThan(6000)
      }
      expect(existsSync(path)).toBe(true)
      expect(readFileSync(join(path, "root-dirt.txt"), "utf8")).toBe("must remain intact\n")
    },
  )

  /**
   * @failure 29073 (@cto must 2026-10-13): a receipt from another tool or version must fail AT the
   *          boundary, by name — never as an undefined ref handed to `--preserved` or a
   *          `submodules` TypeError downstream. yrd validates the schema literal and each field's
   *          type where it reads the receipt, naming the offending field and the CLI path.
   * @level   l2 (real CLI, stub emitting a wrong-schema receipt)
   * @consumer every seat whose superproject's preserve CLI returns an unexpected receipt
   */
  it("env close --preserve refuses a receipt it cannot validate, removing nothing (29073)", async () => {
    const w = await world(":")
    installStubWorktreePreserve(w.work, { badReceipt: true, stderr: "schema producer diagnostic" })
    const { path } = await openEnvironment(w.work, (await w.git(["rev-parse", "HEAD"])).trim())
    writeFileSync(join(path, "root-dirt.txt"), "must not be discarded\n")

    const run = capture(w.work)
    expect(
      await runYrdProcess(["bun", "yrd", "env", "close", path, "--preserve", "--json"], run.io),
      run.stderr(),
    ).toBe(2)
    // The refusal names the offending field and the CLI path it read from.
    expect(run.stderr()).toContain("invalid schema")
    expect(run.stderr()).toContain("exited 0")
    expect(run.stderr()).toContain("schema producer diagnostic")
    expect(run.stderr()).toContain("bearly-worktree-preserve/1")
    expect(run.stderr()).toContain(join(w.work, "tools", "worktree.ts"))
    expect(existsSync(path)).toBe(true)
    expect(existsSync(join(path, "root-dirt.txt"))).toBe(true)
  })

  /**
   * @failure 29073 (@cto must 2026-10-13): each field of the receipt is validated where it is
   *          read, the top-level `path` included — the real schema-1 receipt carries it, so a
   *          receipt missing it must be refused by name, never trusted. (@dev/10's direct probe
   *          accepted a missing `path` before this row.)
   * @level   l2 (real CLI, stub emitting a receipt with no `path`)
   * @consumer every seat whose superproject's preserve CLI returns a receipt without `path`
   */
  it("env close --preserve refuses a receipt missing the path field, removing nothing (29073)", async () => {
    const w = await world(":")
    installStubWorktreePreserve(w.work, { badPath: true, stderr: "path producer diagnostic" })
    const { path } = await openEnvironment(w.work, (await w.git(["rev-parse", "HEAD"])).trim())
    writeFileSync(join(path, "root-dirt.txt"), "must not be discarded\n")

    const run = capture(w.work)
    expect(
      await runYrdProcess(["bun", "yrd", "env", "close", path, "--preserve", "--json"], run.io),
      run.stderr(),
    ).toBe(2)
    expect(run.stderr()).toContain("invalid path")
    expect(run.stderr()).toContain("exited 0")
    expect(run.stderr()).toContain("path producer diagnostic")
    expect(run.stderr()).toContain(join(w.work, "tools", "worktree.ts"))
    expect(run.stderr()).toContain("NOT removed")
    expect(existsSync(path)).toBe(true)
    expect(existsSync(join(path, "root-dirt.txt"))).toBe(true)
  })

  /**
   * @failure 29073: the preserve verb's "nothing to preserve" ending is a NON-ZERO exit (3) — the
   *          exact case @cto's boundary contract calls valid, paired with `preserved:false`. yrd
   *          must accept that combination, not mistake it for a failure, and go on to remove the
   *          clean environment.
   * @level   l2 (real CLI, stub emitting the clean receipt with its honest exit 3)
   * @consumer every seat closing a clean environment with --preserve
   */
  it("env close --preserve accepts the clean no-op (exit 3) and removes the environment (29073)", async () => {
    const w = await world(":")
    installStubWorktreePreserve(w.work)
    const { path } = await openEnvironment(w.work, (await w.git(["rev-parse", "HEAD"])).trim())

    const run = capture(w.work)
    expect(
      await runYrdProcess(["bun", "yrd", "env", "close", path, "--preserve", "--json"], run.io),
      run.stderr(),
    ).toBe(0)
    expect(run.stderr()).toContain("found nothing to preserve")
    expect(existsSync(path)).toBe(false)
    expect(await w.git(["worktree", "list", "--porcelain"])).not.toContain(path)
  })

  /**
   * @failure 29073 (@cto must 2026-10-13): acceptance says a failed preserve BLOCKS removal. A
   *          non-zero exit that is neither the honest clean ending (3) nor a settled success means
   *          the preserve did not finish, even when a well-formed receipt came with it — yrd must
   *          refuse by name, naming the exit, and remove nothing.
   * @level   l2 (real CLI, stub exiting 9 with an otherwise valid receipt)
   * @consumer every seat whose preserve CLI crashes or is killed mid-preserve
   */
  it("env close --preserve refuses a non-zero preserve exit, removing nothing (29073)", async () => {
    const w = await world(":")
    installStubWorktreePreserve(w.work, { exitOverride: 9, stderr: "preserve could not finish" })
    const { path } = await openEnvironment(w.work, (await w.git(["rev-parse", "HEAD"])).trim())
    writeFileSync(join(path, "root-dirt.txt"), "must not be discarded\n")

    const run = capture(w.work)
    expect(
      await runYrdProcess(["bun", "yrd", "env", "close", path, "--preserve", "--json"], run.io),
      run.stderr(),
    ).toBe(2)
    expect(run.stderr()).toContain("exited 9")
    expect(run.stderr()).toContain("preserve could not finish")
    expect(run.stderr()).toContain("NOT removed")
    expect(existsSync(path)).toBe(true)
    expect(existsSync(join(path, "root-dirt.txt"))).toBe(true)
  })

  /**
   * @failure 28120: direct close removed an unrelated process's cwd and ran teardown first.
   * @level l2 (real CLI and native cwd holder in a temporary retained worktree)
   * @consumer callers closing an environment still used by another process
   */
  it.runIf(process.platform === "linux").each(["CLI sibling", "caller child"])(
    "refuses a live cwd holder (%s) before teardown (28120)",
    async (invocation) => {
      const w = await world(":", "printf touched > ../holder-teardown-ran.txt")
      const selected = (await w.git(["rev-parse", "HEAD"])).trim()
      const { path } = await openEnvironment(w.work, selected)
      const cli = join(dirname(fileURLToPath(import.meta.url)), "../../../bin/yrd.ts")
      const heldPath = invocation === "caller child" ? join(path, "nested") : path
      if (heldPath !== path) mkdirSync(heldPath)
      const holder = Bun.spawn([process.execPath, "-e", 'console.log("ready"); setInterval(() => {}, 1000)'], {
        cwd: heldPath,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "inherit",
      })
      try {
        const ready = holder.stdout.getReader()
        expect(new TextDecoder().decode((await ready.read()).value)).toContain("ready")
        ready.releaseLock()
        if (invocation === "caller child") {
          processCensus.mockImplementation(async () =>
            fixtureCensus(await realProcessCensus({ scope: "same-uid", sources: ["cwd"], deadlineMs: 2_000 }), [
              process.pid,
              holder.pid,
            ]),
          )
        }

        const local = capture(path)
        const closed =
          invocation === "CLI sibling"
            ? await command(w.work, [process.execPath, cli, "env", "close", path, "--json"], process.env)
            : {
                exit: await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], local.io),
                stderr: local.stderr(),
                stdout: local.stdout(),
              }

        expect(closed.exit, closed.stderr).toBe(2)
        expect(closed.stderr).toContain(String(holder.pid))
        expect(closed.stderr).toContain("same-UID holders inspected; other-UID holders are not inspectable")
        expect(closed.stderr).toContain("exempt PIDs:")
        expect(closed.stderr).toContain("a process can enter after the check")
        expect(existsSync(path)).toBe(true)
        expect(await w.git(["worktree", "list", "--porcelain"])).toContain(path)
        expect(existsSync(join(dirname(path), "holder-teardown-ran.txt"))).toBe(false)
      } finally {
        holder.kill()
        await holder.exited
      }
    },
  )

  /**
   * @failure 28120: teardown could start a holder after the first safe admission.
   * @level l2 (real teardown starts a native process in the temporary worktree)
   * @consumer close callers whose declared teardown leaves background work
   */
  it.runIf(process.platform === "linux")(
    "keeps a holder started by teardown at the fresh removal check (28120)",
    async () => {
      const program =
        'import { writeFileSync } from "node:fs"; writeFileSync("../teardown-holder.pid", String(process.pid)); setInterval(() => {}, 1000)'
      const launcher = `const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(program)}],
        { cwd: process.cwd(), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      child.unref();
      for (let attempt = 0; attempt < 200; attempt++) {
        if (await Bun.file("../teardown-holder.pid").exists()) process.exit(0);
        await Bun.sleep(10);
      }
      child.kill(); await child.exited; throw new Error("teardown holder did not become ready");`
      const w = await world(":", `'${process.execPath.replaceAll("'", "'\\''")}' -e '${launcher}'`)
      const { path } = await openEnvironment(w.work, (await w.git(["rev-parse", "HEAD"])).trim())
      const marker = join(dirname(path), "teardown-holder.pid")
      processCensus.mockImplementation(async () =>
        fixtureCensus(await realProcessCensus({ scope: "same-uid", sources: ["cwd"], deadlineMs: 2_000 }), [
          process.pid,
          ...(existsSync(marker) ? [Number(readFileSync(marker, "utf8"))] : []),
        ]),
      )
      try {
        const closed = capture(w.work)
        expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], closed.io), closed.stderr()).toBe(2)
        const pid = Number(readFileSync(marker, "utf8"))
        expect(closed.stderr()).toContain(`process ${pid} has CWD`)
        expect(existsSync(path)).toBe(true)
        expect(await w.git(["worktree", "list", "--porcelain"])).toContain(path)
      } finally {
        if (existsSync(marker)) {
          const pid = Number(readFileSync(marker, "utf8"))
          process.kill(pid, "SIGTERM")
          await vi.waitFor(() => expect(existsSync(`/proc/${pid}/cwd`)).toBe(false))
        }
      }
    },
  )

  /**
   * @failure 28120: absent ancestry evidence was treated as permission to close from inside.
   * @level l1 (injected unreadable ancestry at the existing process-census boundary)
   * @consumer own-directory callers on platforms without readable ancestry
   */
  it.runIf(process.platform === "linux")(
    "names the outside-environment cure when invocation ancestry is unreadable (28120)",
    async () => {
      const w = await world(":", "printf touched > ../ancestry-teardown-ran.txt")
      const { path } = await openEnvironment(w.work, (await w.git(["rev-parse", "HEAD"])).trim())
      const observed = await removely.inspectProcessCensus({ scope: "same-uid", sources: ["cwd"], deadlineMs: 2_000 })
      const census = processCensus.mockResolvedValue({
        rows: [
          { pid: process.pid, sources: { cwd: { availability: "readable", value: path, issues: [] } }, issues: [] },
        ],
        coverage: { ...observed.coverage, complete: true, unreadable: [] },
      })
      try {
        const closed = capture(path)
        expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], closed.io), closed.stderr()).toBe(2)
        expect(closed.stderr()).toContain("ancestry unavailable")
        expect(closed.stderr()).toContain("run the close from outside the environment")
        expect(existsSync(path)).toBe(true)
        expect(existsSync(join(dirname(path), "ancestry-teardown-ran.txt"))).toBe(false)
      } finally {
        census.mockRestore()
      }
    },
  )

  /**
   * @failure 25949: successful removal was reported as failure when the caller's cwd was the removed environment.
   * @level l2 (real CLI subprocess and materialized submodule)
   * @consumer a caller closing the environment from its own shell
   */
  it.runIf(process.platform === "linux")(
    "closes from inside the removed environment and reports success (25949)",
    async () => {
      const w = await world(":")
      await addMaterializedDependency(w)
      const selected = (await w.git(["rev-parse", "HEAD"])).trim()
      const { path } = await openEnvironment(w.work, selected)
      const cli = join(dirname(fileURLToPath(import.meta.url)), "../../../bin/yrd.ts")
      // A real shell and child run the real lifecycle with CTO's internal dependency;
      // only their kernel process rows belong to this fixture's census population.
      const nativeEntry = join(dirname(w.work), "native-close.ts")
      writeFileSync(
        nativeEntry,
        `
        import { closeEnvironment } from ${JSON.stringify(join(dirname(fileURLToPath(import.meta.url)), "../src/env-commands.ts"))};
        import { inspectProcessCensus } from ${JSON.stringify(Bun.resolveSync("removely", dirname(fileURLToPath(import.meta.url))))};
        const census = async () => {
          const observed = await inspectProcessCensus({ scope: "same-uid", sources: ["cwd"], deadlineMs: 2000 });
          const pids = [process.pid, process.ppid];
          for (const pid of pids) if (!observed.rows.some(row => row.pid === pid)) throw new Error("fixture PID missing: " + pid);
          const unreadable = (observed.coverage.unreadable ?? []).filter(row => pids.includes(row.pid));
          return { ...observed, rows: observed.rows.filter(row => pids.includes(row.pid)), coverage: { ...observed.coverage, unreadable, complete: unreadable.length === 0 } };
        };
        try {
          process.exitCode = await closeEnvironment(process.argv[2], { json: true }, {
            cwd: process.cwd(), color: false, stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text),
          }, census);
        } catch (error) { console.error(error.message); process.exitCode = 2; }
      `,
      )
      const closed = await command(
        path,
        [
          "sh",
          "-c",
          'printf "shell-pid=%s\\n" "$$" >&2; "$1" "$2" "$3"; result=$?; exit "$result"',
          "yrd-close-shell",
          process.execPath,
          nativeEntry,
          path,
        ],
        process.env,
      )

      expect(closed.exit, closed.stderr).toBe(0)
      const shellPid = closed.stderr.match(/^shell-pid=(\d+)$/mu)?.[1]
      expect(shellPid).toBeTypeOf("string")
      expect(closed.stderr).toMatch(new RegExp(`exempt PIDs: [^\\n]*\\b${shellPid}\\b`, "u"))
      expect(JSON.parse(closed.stdout)).toEqual({ closed: path })
      expect(existsSync(path)).toBe(false)
      expect(await w.git(["worktree", "list", "--porcelain"])).not.toContain(path)
    },
  )

  // #27156: existence admission precedes teardown and every child-content read. 28740 removed the
  // declared-private exclusion, so an opened environment now carries the child materialized; the refusal
  // is the initialized case, and this proves it runs BEFORE any teardown of the checkout.
  it("private custody gates close before teardown", async () => {
    const w = await world(":", "printf touched > ../private-teardown-ran.txt")
    await addMaterializedDependency(w)
    await w.git(["config", "-f", ".gitmodules", "submodule.vendor/dependency.private", "true"])
    await w.git(["add", ".gitmodules"])
    await w.git(["commit", "--quiet", "-m", "declare private dependency"])
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(w.work, selected)
    const gitfile = join(path, "vendor/dependency/.git")
    expect(existsSync(gitfile)).toBe(true)
    const closed = capture(w.work)
    const exit = await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], closed.io)
    const teardown = join(dirname(path), "private-teardown-ran.txt")
    expect(exit, closed.stderr()).toBe(2)
    expect(closed.stderr()).toContain("vendor/dependency")
    expect(closed.stderr()).toContain("private checkout, custody not proven")
    // #27120 AC2: the refusal carries one structured class, so a sweep reports the tree by class
    // name and retire path instead of quoting a per-seat note.
    expect(JSON.parse(closed.stdout())).toMatchObject({
      kept: path,
      class: "private checkout",
      submodule: "vendor/dependency",
    })
    expect((JSON.parse(closed.stdout()) as { command?: string }).command).toContain("private-store verify")
    expect(existsSync(path)).toBe(true)
    expect(existsSync(gitfile)).toBe(true)
    expect(existsSync(teardown)).toBe(false)
  })

  // #27120 AC1 (chief ruling c8a3b06d): the unreadable stage. `entryPresent` (env-commands.ts) names the
  // gitfile probe's answer, and ONLY ENOENT/ENOTDIR may read as "nothing is there": a kernel refusal is a
  // named fault that preserves the environment. `existsSync` would answer FALSE for an EACCES entry, the
  // checkout would read as empty, and the close would walk past a private store it could not judge. The
  // fixture takes the mode off the gitfile's own parent so the refusal is the kernel's, not a mock's.
  it("refuses by name when the private gitfile cannot be read", async () => {
    const w = await world(":")
    await addMaterializedDependency(w)
    await w.git(["config", "-f", ".gitmodules", "submodule.vendor/dependency.private", "true"])
    await w.git(["add", ".gitmodules"])
    await w.git(["commit", "--quiet", "-m", "declare private dependency"])
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(w.work, selected)
    const checkout = join(path, "vendor/dependency")
    const gitfile = join(checkout, ".git")
    expect(existsSync(gitfile)).toBe(true)
    const mode = statSync(checkout).mode & 0o777
    try {
      chmodSync(checkout, 0o000)
      const refused = capture(w.work)
      const exit = await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], refused.io)
      expect(exit, refused.stderr()).not.toBe(0)
      expect(refused.stderr()).toContain(`cannot inspect the private submodule gitfile of ${gitfile}`)
      expect(refused.stderr()).toContain("the environment was preserved")
    } finally {
      chmodSync(checkout, mode)
    }
    expect(existsSync(path), "a checkout whose private gitfile cannot be read is kept").toBe(true)
    expect(existsSync(gitfile)).toBe(true)
  })

  // #27120 AC3: the ruled Route A, all three stages against one fixture — the initialized checkout
  // refuses without touching the store; emptying alone still refuses while the store sits inside the
  // worktree's deletion custody; emptying plus the operator's store step closes normally.
  it("retires an initialized private checkout by the ruled route, stage by stage", async () => {
    const w = await world(":")
    await addMaterializedDependency(w)
    await w.git(["config", "-f", ".gitmodules", "submodule.vendor/dependency.private", "true"])
    await w.git(["add", ".gitmodules"])
    await w.git(["commit", "--quiet", "-m", "declare private dependency"])
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(w.work, selected)
    const checkout = join(path, "vendor/dependency")
    const gitfile = join(checkout, ".git")
    await w.git(["-C", path, "submodule", "update", "--init", "vendor/dependency"])
    expect(existsSync(gitfile)).toBe(true)
    const store = (
      await w.git(["-C", path, "rev-parse", "--path-format=absolute", "--git-path", "modules/vendor/dependency"])
    ).trim()
    expect(existsSync(store)).toBe(true)

    // STAGE 1 — initialized: refuse, name the route, and leave every byte of the store alone.
    const refused = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], refused.io)).toBe(2)
    expect(refused.stderr()).toContain("is initialized and still holds private content")
    // #30434: the removal step must name this store, not its parent containing other vendor stores.
    expect(refused.stderr()).toContain(`then remove the private store ${store}. This tool`)
    expect((JSON.parse(refused.stdout()) as { class?: string }).class).toBe("private checkout")
    expect(existsSync(checkout)).toBe(true)
    expect(existsSync(store)).toBe(true)

    // STAGE 2 — the operator empties the checkout. That ALONE is not enough: deinit removes the
    // gitfile but leaves the private store inside this environment's own admin dir, and the close
    // runs no removal it has not proved. R1 itself refuses here (ruling ii) — it fires while EITHER
    // the checkout is initialized OR the store is still present — so the environment is preserved
    // with no exclusion-list handoff to `git super worktree remove`. Re-proved here, not trusted.
    await w.git(["-C", path, "submodule", "deinit", "-f", "vendor/dependency"])
    expect(existsSync(gitfile)).toBe(false)
    expect(existsSync(store)).toBe(true)
    const emptied = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], emptied.io), emptied.stderr()).toBe(2)
    expect(emptied.stderr()).toContain("is still present")
    expect(emptied.stderr()).toContain(`then remove the private store ${store}. This tool`)
    expect(JSON.parse(emptied.stdout())).toMatchObject({ kept: path, class: "private checkout", store })
    expect(existsSync(path)).toBe(true)
    expect(existsSync(store)).toBe(true)

    // STAGE 3 — the operator's store step (remove only the refused store), and only then does the
    // ordinary close succeed.
    rmSync(store, { recursive: true, force: true })
    const closed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], closed.io), closed.stderr()).toBe(0)
    expect(existsSync(path)).toBe(false)
    expect(existsSync(store)).toBe(false)
  })

  // #27120 half 2 (@cto, on @dev/review2's NO-GO): R1 derived `modules/${privatePath}`, but Git stores a
  // submodule by its declaration NAME. A supported `git submodule add --name secret ... vendor/dependency`
  // makes name != path, so the path-keyed probe looked at modules/vendor/dependency - which never exists -
  // and let the close remove the environment and COPY the real store into retained-modules. The decisive
  // regression: name != path plus a remaining private admin store, both initialized and deinitialized.
  it("refuses a private checkout whose declaration NAME differs from its path", async () => {
    const w = await world(":")
    // A real materialized dependency, added under a NAME that differs from its path.
    const root = mkdtempSync(join(tmpdir(), "yrd-cli-env-submodule-"))
    roots.push(root)
    const seed = gitIn(root)
    const remote = join(root, "remote.git")
    const child = join(root, "child")
    await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
    await seed(["clone", "--quiet", remote, child])
    const childGit = gitIn(child)
    await childGit(["config", "user.email", "env-open@yrd.test"])
    await childGit(["config", "user.name", "yrd"])
    await childGit(["checkout", "--quiet", "-b", "main"])
    writeFileSync(join(child, "READY"), "materialized\n")
    await childGit(["add", "READY"])
    await childGit(["commit", "--quiet", "-m", "seed materialized dependency"])
    await childGit(["push", "--quiet", "origin", "main"])
    await w.git([
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--quiet",
      "--name",
      "secret",
      remote,
      "vendor/dependency",
    ])
    // The section is `secret`; its path is `vendor/dependency`. Git keys the admin store by the NAME.
    expect((await w.git(["config", "-f", ".gitmodules", "--get", "submodule.secret.path"])).trim()).toBe(
      "vendor/dependency",
    )
    await w.git(["config", "-f", ".gitmodules", "submodule.secret.private", "true"])
    await w.git(["add", ".gitmodules"])
    await w.git(["commit", "--quiet", "-m", "declare the private dependency under the name secret"])
    await w.git(["push", "--quiet", "origin", "main"])
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(w.work, selected)
    const gitfile = join(path, "vendor/dependency/.git")
    const store = (
      await w.git(["-C", path, "rev-parse", "--path-format=absolute", "--git-path", "modules/secret"])
    ).trim()
    const workdir = await workdirOf(w.git, { cwd: w.work })

    // ARM 1 - initialized: refuse, name the route, and leave every byte of the store alone.
    await w.git(["-C", path, "submodule", "update", "--init", "vendor/dependency"])
    expect(existsSync(gitfile)).toBe(true)
    expect(existsSync(store)).toBe(true)
    // The store lives under the NAME; the old path-keyed probe looked here and found nothing.
    expect(existsSync(join(dirname(store), "vendor", "dependency"))).toBe(false)
    const refused = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], refused.io), refused.stderr()).toBe(2)
    expect(refused.stderr()).toContain("private checkout, custody not proven")
    expect(refused.stderr()).toContain("vendor/dependency")
    expect(JSON.parse(refused.stdout())).toMatchObject({
      kept: path,
      class: "private checkout",
      submodule: "vendor/dependency",
      store,
    })
    expect((JSON.parse(refused.stdout()) as { command?: string }).command).toContain("private-store verify")
    expect(existsSync(path)).toBe(true)
    expect(existsSync(store)).toBe(true)

    // ARM 2 - deinitialized (@dev/review2's exact specimen): the gitfile is gone, modules/secret remains.
    await w.git(["-C", path, "submodule", "deinit", "-f", "vendor/dependency"])
    expect(existsSync(gitfile)).toBe(false)
    expect(existsSync(store)).toBe(true)
    const emptied = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], emptied.io), emptied.stderr()).toBe(2)
    expect(emptied.stderr()).toContain("is still present")
    expect(emptied.stderr()).toContain("vendor/dependency")
    expect(JSON.parse(emptied.stdout())).toMatchObject({
      kept: path,
      class: "private checkout",
      submodule: "vendor/dependency",
      store,
    })
    expect(existsSync(path)).toBe(true)
    expect(existsSync(store)).toBe(true)
    // The boundary (@cto, c8a3b06d): a refused close keeps the environment; it never COPIES the store into
    // retention and removes the original. The old path-keyed close copied `modules/secret` in here.
    expect(existsSync(join(workdir, "retained-modules"))).toBe(false)

    // STAGE 3 - the operator's store step, and only then does the ordinary close succeed.
    rmSync(dirname(store), { recursive: true, force: true })
    const closed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], closed.io), closed.stderr()).toBe(0)
    expect(existsSync(path)).toBe(false)
  })

  it("opens, lists and closes a workdir configured through a symlink", async () => {
    const w = await world(":")
    const actual = join(w.work, "state-actual")
    const alias = join(w.work, "state-alias")
    mkdirSync(actual)
    symlinkSync(actual, alias)
    await w.git(["config", "yrd.workdir", alias])
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(w.work, selected)
    const physical = realpathSync(path)
    const listed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "list", "--json"], listed.io)).toBe(0)
    expect(JSON.parse(listed.stdout())).toMatchObject({ environments: [{ path: physical, head: selected }] })
    const closed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], closed.io), closed.stderr()).toBe(0)
    expect(JSON.parse(closed.stdout())).toEqual({ closed: physical })
    expect(existsSync(path)).toBe(false)
  })

  it("closes its environment when the preview sweep fails after the subject's roots are retired (27510)", async () => {
    const w = await world(":")
    await addMaterializedDependency(w)
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(w.work, selected)
    await gitIn(path)(["switch", "--quiet", "-c", "task/closing"])
    // A custody root recording a component commit its store does not hold: the sweep's closure read fails.
    const missing = "1".repeat(40)
    const vendor = (await w.git(["ls-tree", `${selected}:vendor`])).replace(
      /^160000 commit \S+\tdependency$/mu,
      `160000 commit ${missing}\tdependency`,
    )
    expect(vendor).toContain(missing)
    const vendorTree = (await w.git(["mktree", "--missing"], vendor)).trim()
    const top = (await w.git(["ls-tree", selected])).replace(
      /^040000 tree \S+\tvendor$/mu,
      `040000 tree ${vendorTree}\tvendor`,
    )
    expect(top).toContain(vendorTree)
    const tree = (await w.git(["mktree"], top)).trim()
    const recorded = (
      await w.git(["commit-tree", tree, "-p", selected, "-m", "custody root with a missing component"])
    ).trim()
    const root = `${previewSubjectPrefix(previewCloneKey(join(w.work, ".git")), "task/closing")}${recorded}`
    await w.git(["update-ref", "--create-reflog", root, recorded])

    const closed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], closed.io), closed.stderr()).toBe(0)

    expect(existsSync(path)).toBe(false)
    expect((await w.git(["for-each-ref", "refs/yrd/preview/"])).trim()).toBe("")
    expect(closed.stderr()).toContain("yrd: env close left a preview anchor")
    expect(closed.stderr()).toContain("the orphan sweep after retiring task/closing failed")
  })

  it("lists and closes newline-containing paths from a nested caller using the same Git registry", async () => {
    const w = await world(":")
    await w.git(["config", "yrd.workdir", join(w.work, "state\nwith spaces")])
    const nested = join(w.work, "nested")
    mkdirSync(nested)
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(nested, selected)
    const listed = capture(nested)
    expect(await runYrdProcess(["bun", "yrd", "env", "list", "--json"], listed.io)).toBe(0)
    expect(JSON.parse(listed.stdout())).toMatchObject({ environments: [{ path, head: selected }] })
    const closed = capture(nested)
    expect(
      await runYrdProcess(["bun", "yrd", "env", "close", relative(nested, path), "--json"], closed.io),
      closed.stderr(),
    ).toBe(0)
    expect(JSON.parse(closed.stdout())).toEqual({ closed: path })
    expect(existsSync(path)).toBe(false)
  })

  it("refuses dirty submodules even when repository configuration normally hides them", async () => {
    const w = await world(":", "printf touched > ../teardown-ran.txt")
    await addMaterializedDependency(w)
    await w.git(["config", "submodule.vendor/dependency.ignore", "all"])
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(w.work, selected)
    const userWork = join(path, "vendor/dependency/READY")
    writeFileSync(userWork, "user edits\n")
    const closed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], closed.io)).toBe(2)
    expect(closed.stderr()).toContain("dirty")
    expect(readFileSync(userWork, "utf8")).toBe("user edits\n")
    expect(existsSync(join(dirname(path), "teardown-ran.txt"))).toBe(false)
  })

  it.each([false, true])("closes a registered clean environment with declared teardown=%s", async (teardown) => {
    const w = await world(":", teardown ? 'printf "%s\\n" "$YRD_CANDIDATE_SHA" > ../closed.txt' : undefined)
    if (teardown) await addMaterializedDependency(w)
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(w.work, selected)
    // Close reads the retained commit, never the caller's edited declaration.
    writeFileSync(join(w.work, ".yrd.yml"), "teardown: exit 23\n")
    const closed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], closed.io), closed.stderr()).toBe(0)
    expect(JSON.parse(closed.stdout())).toEqual({ closed: path })
    expect(existsSync(path)).toBe(false)
    expect(await w.git(["worktree", "list", "--porcelain", "-z"])).not.toContain(path)
    if (teardown) {
      expect(readFileSync(join(dirname(path), "closed.txt"), "utf8")).toBe(`${selected}\n`)
      expect(closed.stderr()).toContain("retained environment removal proof")
      const proofLine = closed
        .stderr()
        .split("\n")
        .find((line) => line.startsWith("retained environment removal proof "))
      expect(proofLine).toBeTypeOf("string")
      const proof = proofLine!.slice("retained environment removal proof ".length)
      expect(readFileSync(proof, "utf8")).toContain("vendor/dependency/config")
    }
  })

  /**
   * @failure `yrd env close` read the retained environment's own `.yrd.yml` through the strict
   *          parser, so an environment opened through a newer Yrd — the documented cure for
   *          `env open` — refused to close from a week-old slot with only `unknown key ...`,
   *          the same old-reader gap 27187 closed for `submit`.
   * @level   l2 (real bare remote, the declaration at the retained commit, real worktree)
   * @consumer every seat closing an environment whose declaration its checkout postdates
   * @testonly none
   */
  it("closes an environment whose declaration carries a top-level key this Yrd does not know, warning once", async () => {
    const w = await world(":")
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(w.work, selected)
    // Close reads the retained commit, so the newer key is committed in the environment itself.
    const declared = join(path, ".yrd.yml")
    writeFileSync(declared, `${readFileSync(declared, "utf8")}futurekey: from a newer queue\n`)
    await gitIn(path)(["add", ".yrd.yml"])
    await gitIn(path)([
      "-c",
      "user.email=env-open@yrd.test",
      "-c",
      "user.name=yrd",
      "commit",
      "--quiet",
      "-m",
      "declare a key this Yrd does not know",
    ])
    const closed = capture(w.work)

    expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], closed.io), closed.stderr()).toBe(0)

    expect(closed.stderr()).toContain("futurekey:")
    expect(closed.stderr()).toMatch(/this environment's Yrd does not know/iu)
    expect(closed.stderr().match(/futurekey:/gu)).toHaveLength(1)
    expect(existsSync(path)).toBe(false)
  })

  it.each(["unknown", "outside", "symlink-outside", "dirty-tracked", "dirty-untracked", "locked"])(
    "refuses %s before running teardown or removing data",
    async (kind) => {
      const w = await world(":", "printf touched > ../teardown-ran.txt")
      const selected = (await w.git(["rev-parse", "HEAD"])).trim()
      const { path } = await openEnvironment(w.work, selected)
      let target = path
      if (kind === "unknown") {
        target = join(dirname(path), "unregistered")
        mkdirSync(target)
      } else if (kind === "outside" || kind === "symlink-outside") {
        const outside = join(w.work, "outside")
        await w.git(["worktree", "add", "--quiet", "--detach", outside, selected])
        target = outside
        if (kind === "symlink-outside") {
          target = join(dirname(path), "escape")
          symlinkSync(outside, target)
        }
      } else if (kind === "dirty-tracked") writeFileSync(join(path, ".yrd.yml"), "local edits\n")
      else if (kind === "dirty-untracked") writeFileSync(join(path, "user-work.txt"), "uncommitted work\n")
      else await w.git(["worktree", "lock", "--reason", "active owner", path])

      const before = await w.git(["worktree", "list", "--porcelain", "-z"])
      const closed = capture(w.work)
      expect(await runYrdProcess(["bun", "yrd", "env", "close", target, "--json"], closed.io)).toBe(2)
      expect(closed.stdout()).toBe("")
      expect(closed.stderr()).toContain(
        kind.startsWith("dirty")
          ? "dirty"
          : kind === "locked"
            ? "locked"
            : kind === "unknown"
              ? "not registered"
              : "outside",
      )
      expect(await w.git(["worktree", "list", "--porcelain", "-z"])).toBe(before)
      expect(existsSync(target)).toBe(true)
      expect(existsSync(join(dirname(path), "teardown-ran.txt"))).toBe(false)
      expect(existsSync(join(w.work, "teardown-ran.txt"))).toBe(false)
    },
  )

  it.each(["fail", "dirty"])("preserves the worktree when teardown ends %s", async (kind) => {
    const w = await world(
      ":",
      kind === "fail" ? "printf 'teardown exploded\\n' >&2; exit 23" : "printf changed > teardown-left.txt",
    )
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(w.work, selected)
    const closed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", path], closed.io)).toBe(2)
    expect(closed.stdout()).toBe("")
    expect(closed.stderr()).toContain(kind === "fail" ? "teardown exploded" : "dirty")
    expect(existsSync(path)).toBe(true)
    expect(await w.git(["worktree", "list", "--porcelain", "-z"])).toContain(path)
    if (kind === "dirty") expect(readFileSync(join(path, "teardown-left.txt"), "utf8")).toBe("changed")
  })

  /**
   * @failure Automatic close can discard GitSuper's borrowed KEEP result or fail to forward its no-rehome policy.
   * @level l2
   * @consumer Yrd automatic cleanup and manual environment close
   */
  it.each([{ noRehome: false }, { noRehome: true }])(
    "closes or keeps a lender environment with live borrowers (noRehome=$noRehome)",
    async ({ noRehome }) => {
      const w = await world(":")
      await addMaterializedDependency(w)
      const selected = (await w.git(["rev-parse", "HEAD"])).trim()
      const { path: lender } = await openEnvironment(w.work, selected)

      const openBorrower = capture(lender)
      expect(
        await runYrdProcess(["bun", "yrd", "env", "open", selected, "--bay", "borrower", "--json"], openBorrower.io),
        openBorrower.stderr(),
      ).toBe(0)
      const { path: borrower } = JSON.parse(openBorrower.stdout()) as { path: string }

      const lenderGitDir = (
        await command(join(lender, "vendor/dependency"), ["git", "rev-parse", "--absolute-git-dir"])
      ).stdout.trim()
      const borrowerGitDir = (
        await command(join(borrower, "vendor/dependency"), ["git", "rev-parse", "--absolute-git-dir"])
      ).stdout.trim()
      const altFile = join(borrowerGitDir, "objects", "info", "alternates")
      const existingAlt = existsSync(altFile) ? readFileSync(altFile, "utf8") : ""
      const loan = `${join(lenderGitDir, "objects")}\n${existingAlt}`
      writeFileSync(altFile, loan)

      const closed = capture(w.work)
      if (noRehome) {
        const options = { json: true, noRehome }
        expect(await closeEnvironment(lender, options, closed.io), closed.stderr()).toBe(0)
        expect(JSON.parse(closed.stdout())).toEqual({ kept: lender, reason: "borrowed", borrowers: [borrower] })
        expect(existsSync(lender)).toBe(true)
        expect(readFileSync(altFile, "utf8")).toBe(loan)
        expect(await w.git(["worktree", "list", "--porcelain"])).toContain(lender)
        return
      }
      expect(await runYrdProcess(["bun", "yrd", "env", "close", lender, "--json"], closed.io), closed.stderr()).toBe(0)
      expect(JSON.parse(closed.stdout())).toEqual({ closed: lender })
      expect(existsSync(lender)).toBe(false)

      const fsckSub = await command(join(borrower, "vendor/dependency"), ["git", "fsck", "--full"])
      expect(fsckSub.exit).toBe(0)
      expect(fsckSub.stderr).toBe("")

      const closeBorrower = capture(w.work)
      expect(await runYrdProcess(["bun", "yrd", "env", "close", borrower, "--json"], closeBorrower.io)).toBe(0)
    },
  )

  it("closes a packed lender environment with a unique commit and leaves the borrower clean (25908 cure)", async () => {
    const w = await world(":")
    await addMaterializedDependency(w)
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path: lender } = await openEnvironment(w.work, selected)

    const openBorrower = capture(lender)
    expect(
      await runYrdProcess(["bun", "yrd", "env", "open", selected, "--bay", "borrower", "--json"], openBorrower.io),
      openBorrower.stderr(),
    ).toBe(0)
    const { path: borrower } = JSON.parse(openBorrower.stdout()) as { path: string }

    const lenderSub = join(lender, "vendor/dependency")
    const borrowerSub = join(borrower, "vendor/dependency")

    await command(lenderSub, ["git", "commit", "--allow-empty", "-m", "lender unique"])
    const uniqueSha = (await command(lenderSub, ["git", "rev-parse", "HEAD"])).stdout.trim()

    await command(lenderSub, ["git", "repack", "-a", "-d"])

    await command(lender, ["git", "add", "vendor/dependency"])
    await command(lender, ["git", "commit", "-m", "update dependency pin"])

    const lenderGitDir = (
      await command(lenderSub, ["git", "rev-parse", "--path-format=absolute", "--git-dir"])
    ).stdout.trim()
    const borrowerGitDir = (
      await command(borrowerSub, ["git", "rev-parse", "--path-format=absolute", "--git-dir"])
    ).stdout.trim()
    const altFile = join(borrowerGitDir, "objects", "info", "alternates")
    const existingAlt = existsSync(altFile) ? readFileSync(altFile, "utf8") : ""
    writeFileSync(altFile, `${join(lenderGitDir, "objects")}\n${existingAlt}`)

    const updateRefRes = await command(borrowerSub, ["git", "update-ref", "refs/heads/main", uniqueSha])
    expect(updateRefRes.exit).toBe(0)
    await command(borrowerSub, ["git", "symbolic-ref", "HEAD", "refs/heads/main"])

    const closed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", lender, "--json"], closed.io), closed.stderr()).toBe(0)
    expect(JSON.parse(closed.stdout())).toEqual({ closed: lender })
    expect(existsSync(lender)).toBe(false)

    const fsckSub = await command(borrowerSub, ["git", "fsck", "--full"])
    expect(fsckSub.exit).toBe(0)
    expect(fsckSub.stderr).toBe("")

    const catSub = await command(borrowerSub, ["git", "cat-file", "-t", uniqueSha])
    expect(catSub.exit).toBe(0)
    expect(catSub.stdout.trim()).toBe("commit")

    await command(borrower, ["git", "add", "vendor/dependency"])
    await command(borrower, ["git", "commit", "-m", "update dependency pin in borrower"])

    const closeBorrower = capture(w.work)
    expect(
      await runYrdProcess(["bun", "yrd", "env", "close", borrower, "--json"], closeBorrower.io),
      closeBorrower.stderr(),
    ).toBe(0)
  })

  /**
   * @failure 22894: a caller whose own same-UID CWD census cannot read every pid
   *          may neither certify the close nor state an intent: it refuses, and
   *          the environment waits for a human. The intent belongs to a context
   *          whose census reads every pid.
   * @level   l1 (injected incomplete census at the existing process-census boundary)
   * @consumer every seat whose sandbox scopes ptrace over other same-UID pids
   */
  it.runIf(process.platform === "linux")(
    "queues the close for a capable context when this caller's census is incomplete (22894 T1)",
    async () => {
      const w = await world(":")
      const state = join(dirname(w.work), "state")
      await w.git(["config", "yrd.workdir", state])
      const head = (await w.git(["rev-parse", "HEAD"])).trim()
      const { path } = await openEnvironment(w.work, head)
      const workdir = await workdirOf(w.git, { cwd: w.work })
      processCensus.mockResolvedValue(await incompleteCensus())
      const run = capture(w.work)
      expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], run.io), run.stderr()).toBe(4)
      const receipt = JSON.parse(run.stdout()) as Record<string, unknown>
      const file = closeRequestFile(workdir, path)
      expect(receipt, run.stderr()).toMatchObject({
        queued: path,
        reason: "incomplete-census",
        request: file,
        census: { mechanism: "proc", complete: false, rows: 0, unreadable: 1, uncleared: 1 },
      })
      expect(run.stderr()).toContain("cannot certify the close")
      expect(run.stderr()).toContain("queued request")
      expect(readCloseRequest(file)).toMatchObject({
        name: basename(path),
        path,
        requester: requesterOf(process.env),
        predicate: "direct-admission",
        options: {},
        head,
      })
      // The request is intent, never a removal: the environment is untouched.
      expect(existsSync(path)).toBe(true)
      expect(await w.git(["worktree", "list", "--porcelain"])).toContain(path)
      // Re-filing the same intent is idempotent (create-or-match), and the first
      // requester and time survive.
      const standing = readCloseRequest(file)
      const again = capture(w.work)
      expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], again.io), again.stderr()).toBe(4)
      expect(JSON.parse(again.stdout())).toMatchObject({ queued: path, alreadyQueued: true })
      expect(readCloseRequest(file)).toEqual(standing)
      // A request for the same path with DIFFERENT options is a conflict, named
      // with the standing requester, never overwritten.
      const conflict = capture(w.work)
      expect(
        await runYrdProcess(
          ["bun", "yrd", "env", "close", path, "--json", "--retain", join(state, "elsewhere")],
          conflict.io,
        ),
        conflict.stderr(),
      ).toBe(2)
      expect(conflict.stderr()).toContain("already stands")
      expect(conflict.stderr()).toContain(requesterOf(process.env))
      expect(readCloseRequest(file)).toEqual(standing)
    },
  )

  /**
   * @failure 22894: the readable-holder refusal (28120) must stay a refusal. It
   *          must never become a queued delegation, which would put a close the
   *          caller can already judge in front of the queue.
   * @level   l1 (injected complete census carrying one readable holder)
   * @consumer the caller whose environment genuinely has a process inside it
   */
  it.runIf(process.platform === "linux")(
    "a readable holder still refuses the direct close and files no request (28120, 22894 T4)",
    async () => {
      const w = await world(":")
      const state = join(dirname(w.work), "state")
      await w.git(["config", "yrd.workdir", state])
      const { path } = await openEnvironment(w.work, (await w.git(["rev-parse", "HEAD"])).trim())
      const workdir = await workdirOf(w.git, { cwd: w.work })
      processCensus.mockResolvedValue(await holderCensus(4242, path))
      const run = capture(w.work)
      expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], run.io), run.stderr()).toBe(2)
      expect(run.stderr()).toContain("process 4242 has CWD")
      expect(run.stderr()).toContain("was preserved")
      expect(existsSync(path)).toBe(true)
      expect(listCloseRequests(workdir)).toEqual([])
    },
  )

  /**
   * @failure 22894: a request this caller cannot write must be a loud refusal
   *          naming the file and the cure, never a silent `queued` for a close
   *          that will never happen.
   * @level   l1 (an unwritable request directory)
   * @consumer a sandboxed seat with no write to the queue workdir
   */
  it.runIf(process.platform === "linux")(
    "refuses loudly, and writes nothing, when the request cannot be written (22894 T5)",
    async () => {
      const w = await world(":")
      const state = join(dirname(w.work), "state")
      await w.git(["config", "yrd.workdir", state])
      const { path } = await openEnvironment(w.work, (await w.git(["rev-parse", "HEAD"])).trim())
      const workdir = await workdirOf(w.git, { cwd: w.work })
      const directory = closeRequestsDirectory(workdir)
      mkdirSync(directory, { recursive: true })
      chmodSync(directory, 0o500)
      processCensus.mockResolvedValue(await incompleteCensus())
      try {
        const run = capture(w.work)
        expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], run.io), run.stderr()).toBe(2)
        expect(run.stderr()).toContain("could not be written")
        expect(run.stderr()).toContain(directory)
        expect(run.stderr()).toContain("read every same-UID pid")
        expect(existsSync(path)).toBe(true)
        expect(listCloseRequests(workdir)).toEqual([])
      } finally {
        chmodSync(directory, 0o700)
      }
    },
  )

  /**
   * @failure 22894: the delegation split must not disturb the identity-clearing
   *          exemption the shared admission already owns (removely's
   *          `clearedByIdentity`) — a cleared denial is evidence, not a gap.
   * @level   l1 (injected denied census at the existing process-census boundary)
   * @consumer the shared admission policy, both callers
   */
  it.runIf(process.platform === "linux")("clears identity-denied pids and still admits (28120, 22894 T6)", async () => {
    const w = await world(":")
    const { path } = await openEnvironment(w.work, (await w.git(["rev-parse", "HEAD"])).trim())
    const observed = await removely.inspectProcessCensus({ scope: "same-uid", sources: ["cwd"], deadlineMs: 2_000 })
    const io = capture(w.work)
    const admission = await admitEnvironmentClose(path, io.io, async () => ({
      rows: [],
      coverage: {
        ...observed.coverage,
        complete: false,
        unreadable: [unreadableDenial(["/usr/lib/systemd/systemd", "--user"])],
      },
    }))
    expect(admission).toEqual({ kind: "admitted" })
  })
})
