/**
 * @reach fs-walk <fixture-only: a temporary retention root, pass directory, log directory and git root store the test owns>
 * @failure 34787: `yrd env retained --discard` loses a retained entry's un-witnessed component commits without a
 * preview the decision must match, without an identified actor and reason, without a durable decision row read back
 * before GitSuper runs, while a root ref still pins a lost commit, or while claiming an owner it cannot know; or an
 * interrupted discard cannot be retried.
 * @level l1 (`discardRetainedEntry` with a recorded GitSuper and root store; GitSuper's own removal is proved in its
 * retention-discard suite)
 * @consumer yrd env retained --discard <entry> --reason <why> [--apply]
 * @testonly none
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, it } from "vitest"
import { readRunLog } from "@yrd/queue-core"
import {
  discardRetainedEntry,
  type RetainedDiscardOptions,
  type RootGit,
  type SuperRun,
} from "../src/retained-discard.ts"
import { runYrdProcess } from "../src/cli.ts"
import type { YrdCliIO } from "../src/types.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const LOCAL = "1".repeat(40)
const TREE = "2".repeat(40)

function capture(cwd: string) {
  let stdout = ""
  let stderr = ""
  const io: YrdCliIO = {
    localBranchProtections: null,
    color: false,
    cwd,
    stderr: (text) => void (stderr += text),
    stdout: (text) => void (stdout += text),
    branchIssue: () => undefined,
  } as YrdCliIO
  return { io, stdout: () => stdout, stderr: () => stderr }
}

type World = Readonly<{
  root: string
  options: RetainedDiscardOptions
  sidecar(lines: readonly string[]): void
  calls: string[][]
  runSuper: SuperRun
  retire: { code: number; detail: { code: string; message: string } }
  custodyStatus: { value: "blocked" | "unknown" }
}>

function world(apply = false, actor = "@seat/decider"): World {
  const root = mkdtempSync(join(tmpdir(), "yrd-retained-discard-"))
  roots.push(root)
  const retentionRoot = join(root, "retained")
  const entry = join(retentionRoot, "linked-abc")
  mkdirSync(entry, { recursive: true })
  // The closer recorded at env close is not the decider here: the preview must say so, and invent no owner.
  writeFileSync(
    join(entry, "manifest.json"),
    JSON.stringify({ attribution: { actor: "@seat/closer", owner: null, issue: "34787-prov" } }),
  )
  const sidecarPath = join(root, "missing.txt")
  let sidecarSha = ""
  const sidecar = (lines: readonly string[]) => {
    const bytes = lines.map((line) => `${line}\n`).join("")
    writeFileSync(sidecarPath, bytes)
    sidecarSha = createHash("sha256").update(bytes).digest("hex")
  }
  sidecar([`${LOCAL}\tpackages/alpha\towned`, `${TREE}\tpackages/alpha\towned`])
  const calls: string[][] = []
  const retire = { code: 0, detail: { code: "discarded", message: "Discarded; no surviving witness is claimed" } }
  const custodyStatus: { value: "blocked" | "unknown" } = { value: "blocked" }
  const runSuper: SuperRun = async (args) => {
    calls.push([...args])
    if (args.includes("verify")) {
      const lines = readFileSync(sidecarPath, "utf8")
        .split("\n")
        .filter((line) => line !== "")
      return {
        code: 1,
        stdout: JSON.stringify({
          verdict: "blocked",
          entry,
          entryDevIno: "7:9",
          manifestSha256: "a".repeat(64),
          reasons: ["gate 5 positive-custody: 2 at-risk OID(s) have no durable witness"],
          gates: [
            { gate: "identity-eligibility", status: "pass", message: "ok" },
            { gate: "positive-custody", status: custodyStatus.value, message: "no witness" },
          ],
          custody: {
            missingCount: lines.length,
            missingSidecar: { path: sidecarPath, sha256: sidecarSha, bytes: 0, count: lines.length },
            loss: [
              {
                component: "packages/alpha",
                count: lines.length,
                types: { commit: 1, tree: lines.length - 1 },
                roots: [{ oid: LOCAL, subject: "local only" }],
              },
            ],
          },
        }),
        stderr: "",
      }
    }
    return { code: retire.code, stdout: JSON.stringify({ detail: retire.detail }), stderr: "" }
  }
  return {
    root,
    calls,
    sidecar,
    runSuper,
    retire,
    custodyStatus,
    options: {
      entry: "linked-abc",
      reason: "abandoned experiment",
      apply,
      json: false,
      retentionRoot,
      common: join(root, "common"),
      namespace: [root],
      artifactDir: join(root, "pass"),
      logDirectory: join(root, "logs"),
      actor,
    },
  }
}

const noPins = async (args: readonly string[]) => (args[0] === "for-each-ref" ? "" : "")

function logRows(w: World) {
  const files = readdirSync(w.options.logDirectory).filter((name) => name.endsWith(".jsonl"))
  return files.flatMap((file) => readRunLog(w.options.logDirectory, file.replace(/\.jsonl$/u, "")))
}

it("previews the exact loss and the entry's recorded attribution, owner unknown, and discards nothing", async () => {
  const w = world()
  const out = capture(w.root)
  expect(await discardRetainedEntry(w.options, out.io, w.runSuper, noPins)).toBe(0)
  expect(out.stdout()).toContain(`${LOCAL} local only`)
  expect(out.stdout()).toContain("owner unknown (closed by @seat/closer, issue 34787-prov)")
  expect(out.stdout()).toContain("nothing was discarded")
  expect(w.calls.some((call) => call.includes("retire"))).toBe(false)
  const preview = JSON.parse(readFileSync(join(w.options.artifactDir, "linked-abc", "discard-preview.json"), "utf8"))
  expect(preview).toMatchObject({
    reason: "abandoned experiment",
    attribution: { actor: "@seat/decider", owner: null },
  })
})

it("applies only after a matching preview: decision row read back first, then GitSuper's retire --discard, then the result", async () => {
  const w = world()
  await discardRetainedEntry(w.options, capture(w.root).io, w.runSuper, noPins)
  const out = capture(w.root)
  expect(await discardRetainedEntry({ ...w.options, apply: true }, out.io, w.runSuper, noPins)).toBe(0)
  const retire = w.calls.find((call) => call.includes("retire")) ?? []
  expect(retire).toEqual(expect.arrayContaining(["retire", "--discard"]))
  const disposition = JSON.parse(readFileSync(retire[retire.indexOf("--discard") + 1] as string, "utf8"))
  expect(disposition).toMatchObject({ entry: join(w.options.retentionRoot, "linked-abc"), missingCount: 2 })
  const rows = logRows(w).filter((row) => row.kind === "retained-discard")
  expect(rows.map((row) => row.outcome)).toEqual(["decision", "discarded"])
  expect(rows[0]).toMatchObject({ actor: "@seat/decider", owner: "unknown", reason: "abandoned experiment" })
  expect(rows[0]?.roots).toEqual([`packages/alpha ${LOCAL} local only`])
  expect(out.stdout()).toContain("lost by @seat/decider's decision")
})

it.each([
  ["no preview", (w: World) => w.options, "no discard preview"],
  ["an unknown actor", (w: World) => ({ ...w.options, actor: "unknown" }), "requires an identified actor"],
  ["no reason", (w: World) => ({ ...w.options, reason: " " }), "requires --reason"],
])("refuses --apply with %s and discards nothing", async (_name, change, says) => {
  const w = world(true)
  await expect(discardRetainedEntry(change(w), capture(w.root).io, w.runSuper, noPins)).rejects.toThrow(says)
  expect(w.calls.some((call) => call.includes("retire"))).toBe(false)
})

it.each([
  [
    "more un-witnessed objects",
    (w: World) => w.sidecar([`${LOCAL}\tpackages/alpha\towned`, `${TREE}\tp\to`, `${"3".repeat(40)}\tp\to`]),
    {},
  ],
  ["another reason", () => undefined, { reason: "other" }],
  ["another actor", () => undefined, { actor: "@seat/someone" }],
])("refuses --apply when %s differ from the preview", async (_name, mutate, override) => {
  const w = world()
  await discardRetainedEntry(w.options, capture(w.root).io, w.runSuper, noPins)
  mutate(w)
  await expect(
    discardRetainedEntry({ ...w.options, apply: true, ...override }, capture(w.root).io, w.runSuper, noPins),
  ).rejects.toThrow("differs from the preview")
  expect(w.calls.some((call) => call.includes("retire"))).toBe(false)
})

/** A real root store: `main` pins an unrelated commit; only refs outside heads, tags and pins hold the lost one. */
function rootStore(root: string): RootGit {
  const repo = join(root, "root-store")
  const run = (args: readonly string[], input?: string) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      ...(input === undefined ? {} : { input }),
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    })
  mkdirSync(repo)
  run(["init", "-q", "-b", "main"])
  run(["update-index", "--add", "--cacheinfo", `160000,${"4".repeat(40)},packages/alpha`])
  run(["commit", "-q", "-m", "main pins an unrelated commit"])
  run(["update-index", "--cacheinfo", `160000,${LOCAL},packages/alpha`])
  run(["commit", "-q", "-m", "a queued change pins the lost commit"])
  const pinning = run(["rev-parse", "HEAD"]).trim()
  run(["update-ref", "refs/yrd/main/changes/7", pinning])
  run(["update-ref", "refs/remotes/origin/task/7", pinning])
  run(["tag", "-a", "-m", "parked", "parked-7", pinning])
  run(["update-ref", "refs/archive/parked-7", run(["rev-parse", "refs/tags/parked-7"]).trim()])
  run(["update-ref", "-d", "refs/tags/parked-7"])
  run(["reset", "-q", "--soft", "HEAD~1"])
  return async (args, input) => run(args, input)
}

