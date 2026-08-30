/**
 * @failure Issue references resolve through the wrong source, leak ambient process policy, or lose tracker identity.
 * @level l1
 * @consumer @yrd/issue
 */
import { expect, it } from "vitest"
import { createMemoryJournal, createYrd, createYrdDef, failureFact } from "@yrd/core"
import { createCommandIssueSource, createKmIssueSource, createIssues, withIssues, type Issue } from "../src/index.ts"

async function resolveKmNode(node: Readonly<Record<string, unknown>>): Promise<Issue> {
  const source = createKmIssueSource({
    process: {
      async run() {
        return {
          exitCode: 0,
          signal: null,
          stderr: "",
          stdout: JSON.stringify({ node }),
          durationMs: 1,
          timedOut: false,
        }
      },
    },
  })
  return await createIssues({ sources: [source] }).resolve({
    source: "km",
    id: "@ag/tribe/22497-daemon-silent-send-truncation",
  })
}

it("resolves source-owned ids and composes without mutating its host", async () => {
  let argv: readonly string[] = []
  let environment: NodeJS.ProcessEnv | undefined
  let timeoutMs: number | undefined
  const source = createCommandIssueSource({
    id: "issues",
    command: ["issue", "show", "--json"],
    env: { GIT_DIR: "/poison.git", YRD_JOB: "private", CALLER_TEST_MARKER: "preserved" },
    process: {
      async run(request) {
        argv = request.argv
        environment = request.env
        timeoutMs = request.timeoutMs
        return {
          exitCode: 0,
          signal: null,
          stdout: '{"title":" Fix release ","labels":[" bug "]}',
          stderr: "",
          durationMs: 1,
          timedOut: false,
        }
      },
    },
  })
  const issues = createIssues({ sources: [source], defaultSource: "issues" })
  const base = createYrdDef()
  const definition = withIssues({ sources: [source] })(base)
  const app = await createYrd(definition, { inject: { journal: createMemoryJournal() } })
  expect(app.issues.sources).toEqual(["issues"])
  expect(base.create).not.toBe(definition.create)
  await expect(issues.resolve(issues.ref("issues:release:2.0"))).resolves.toEqual({
    ref: { source: "issues", id: "release:2.0" },
    title: "Fix release",
    labels: ["bug"],
  })
  expect(argv).toEqual(["issue", "show", "--json", "release:2.0"])
  expect(environment).toMatchObject({
    CALLER_TEST_MARKER: "preserved",
    YRD_ISSUE_SOURCE: "issues",
    YRD_ISSUE_ID: "release:2.0",
  })
  expect(environment).not.toHaveProperty("GIT_DIR")
  expect(environment).not.toHaveProperty("YRD_JOB")
  expect(timeoutMs).toBe(60_000)
  expect(() => createIssues({ sources: [source, source] })).toThrow("duplicate issue source 'issues'")
  await expect(issues.resolve({ source: "missing", id: "1" })).rejects.toThrow("no issue source")
  await app.close()
})

/**
 * @i/10-yrd/tracker-timeout-is-not-source-unavailable — a source that merely
 * ran past the bound must classify distinctly from one that hard-failed, so a
 * caller (human or `--json` reader) can tell "slow tracker" from "tracker is
 * dead" by CODE alone, never by parsing the message.
 */
it("classifies a timed-out read as 'issue-source-timeout', naming the measured elapsed time and the bound — never the generic 'issue-source-failed'", async () => {
  const source = createKmIssueSource({
    process: {
      async run() {
        // A source that was merely SLOW, not broken: the process was killed
        // at the bound, but it was still alive and had produced no error of
        // its own — Process.run's real timedOut branch never carries a zero
        // exitCode or JSON stdout, so this models that shape rather than a
        // clean success cut short.
        return { exitCode: -1, signal: null, stdout: "", stderr: "", durationMs: 28_344, timedOut: true }
      },
    },
  })
  const failure = await createIssues({ sources: [source] })
    .resolve({ source: "km", id: "@yrd/core/21012" })
    .then(
      () => undefined,
      (error: unknown) => error,
    )
  const fact = failureFact(failure)
  expect(fact?.code).toBe("issue-source-timeout")
  expect(fact?.code).not.toBe("issue-source-failed")
  expect(fact?.kind).toBe("infrastructure")
  expect(fact?.message).toContain("timed out after 28344ms")
  expect(fact?.message).toContain("bound 60000ms")
})

it("still raises 'issue-source-failed' for a genuine hard failure — never misclassified as a timeout", async () => {
  const source = createKmIssueSource({
    process: {
      async run() {
        return {
          exitCode: 1,
          signal: null,
          stdout: "",
          stderr: "km: vault unreadable",
          durationMs: 42,
          timedOut: false,
        }
      },
    },
  })
  const failure = await createIssues({ sources: [source] })
    .resolve({ source: "km", id: "@yrd/core/21012" })
    .then(
      () => undefined,
      (error: unknown) => error,
    )
  const fact = failureFact(failure)
  expect(fact?.code).toBe("issue-source-failed")
  expect(fact?.code).not.toBe("issue-source-timeout")
  expect(fact?.kind).toBe("infrastructure")
  expect(fact?.message).toContain("vault unreadable")
})

