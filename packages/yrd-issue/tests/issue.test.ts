/**
 * @failure Issue references resolve through the wrong source, leak ambient process policy, or lose tracker identity.
 * @level l1
 * @consumer @yrd/issue
 */
import { expect, it } from "vitest"
import { createMemoryJournal, createYrd, createYrdDef } from "@yrd/core"
import { createCommandIssueSource, createKmIssueSource, createIssues, withIssues } from "../src/index.ts"

it("resolves source-owned ids and composes without mutating its host", async () => {
  let argv: readonly string[] = []
  let environment: NodeJS.ProcessEnv | undefined
  const source = createCommandIssueSource({
    id: "issues",
    command: ["issue", "show", "--json"],
    env: { GIT_DIR: "/poison.git", YRD_JOB: "private", CALLER_TEST_MARKER: "preserved" },
    process: {
      async run(request) {
        argv = request.argv
        environment = request.env
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
  expect(() => createIssues({ sources: [source, source] })).toThrow("duplicate issue source 'issues'")
  await expect(issues.resolve({ source: "missing", id: "1" })).rejects.toThrow("no issue source")
  await app.close()
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
