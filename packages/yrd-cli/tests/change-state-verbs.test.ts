/**
 * @failure Every seat hand-pushes `refs/yrd/*` decision refs because the CLI has no verb that moves a branch into a state, so a mistyped refspec is the only feedback a wrong push gives (bead-branch-is-change, phase 1c).
 * @level l2
 * @consumer @yrd/cli draft|submit|archive|ignore
 *
 * A branch IS a change, and four state-targeting verbs move one INTO a state.
 * There are no un-verbs: `draft` is how a branch is unsubmitted or unshelved.
 *
 * The receiver (`@yrd/bay` receiver.ts) owns every RULE — which writes are
 * legal, what auto-classification does, when an ignore is refused. This
 * surface owns only SELECTION and TRANSPORT: expand the selectors, print what
 * they resolved to, push, and hand the receiver's own refusal back unaltered.
 * A rule restated here would drift from the one that enforces it.
 *
 * EVERY TEST HERE DRIVES INJECTED GIT FACTS, SO GREEN HERE IS NOT GREEN. All
 * eleven passed while `yrd draft` in a real repository refused with "no
 * current Git branch to act on", because the bare path read a seam only tests
 * set. Running the verb against a real repository is a required smoke test
 * for this whole verb family, not an optional extra — the injected suite
 * cannot see that class of bug at all.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { createBayJobDefs, withBays, volatilePrNumberMint } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { withContests, type ContestGit } from "@yrd/contest"
import { withIssues } from "@yrd/issue"
import { withJobs, type JobResult } from "@yrd/job"
import { withMerge, withQueue, withStep, type ChangeShape, type StepExecution } from "@yrd/queue"
import { runYrd, type ChangeStateGitFacts, type YrdCliIO } from "@yrd/cli"
import type { ProcessRequest } from "@yrd/process"
import { createLogger } from "loggily"
import { createChangeStateGitFacts } from "../src/change-state.ts"

const BASE_SHA = "a".repeat(40)
const MERGED_SHA = "b".repeat(40)

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace() {
  return {
    revision: "change-state-workspace-v1",
    provision: (input: { bay: string }) => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { path: `/repo/.bays/${input.bay}`, headSha: MERGED_SHA, baseSha: BASE_SHA },
    }),
    refresh: (input: { bay: string; path?: string }) => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: MERGED_SHA, baseSha: BASE_SHA, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { headSha: MERGED_SHA, pushed: true as const, wip: false },
    }),
    deprovision: () => ({ status: "completed" as const, conclusion: "success" as const, output: {} }),
  }
}

async function createCliApp() {
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
  const queue = withQueue({ steps: [check, merge] as const, batch: false })
  const git: ContestGit = { revision: "git-v1", resolveCommit: () => BASE_SHA }
  const contests = withContests({ runners: [], evaluators: [], git })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs, contests.jobDefs] }),
    withIssues({ sources: [{ id: "km", resolve: (ref) => ({ ref, title: "Issue one" }) }] }),
    withBays({
      prNumberMint: volatilePrNumberMint(),
      jobs: bayJobs,
      defaultBase: "main",
      resolveBase: (ref) => ({ base: ref, baseSha: BASE_SHA }),
    }),
  )
  return createYrd(contests(queue(base)), {
    inject: {
      journal: createMemoryJournal(),
      clock: () => "2026-08-19T12:00:00.000Z",
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
    columns: 120,
    runner: "change-state-test",
    leaseMs: 60_000,
    now: () => Date.parse("2026-08-19T12:01:00.000Z"),
    ...overrides,
  }
  return { io, stdout: () => stdout, stderr: () => stderr }
}

function yrd(...args: string[]): string[] {
  return ["/usr/bin/bun", "/repo/bin/yrd.ts", ...args]
}

/** Every push this fixture receives, in order, as the exact argv after `git`. */
type Pushes = { readonly calls: string[][] }

/**
 * Branch facts for a repository holding `branches`, with no decision ref set
 * on anything. Overrides replace one capability so a test proves exactly
 * which plumbing the verb consulted.
 */
function stateGit(
  branches: readonly string[],
  overrides: Partial<ChangeStateGitFacts> = {},
): { facts: ChangeStateGitFacts; pushes: Pushes } {
  const pushes: Pushes = { calls: [] }
  const facts: ChangeStateGitFacts = {
    branches: () => branches,
    remoteRef: () => undefined,
    push: (args) => {
      pushes.calls.push([...args])
      return { ok: true, output: "" }
    },
    ...overrides,
  }
  return { facts, pushes }
}

