/**
 * @failure An issue source fails and the operator is told only THAT it failed — not what was run, what came back, or what was expected — so diagnosis costs a repro run Yrd already made.
 * @level l1
 * @consumer @yrd/issue
 */
import { expect, it } from "vitest"
import { createLogger, type Event } from "loggily"
import type { ProcessResult } from "@yrd/process"
import { createIssues, createKmIssueSource } from "../src/index.ts"

const ISSUE = "@yrd/core/22477"
const EXPECTED_COMMAND = `km show --one --context --json ${ISSUE}`

function answer(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 7,
    timedOut: false,
    ...overrides,
  } as ProcessResult
}

/** Resolve one km issue against a source whose subprocess returns `result`,
 * and hand back whatever the resolution threw plus every log event it emitted. */
async function resolveWith(
  result: ProcessResult,
): Promise<Readonly<{ message: string; events: readonly Extract<Event, { kind: "log" }>[] }>> {
  const events: Event[] = []
  const log = createLogger("yrd", [{ level: "trace", spans: false }, { write: (event: Event) => events.push(event) }])
  const source = createKmIssueSource({ cwd: "/repo", log, process: { async run() { return result } } })
  const failure = await createIssues({ sources: [source], log })
    .resolve({ source: "km", id: ISSUE })
    .then(
      () => undefined,
      (error: unknown) => error,
    )
  log.end()
  expect(failure, "the source was supposed to refuse").toBeInstanceOf(Error)
  return {
    message: (failure as Error).message,
    events: events.filter((event): event is Extract<Event, { kind: "log" }> => event.kind === "log"),
  }
}

it.each([
  [
    "a non-zero exit",
    answer({ exitCode: 3, stderr: "km: no node matches that path\n" }),
    ["exited 3", 'stderr: "km: no node matches that path\\n"', "stdout: (empty)"],
  ],
  [
    "a timeout",
    answer({ timedOut: true, exitCode: 0, stdout: "half a resp" }),
    ["timed out after 30000ms", 'stdout: "half a resp"'],
  ],
  [
    "a debug line written onto the JSON channel",
    answer({ stdout: `DEBUG km:storage:repo createRepo rootPath=/repo\n{"node":{"content":"Ship"}}\n` }),
    ["invalid JSON", "DEBUG km:storage:repo createRepo"],
  ],
  [
    "well-formed JSON that is not an issue",
    answer({ stdout: '{"node":{"version":4}}' }),
    ["is not an issue", "title", '"{\\"node\\":{\\"version\\":4}}"'],
  ],
])("names the command and the evidence when a source fails with %s", async (_shape, result, expected) => {
  const { message } = await resolveWith(result)
  // The argv is the operator's repro line; without it a failure report is a
  // verdict with no way to check it.
  expect(message).toContain(EXPECTED_COMMAND)
  for (const fragment of expected) expect(message).toContain(fragment)
})

it("bounds the quoted output so a chatty source cannot flood the refusal", async () => {
  const { message } = await resolveWith(answer({ stdout: "x".repeat(5_000) }))
  expect(message).toContain(EXPECTED_COMMAND)
  expect(message).toContain("…")
  // 200 characters of evidence, not 5000: enough to identify the cause, bounded
  // enough to stay readable in a terminal refusal.
  expect(message).not.toContain("x".repeat(201))
  expect(message).toContain("x".repeat(200))
})

it("records argv, cwd, exit code and duration for the subprocess it ran", async () => {
  const { events } = await resolveWith(answer({ exitCode: 3, stderr: "boom" }))
  const answered = events.find((event) => event.namespace === "yrd:issues:source")
  expect(answered, "the issue source owes a DEBUG row naming what it ran").toBeDefined()
  expect(answered?.level).toBe("debug")
  expect(answered?.props).toMatchObject({
    source: "km",
    issue: ISSUE,
    argv: ["km", "show", "--one", "--context", "--json", ISSUE],
    cwd: "/repo",
    exitCode: 3,
    durationMs: 7,
  })
})

it("reports issue resolution as one INFO milestone with the issue it resolved", async () => {
  const events: Event[] = []
  const log = createLogger("yrd", [{ level: "trace", spans: false }, { write: (event: Event) => events.push(event) }])
  const source = createKmIssueSource({
    log,
    process: {
      async run() {
        return answer({ stdout: '{"node":{"content":"Lifecycle observability","version":"9"}}' })
      },
    },
  })
  await createIssues({ sources: [source], log }).resolve({ source: "km", id: ISSUE })
  log.end()

  // Issue resolution is the FIRST phase of `yrd do`. An operator running `-v`
  // must see it start and finish without opting into DEBUG, because a run that
  // dies here dies before anything else has a chance to say a word.
  const lifecycle = events.filter(
    (event): event is Extract<Event, { kind: "log" }> => event.kind === "log" && event.namespace === "yrd:issues:resolve",
  )
  expect(lifecycle.map((event) => [event.level, event.props?.outcome])).toEqual([
    ["info", "started"],
    ["info", "succeeded"],
  ])
  expect(lifecycle.at(-1)?.props).toMatchObject({ issue: `km:${ISSUE}`, title: "Lifecycle observability" })
})
