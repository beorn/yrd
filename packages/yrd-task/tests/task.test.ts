import { expect, it } from "vitest"
import { createMemoryJournal, createYrd, createYrdDef } from "@yrd/core"
import { createCommandTaskSource, createKmTaskSource, createTasks, withTasks } from "../src/index.ts"

it("resolves source-owned ids and composes without mutating its host", async () => {
  let argv: readonly string[] = []
  let environment: NodeJS.ProcessEnv | undefined
  const source = createCommandTaskSource({
    id: "issues",
    command: ["issue", "show", "--json"],
    env: { GIT_DIR: "/poison.git", YRD_JOB: "private", TASK_TEST_MARKER: "preserved" },
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
  const tasks = createTasks({ sources: [source], defaultSource: "issues" })
  const base = createYrdDef()
  const definition = withTasks({ sources: [source] })(base)
  const app = await createYrd(definition, { inject: { journal: createMemoryJournal() } })
  expect(app.tasks.sources).toEqual(["issues"])
  expect(base.create).not.toBe(definition.create)
  await expect(tasks.resolve(tasks.ref("issues:release:2.0"))).resolves.toEqual({
    ref: { source: "issues", id: "release:2.0" },
    title: "Fix release",
    labels: ["bug"],
  })
  expect(argv).toEqual(["issue", "show", "--json", "release:2.0"])
  expect(environment).toMatchObject({
    TASK_TEST_MARKER: "preserved",
    YRD_TASK_SOURCE: "issues",
    YRD_TASK_ID: "release:2.0",
  })
  expect(environment).not.toHaveProperty("GIT_DIR")
  expect(environment).not.toHaveProperty("YRD_JOB")
  expect(() => createTasks({ sources: [source, source] })).toThrow("duplicate task source 'issues'")
  await expect(tasks.resolve({ source: "missing", id: "1" })).rejects.toThrow("no task source")
  await app.close()
})

it("projects km context while keeping a path-form id as one argument", async () => {
  let argv: readonly string[] = []
  const source = createKmTaskSource({
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
  const task = await createTasks({ sources: [source] }).resolve({ source: "km", id: "@yrd/core/21012" })
  expect(argv.at(-1)).toBe("@yrd/core/21012")
  expect(task).toMatchObject({ title: "Implement Yrd", description: "Ship it", revision: "v2" })
})