const BRANCHES = ["main", "task/alpha", "task/beta", "topic/gamma", "yrd/candidates/PR1"]

let app: CliApp

beforeAll(async () => {
  app = (await createCliApp()) as CliApp
})

describe("branch state verbs — default transport", () => {
  it("runs every Git operation through the injected shared process adapter", async () => {
    const calls: ProcessRequest[] = []
    const process = {
      async run(request: ProcessRequest) {
        calls.push(request)
        const args = request.argv.slice(3)
        const stdout =
          args[0] === "for-each-ref"
            ? "main\ntask/alpha\n"
            : args[0] === "ls-remote"
              ? `${BASE_SHA}\trefs/yrd/submit/task/alpha\n`
              : ""
        return {
          exitCode: 0,
          signal: null,
          stdout,
          stderr: "",
          durationMs: 1,
          timedOut: false as const,
        }
      },
    }
    const facts = createChangeStateGitFacts("/repo", process)

    expect(await facts.branches()).toEqual(["main", "task/alpha"])
    expect(await facts.remoteRef("refs/yrd/submit/task/alpha")).toBe(BASE_SHA)
    expect(await facts.push(["push", "--atomic", "origin", "task/alpha:refs/yrd/submit/task/alpha"])).toEqual({
      ok: true,
      output: "",
    })
    expect(calls.map(({ argv }) => argv)).toEqual([
      ["git", "-C", "/repo", "for-each-ref", "--format=%(refname:short)", "refs/heads"],
      ["git", "-C", "/repo", "ls-remote", "origin", "refs/yrd/submit/task/alpha"],
      ["git", "-C", "/repo", "push", "--atomic", "origin", "task/alpha:refs/yrd/submit/task/alpha"],
    ])
    expect(calls.every(({ timeoutMs }) => timeoutMs === 30_000)).toBe(true)
  })
})

describe("branch state verbs — selection", () => {
  it("resolves a bare invocation to the current branch and prints what it will push", async () => {
    const { facts, pushes } = stateGit(BRANCHES)
    const human = outputIO({ currentBranch: () => "task/alpha", changeStateGit: () => facts })

    expect(await runYrd(app, yrd("draft"), human.io), human.stderr()).toBe(0)

    // The resolved set is never implicit: the operator must never wonder what
    // a bare invocation or a glob expanded to.
    expect(human.stdout()).toContain("task/alpha")
    expect(human.stdout()).toContain("git push")
    expect(pushes.calls).toEqual([["push", "--atomic", "origin", "task/alpha:refs/yrd/draft/task/alpha"]])
  })

  it("expands a quoted glob against real branches and leaves non-matches alone", async () => {
    const { facts, pushes } = stateGit(BRANCHES)
    const human = outputIO({ changeStateGit: () => facts })

    expect(await runYrd(app, yrd("branch", "submit", "task/*"), human.io), human.stderr()).toBe(0)

    expect(pushes.calls).toEqual([
      ["push", "--atomic", "origin", "task/alpha:refs/yrd/submit/task/alpha", "task/beta:refs/yrd/submit/task/beta"],
    ])
    expect(human.stdout()).not.toContain("topic/gamma")
  })

  it("mixes literal branch names and globs in one variadic selection", async () => {
    const { facts, pushes } = stateGit(BRANCHES)
    const human = outputIO({ changeStateGit: () => facts })

    expect(await runYrd(app, yrd("ignore", "topic/gamma", "task/*"), human.io), human.stderr()).toBe(0)

    expect(pushes.calls[0]?.slice(3)).toEqual([
      "task/alpha:refs/yrd/ignore/task/alpha",
      "task/beta:refs/yrd/ignore/task/beta",
      "topic/gamma:refs/yrd/ignore/topic/gamma",
    ])
  })

  it("fails loud and names the pattern when a glob matches no branch", async () => {
    const { facts, pushes } = stateGit(BRANCHES)
    const human = outputIO({ changeStateGit: () => facts })

    // An ACTION with no target is a mistake, never a legitimate empty result:
    // a silent success here reads as "done" for work that never happened.
    expect(await runYrd(app, yrd("branch", "submit", "release/*"), human.io)).toBe(1)
    expect(human.stderr()).toContain("release/*")
    expect(pushes.calls).toEqual([])
  })

  it("refuses a literal branch name that does not exist", async () => {
    const { facts, pushes } = stateGit(BRANCHES)
    const human = outputIO({ changeStateGit: () => facts })

    expect(await runYrd(app, yrd("draft", "task/typo"), human.io)).toBe(1)
    expect(human.stderr()).toContain("task/typo")
    expect(pushes.calls).toEqual([])
  })

  it("refuses a bare invocation on an internal queue branch instead of guessing", async () => {
    const { facts, pushes } = stateGit(BRANCHES)
    const human = outputIO({ currentBranch: () => "yrd/candidates/PR1", changeStateGit: () => facts })

    expect(await runYrd(app, yrd("branch", "submit"), human.io)).toBe(1)
    expect(human.stderr()).toContain("yrd/candidates/PR1")
    expect(pushes.calls).toEqual([])
  })
})