it("projects km context while keeping a path-form id as one argument", async () => {
  let argv: readonly string[] = []
  const source = createKmIssueSource({
    process: {
      async run(request) {
        argv = request.argv
        return {
          exitCode: 0,
          signal: null,
          stderr: "",
          stdout: '{"node":{"content":"Implement Yrd","version":"v2"},"blocks":[{"body":["Ship it"]}]}',
          durationMs: 1,
          timedOut: false,
        }
      },
    },
  })
  const issue = await createIssues({ sources: [source] }).resolve({ source: "km", id: "@yrd/core/21012" })
  expect(argv.at(-1)).toBe("@yrd/core/21012")
  expect(issue).toMatchObject({ title: "Implement Yrd", description: "Ship it", revision: "v2" })
})

it("reads a blank km version as absent so an unreconciled node still resolves", async () => {
  // A bead that has not yet been through a reconcile pass carries version: "".
  // The updated_at fallback exists for exactly that node, but `??` only steps
  // over null/undefined, so the empty string survived to a schema that refuses
  // it — and yrd could not open work on a legitimate, pushed, indexed bead.
  await expect(
    resolveKmNode({ title: "Fix the daemon", version: "", updated_at: 1785257396576 }),
  ).resolves.toMatchObject({ revision: "1785257396576" })
  await expect(
    resolveKmNode({ title: "Fix the daemon", version: "   ", updated_at: 1785257396576 }),
  ).resolves.toMatchObject({ revision: "1785257396576" })
})

it("keeps a real km version, including the falsy ones a truthiness test would drop", async () => {
  await expect(
    resolveKmNode({ title: "Fix the daemon", version: "reconcile-parsed-01KY", updated_at: 1785257396576 }),
  ).resolves.toMatchObject({ revision: "reconcile-parsed-01KY" })
  // Revision 0 is a revision. `||` would read it as absence and silently
  // report the node one revision it does not have instead of the one it does.
  await expect(
    resolveKmNode({ title: "Fix the daemon", version: 0, updated_at: 1785257396576 }),
  ).resolves.toMatchObject({ revision: "0" })
})

it("omits the revision entirely when neither km field carries one", async () => {
  await expect(resolveKmNode({ title: "Fix the daemon", version: "", updated_at: "" })).resolves.not.toHaveProperty(
    "revision",
  )
})

it("falls through a blank km title to the fields that stand in for it", async () => {
  // Same shape as the revision defect: `??` reads "" as a title and hands the
  // schema a value it refuses, instead of using the fallback chain that exists.
  await expect(resolveKmNode({ title: "", content: "Fix the daemon" })).resolves.toMatchObject({
    title: "Fix the daemon",
  })
  await expect(resolveKmNode({ title: " ", content: " ", name: "22497-daemon" })).resolves.toMatchObject({
    title: "22497-daemon",
  })
})

it("treats a blank km url as no url rather than an unusable one", async () => {
  await expect(resolveKmNode({ title: "Fix the daemon", data: { url: "" } })).resolves.not.toHaveProperty("url")
})

it("strips DEBUG from the issue subprocess and says so out loud", async () => {
  let environment: NodeJS.ProcessEnv | undefined
  const warnings: string[] = []
  const source = createKmIssueSource({
    env: { DEBUG: "*", DEBUG_LOG: "/tmp/km-debug.log", CALLER_TEST_MARKER: "preserved" },
    warn: (text) => warnings.push(text),
    process: {
      async run(request) {
        environment = request.env
        return {
          exitCode: 0,
          signal: null,
          stderr: "",
          stdout: '{"node":{"content":"Implement Yrd"}}',
          durationMs: 1,
          timedOut: false,
        }
      },
    },
  })
  await createIssues({ sources: [source] }).resolve({ source: "km", id: "@yrd/core/21012" })
  // DEBUG makes km write its debug stream to stdout, which is the same channel
  // the --json protocol uses. Strip it, and never strip it quietly.
  expect(environment).not.toHaveProperty("DEBUG")
  expect(environment).toMatchObject({ DEBUG_LOG: "/tmp/km-debug.log", CALLER_TEST_MARKER: "preserved" })
  expect(warnings.join("\n")).toContain("DEBUG")
  expect(warnings.join("\n")).toContain("km")
})

it("names the command and the offending output when an issue source returns invalid JSON", async () => {
  const stdout = `DEBUG km:storage:repo createRepo rootPath=/repo\n{"node":{"content":"Implement Yrd"}}\n`
  const source = createKmIssueSource({
    process: {
      async run() {
        return { exitCode: 0, signal: null, stderr: "", stdout, durationMs: 1, timedOut: false }
      },
    },
  })
  const failure = await createIssues({ sources: [source] })
    .resolve({ source: "km", id: "@yrd/core/21012" })
    .then(
      () => undefined,
      (error: unknown) => error,
    )
  expect(failure).toBeInstanceOf(Error)
  const message = (failure as Error).message
  expect(message).toContain("km show --one --context --json @yrd/core/21012")
  expect(message).toContain("DEBUG km:storage:repo createRepo")
})
