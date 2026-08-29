/**
 * @failure `deriveRefOnlyMembers` returns the same empty array for a healthy
 * empty derived lane and for an unconfigured PR-number mint, and the
 * `unrecorded-submit` audit row that survives both enumerates three causes it
 * cannot tell apart — so a reader who eliminates the runner is left choosing
 * between a serious misconfiguration and a no-op with no evidence to separate
 * them. Measured cost (@i/10-yrd/23996-derived-empty-silent): two seats spent
 * hours in opposite directions, and a third read `.git/yrd/pr-mint.json` by
 * hand to rule the mint out.
 *
 * Asserted on the RENDERED bytes of `yrd queue audit`, never on the message
 * handed to the finding: `actionableFailure` rewrites a failure into
 * code/cause/resolution through `oneLineCause`, so a test on the constructor
 * argument fences text no operator ever reads.
 * @level l2
 * @consumer @yrd/cli every operator reading `yrd queue audit`
 */
import { describe, expect, it } from "vitest"
import { createBayJobDefs, withBays, volatilePrNumberMint } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { withContests, type CommitResolver } from "@yrd/contest"
import { withIssues } from "@yrd/issue"
import { withJobs, type JobResult } from "@yrd/job"
import { withMerge, withQueue, withStep, type ChangeShape, type StepExecution } from "@yrd/queue"
import { runYrd, type YrdCliIO } from "@yrd/cli"
import { createLogger } from "loggily"

const WIDTH = 120
const BASE_SHA = "a".repeat(40)
const MERGED_SHA = "b".repeat(40)
const SUBMIT_SHA = "c".repeat(40)
const BRANCH = "@i/10-yrd/23996-derived-empty-silent"
const SUBMITTED_AT = "2026-08-28T12:00:00.000Z"
/** An hour on, so the row is past DRAFT_STRANDED_GRACE_MS and the audit prints it. */
const NOW = "2026-08-28T13:00:00.000Z"

function ids(): () => string {
  let value = 0
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace() {
  return {
    revision: "derived-empty-workspace-v1",
    provision: (input: { bay: string }) => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { path: `/repo/.bays/${input.bay}`, headSha: BASE_SHA, baseSha: BASE_SHA },
    }),
    refresh: (input: { bay: string; path?: string }) => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: BASE_SHA, baseSha: BASE_SHA, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { headSha: BASE_SHA, pushed: true as const, wip: false },
    }),
    deprovision: () => ({ status: "completed" as const, conclusion: "success" as const, output: {} }),
  }
}

/**
 * `mint: false` is the UNWIRED queue — `withQueue` without `prNumberMint`, the
 * exact configuration the audit used to describe as one of three
 * indistinguishable possibilities. `mint: true` is how production wires it
 * (host.ts hands the same durable pr-mint.json store to both plugins).
 */