it("refuses while any root ref, in any namespace, still pins a lost commit, and names the ref to withdraw first", async () => {
  const w = world()
  const store = rootStore(w.root)
  const preview = capture(w.root)
  await discardRetainedEntry(w.options, preview.io, w.runSuper, store)
  // refs/heads/main, refs/yrd/main/changes/7, refs/remotes/origin/task/7 and the annotated refs/archive/parked-7.
  expect(preview.stdout()).toContain(
    "root pin check: 4 ref(s) in every namespace, 3 distinct tip(s); 2 pin a lost commit",
  )
  expect(preview.stdout()).toMatch(
    /protected: refs\/(remotes|yrd)\/\S+ \(and 1 more ref\(s\) at that tip\) pins packages\/alpha at 1{40}/u,
  )
  expect(preview.stdout()).toContain(`protected: refs/archive/parked-7 pins packages/alpha at ${LOCAL}`)
  await expect(
    discardRetainedEntry({ ...w.options, apply: true }, capture(w.root).io, w.runSuper, store),
  ).rejects.toThrow("2 root ref(s) still pin a lost commit")
  expect(w.calls.some((call) => call.includes("retire"))).toBe(false)
})

it("throws, never reads 'no pin', when a root ref's tree on the component path is not in the local store", async () => {
  const w = world()
  const store = rootStore(w.root)
  const repo = join(w.root, "root-store")
  // A partial clone without the `packages` tree of the queued change: `missing` there is not an absent path.
  const tree = execFileSync("git", ["-C", repo, "rev-parse", "refs/yrd/main/changes/7:packages"], {
    encoding: "utf8",
  }).trim()
  const loose = join(repo, ".git", "objects", tree.slice(0, 2), tree.slice(2))
  rmSync(loose)
  const shared = execFileSync("git", ["-C", repo, "rev-parse", "refs/heads/main:packages"], { encoding: "utf8" }).trim()
  expect(shared).not.toBe(tree)
  await expect(discardRetainedEntry(w.options, capture(w.root).io, w.runSuper, store)).rejects.toThrow(
    "packages is named in its tree but not in the local store",
  )
})