describe("branch state verbs — transport", () => {
  it("archives by deleting the branch, which is the only write the shelf accepts", async () => {
    const { facts, pushes } = stateGit(BRANCHES)
    const human = outputIO({ changeStateGit: () => facts })

    expect(await runYrd(app, yrd("archive", "task/alpha", "task/beta"), human.io), human.stderr()).toBe(0)

    // receiver.ts refuses every direct push to `refs/yrd/archive/`; archival
    // is the receiver translating a `refs/heads/` deletion.
    expect(pushes.calls).toEqual([["push", "--atomic", "origin", ":refs/heads/task/alpha", ":refs/heads/task/beta"]])
  })

  it("unsubmits as part of drafting when a submit ref stands, and only then", async () => {
    const { facts, pushes } = stateGit(BRANCHES, {
      remoteRef: (ref) => (ref === "refs/yrd/submit/task/alpha" ? MERGED_SHA : undefined),
    })
    const human = outputIO({ changeStateGit: () => facts })

    expect(await runYrd(app, yrd("draft", "task/*"), human.io), human.stderr()).toBe(0)

    // task/alpha carries a live submit, so drafting it withdraws that approval;
    // task/beta never had one, and a delete of a ref that does not exist would
    // make the whole push fail.
    expect(pushes.calls[0]?.slice(3)).toEqual([
      "task/alpha:refs/yrd/draft/task/alpha",
      ":refs/yrd/submit/task/alpha",
      "task/beta:refs/yrd/draft/task/beta",
    ])
  })

  it("prints the resolved set and the exact git command without acting under --dry-run", async () => {
    const { facts, pushes } = stateGit(BRANCHES)
    const human = outputIO({ changeStateGit: () => facts })

    expect(await runYrd(app, yrd("branch", "submit", "task/*", "--dry-run"), human.io), human.stderr()).toBe(0)

    expect(pushes.calls).toEqual([])
    const output = human.stdout()
    expect(output).toContain("task/alpha")
    expect(output).toContain("task/beta")
    expect(output).toContain(
      "git push --atomic origin task/alpha:refs/yrd/submit/task/alpha task/beta:refs/yrd/submit/task/beta",
    )
  })

  it("hands the receiver's refusal back unaltered when a push is rejected", async () => {
    // Verbatim from receiver.ts:1391-1395 — the surface must not paraphrase,
    // truncate or re-wrap it, or the operator loses the one instruction that
    // says what to do next ("unsubmit it first").
    const refusal =
      "cannot ignore branch 'task/alpha': a live submit bbbbbbbbbbbb exists on it; " +
      "submitted work can never be hidden — unsubmit it first"
    const { facts } = stateGit(BRANCHES, {
      push: () => ({ ok: false, output: `remote: yrd: ${refusal}\n` }),
    })
    const human = outputIO({ changeStateGit: () => facts })

    expect(await runYrd(app, yrd("ignore", "task/alpha"), human.io)).toBe(1)
    expect(human.stderr()).toContain(refusal)
  })
})

describe("branch state verbs — archive message", () => {
  it("states that an archive message is not transmitted rather than dropping it silently", async () => {
    const { facts, pushes } = stateGit(BRANCHES)
    const human = outputIO({ changeStateGit: () => facts })

    expect(await runYrd(app, yrd("archive", "task/alpha", "-m", "superseded by task/beta"), human.io)).toBe(0)

    // The receiver has no message channel at all (no GIT_PUSH_OPTION handling
    // anywhere in packages/, and `applyArchival` takes no message). Accepting
    // `-m` and saying nothing would be a silent drop.
    const said = human.stdout() + human.stderr()
    expect(said).toContain("superseded by task/beta")
    expect(said).toMatch(/not transmitted|no message channel/iu)
    expect(pushes.calls).toEqual([["push", "--atomic", "origin", ":refs/heads/task/alpha"]])
  })
})