async function createCliApp(options: Readonly<{ mint: boolean }>) {
  const bayJobs = createBayJobDefs(workspace())
  const check = withStep(
    "check",
    (): JobResult<JsonValue> => ({ status: "completed", conclusion: "success", output: { checked: true } }),
    { revision: "check-v1", output: JsonSchema, classification: "carrier" },
  )
  const merge = withMerge(
    async (_input: StepExecution<ChangeShape>): Promise<JobResult<{ commit: string; baseSha: string }>> => ({
      status: "completed",
      conclusion: "success",
      output: { commit: MERGED_SHA, baseSha: MERGED_SHA },
    }),
    { revision: "merge-v1" },
  )
  const mint = volatilePrNumberMint()
  const queue = withQueue({
    steps: [check, merge] as const,
    batch: false,
    ...(options.mint ? { prNumberMint: mint } : {}),
  })
  const git: CommitResolver = { revision: "git-v1", resolveCommit: () => BASE_SHA }
  const contests = withContests({ runners: [], evaluators: [], git })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs, contests.jobDefs] }),
    withIssues({ sources: [{ id: "km", resolve: (ref) => ({ ref, title: "Issue one" }) }] }),
    withBays({
      prNumberMint: mint,
      jobs: bayJobs,
      defaultBase: "main",
      resolveBase: (ref) => ({ base: ref, baseSha: BASE_SHA }),
    }),
  )
  return createYrd(contests(queue(base)), {
    inject: {
      journal: createMemoryJournal(),
      clock: () => SUBMITTED_AT,
      id: ids(),
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

type CliApp = Awaited<ReturnType<typeof createCliApp>>

function outputIO(overrides: Partial<YrdCliIO> = {}) {
  let stdout = ""
  let stderr = ""
  const io: YrdCliIO = {
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
    cwd: "/repo",
    columns: WIDTH,
    runner: "derived-empty-test",
    leaseMs: 60_000,
    resolveRevision: async () => "f".repeat(40),
    now: () => Date.parse(NOW),
    ...overrides,
  }
  return { io, stdout: () => stdout, stderr: () => stderr }
}

function yrd(...args: string[]): string[] {
  return ["/usr/bin/bun", "/repo/bin/yrd.ts", ...args]
}

/**
 * One standing submit fact, then the rendered bytes of `yrd queue audit`.
 *
 * Each arm reproduces the state that actually leaves the row standing, which
 * is why only the unwired arm composes: with no mint the compose runs and
 * admits nothing, and with a mint configured the row survives precisely
 * BECAUSE no runner has composed yet — a compose here would admit the branch
 * and retire the row it exists to render.
 */
async function auditBytes(mint: boolean): Promise<string> {
  const app = await createCliApp({ mint })
  try {
    await app.bays.recordBranchSubmit({ branch: BRANCH, sha: SUBMIT_SHA, base: "main" })
    if (!mint) await app.queue.run({}, { runner: "derived-empty-test", leaseMs: 60_000 })
    const out = outputIO()
    // A finding exits 1 — the audit is only interesting here because it found one.
    expect(await runYrd(app as CliApp, yrd("queue", "audit"), out.io), out.stderr()).toBe(1)
    return out.stdout()
  } finally {
    await app.close()
  }
}

/**
 * The rendered bytes with the terminal's own wrapping collapsed. `queue audit`
 * hard-wraps the cause at `io.columns`, so a substring assertion against the
 * raw stream is really an assertion about where a line break landed — it fails
 * on a correct message and passes on a wrong one that happens to break
 * elsewhere. Collapsing whitespace keeps this a test of what a reader reads.
 */
function flat(rendered: string): string {
  return rendered.replace(/\s+/gu, " ").trim()
}

/** The `cause:` block a reader actually reads — every rendered row from the
 * cause up to its resolution, wrap collapsed. */
function cause(rendered: string): string {
  const rows = rendered.split("\n")
  const start = rows.findIndex((row) => row.startsWith("cause: "))
  if (start < 0) throw new Error(`no cause line in rendered audit:\n${rendered}`)
  const end = rows.findIndex((row, index) => index > start && row.startsWith("resolve: "))
  return flat(rows.slice(start, end < 0 ? undefined : end).join(" "))
}

describe("the unrecorded-submit audit line names the cause it observed", () => {
  it("says derived admission is UNWIRED, and names the mint, when no PR-number mint is configured", async () => {
    const rendered = flat(await auditBytes(false))

    expect(rendered).toContain("err=unrecorded-submit")
    expect(rendered).toContain(BRANCH)
    // The observed cause, in the bytes an operator reads.
    expect(rendered).toContain("derived admission is UNWIRED here")
    expect(rendered).toContain("no PR-number mint is configured")
    expect(rendered).toContain("pr-mint.json")
    // ...and NOT the three-cause list it replaced. A reader who eliminated the
    // runner used to be left guessing between this state and a healthy one.
    expect(rendered).not.toContain("no runner is composing, derived admission is unwired")
    expect(rendered).not.toContain("or the derivation was refused")
    // The retired listing-command noun never comes back.
    expect(rendered).not.toMatch(/queue\s+log/iu)
  })

  it("says derived admission IS wired, and narrows to the compose, when the mint is configured", async () => {
    const rendered = flat(await auditBytes(true))

    expect(rendered).toContain("err=unrecorded-submit")
    expect(rendered).toContain(BRANCH)
    expect(rendered).toContain("derived admission IS wired here")
    expect(rendered).toContain("PR-number mint configured")
    // The residual pair used to be named as a pair pointing at action
    // 'compose-derived-refused' in the runner log — and that pointer was the
    // question restated: measured 2026-08-28 over 130 runner logs, 425 rows
    // carried it while the 20 most recent logs held ZERO such events. The
    // compose knows the cause and now carries it onto the row, so the pointer
    // is gone from every rendering.
    expect(rendered).not.toContain("compose-derived-refused")
    expect(rendered).not.toContain("habitant runner log")
    expect(rendered).not.toContain("either no runner is composing")
    // `yrd queue audit` is a CLI process; it never composes. The one thing it
    // must never do is answer as if it had looked, so it says which zero it is
    // (ruling 22895) and names the surface that DID compose.
    expect(rendered).toContain("no compose has run in this process")
    expect(rendered).toContain("projection read")
    expect(rendered).not.toContain("derived admission is UNWIRED here")
    expect(rendered).not.toMatch(/queue\s+log/iu)
  })

  it("renders a DIFFERENT cause for the two states — the whole defect was that it did not", async () => {
    const [unwired, wired] = await Promise.all([auditBytes(false), auditBytes(true)])

    expect(cause(unwired)).not.toBe(cause(wired))
  })
})
