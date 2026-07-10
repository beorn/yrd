import { describe, expect, it } from "vitest"
import { createCommandTaskSource, createKmTaskSource, withTasks } from "../src/index.ts"

describe("tasks", () => {
  it("resolves opaque ids through a named source without durable duplicate state", async () => {
    const calls: string[][] = []
    const source = createCommandTaskSource({
      id: "issues",
      command: ["issue", "show", "--json"],
      process: async (request) => {
        calls.push([...request.argv])
        return { exitCode: 0, stdout: JSON.stringify({ title: "Fix release", labels: ["bug"] }), stderr: "" }
      },
    })
    const app = withTasks({ sources: [source], defaultSource: "issues" })({})
    const task = await app.tasks.resolve(app.tasks.ref("issues:release:2.0"))
    expect(task).toEqual({ ref: { source: "issues", id: "release:2.0" }, title: "Fix release", labels: ["bug"] })
    expect(calls).toEqual([["issue", "show", "--json", "release:2.0"]])
  })

  it("projects km context and keeps the path-form id as one argv value", async () => {
    let argv: readonly string[] = []
    const source = createKmTaskSource({
      process: async (request) => {
        argv = request.argv
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            node: { content: "Implement Yrd", version: "v2", data: { url: "https://tasks/21012" } },
            blocks: [{ body: ["Acceptance", "Ship it"] }],
          }),
        }
      },
    })
    const task = await withTasks({ sources: [source] })({}).tasks.resolve({ source: "km", id: "@yrd/core/21012" })
    expect(argv).toEqual(["km", "show", "--one", "--context", "--json", "@yrd/core/21012"])
    expect(task).toMatchObject({ title: "Implement Yrd", description: "Acceptance\nShip it", revision: "v2" })
  })

  it("rejects missing sources and mismatched source output", async () => {
    const app = withTasks({
      sources: [{ id: "bad", resolve: () => ({ ref: { source: "bad", id: "other" }, title: "Wrong" }) }],
    })({})
    await expect(app.tasks.resolve({ source: "missing", id: "1" })).rejects.toThrow("no task source")
    await expect(app.tasks.resolve({ source: "bad", id: "1" })).rejects.toThrow("wrong task")
  })
})
