/**
 * @failure 33170 @cto 1a7a3153 condition 1: the issue read that may release an off-target environment must fail
 *   closed. Only a provider answer of exactly `closed` or `dropped` releases; a provider error, an unknown id, a
 *   thrown reader, a missing status or any other status keeps the environment with the reason named.
 * @level   l1 (the issues interface is a module mock; the subject is the mapping)
 * @consumer the queue round's environment cleanup (env-cleanup.ts closed-issue route)
 * @reach   none
 * @testonly none
 */
import { beforeEach, expect, it, vi } from "vitest"
import { readEnvIssueState } from "../src/env-issue-state.ts"
import { runIssuesVerb } from "../src/issues/run.ts"

vi.mock("../src/issues/run.ts", () => ({ runIssuesVerb: vi.fn() }))

const ISSUE = "@i/10-yrd/33170-closing-an-issue-removes-its"
const read = () => readEnvIssueState({ issue: ISSUE, projectRoot: "/repo", cwd: "/repo", timeoutMs: 5_000 })
const answer = (result: unknown) =>
  vi.mocked(runIssuesVerb).mockResolvedValue({ ok: true, envelope: { result } } as never)

beforeEach(() => vi.mocked(runIssuesVerb).mockReset())

it("reads through the issues interface's view, inside the given time budget", async () => {
  answer({ status: "closed" })
  await read()
  expect(vi.mocked(runIssuesVerb)).toHaveBeenCalledWith(
    expect.objectContaining({ verb: "view", args: [ISSUE], projectRoot: "/repo", timeoutMs: 5_000 }),
  )
})

it.each(["closed", "dropped"] as const)("%s releases", async (status) => {
  answer({ status })
  expect(await read()).toEqual({ kind: status, issue: ISSUE })
})

it.each(["open", "wip", "blocked", "draft"])("%s keeps, naming the status", async (status) => {
  answer({ status })
  expect(await read()).toEqual({ kind: "keep", reason: `issue "${ISSUE}" is ${status}, not closed or dropped` })
})

it("an answer without a status keeps", async () => {
  answer({ title: "no status" })
  expect(await read()).toEqual({
    kind: "keep",
    reason: `issue "${ISSUE}" has no status in its provider answer`,
    unreadable: true,
  })
})

it("a provider failure (an unknown id) keeps with the provider's message", async () => {
  vi.mocked(runIssuesVerb).mockResolvedValue({ ok: false, message: "no issue matches the key" } as never)
  expect(await read()).toEqual({
    kind: "keep",
    reason: `issue "${ISSUE}" state unreadable: no issue matches the key`,
    unreadable: true,
  })
})

it("a reader that throws keeps with its error", async () => {
  // The throw starts inside the reader's own read of the answer: in this harness a mock implementation that throws
  // fails its test even when the error is caught (probed 2026-11-10), so the mock never throws itself.
  vi.mocked(runIssuesVerb).mockResolvedValue({
    get ok(): boolean {
      throw new Error("spawn km ENOENT")
    },
  } as never)
  expect(await read()).toEqual({
    kind: "keep",
    reason: `issue "${ISSUE}" state unreadable: spawn km ENOENT`,
    unreadable: true,
  })
})