it("throws, never reads 'no pin', when the root pin check cannot account for its answers", async () => {
  const w = world()
  const short = async (args: readonly string[]) =>
    args[0] === "for-each-ref" ? `${"9".repeat(40)} refs/yrd/main/changes/8\n` : ""
  await expect(discardRetainedEntry(w.options, capture(w.root).io, w.runSuper, short)).rejects.toThrow(
    "the root pin check asked 1 and got 0 answers",
  )
})

it("records a kept result when GitSuper keeps the entry, and a retry after the cause clears discards it", async () => {
  const w = world()
  await discardRetainedEntry(w.options, capture(w.root).io, w.runSuper, noPins)
  w.retire.code = 1
  w.retire.detail = { code: "lease-held", message: "Existing common lease is held; entry preserved." }
  const kept = capture(w.root)
  expect(await discardRetainedEntry({ ...w.options, apply: true }, kept.io, w.runSuper, noPins)).toBe(1)
  expect(kept.stdout()).toContain("kept")
  expect(kept.stdout()).toContain("rerun --apply")
  w.retire.code = 0
  w.retire.detail = { code: "discarded", message: "Discarded" }
  expect(await discardRetainedEntry({ ...w.options, apply: true }, capture(w.root).io, w.runSuper, noPins)).toBe(0)
  const outcomes = logRows(w)
    .filter((row) => row.kind === "retained-discard")
    .map((row) => row.outcome)
  expect(outcomes.sort()).toEqual(["decision", "decision", "discarded", "kept"])
})

it.each([
  [["--discard", "linked-abc", "--reason", "why", "--retire-expired"], "never joins --retire-expired"],
  [["--reason", "why"], "--reason belongs to --discard"],
])("the env retained CLI refuses %j before touching anything", async (args, says) => {
  const root = mkdtempSync(join(tmpdir(), "yrd-retained-discard-cli-"))
  roots.push(root)
  const out = capture(root)
  const code = await runYrdProcess(["bun", "yrd", "env", "retained", ...args], out.io)
  expect(code).not.toBe(0)
  expect(out.stderr()).toContain(says)
})

it("refuses to discard when gate 5 is unknown: an unproven loss is never discarded", async () => {
  const w = world()
  w.custodyStatus.value = "unknown"
  await expect(discardRetainedEntry(w.options, capture(w.root).io, w.runSuper, noPins)).rejects.toThrow(
    "is not known, so it cannot be discarded",
  )
  expect(w.calls.some((call) => call.includes("retire"))).toBe(false)
})
