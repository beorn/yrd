/**
 * @failure External task commands can reinterpret task ids, accept malformed output, or leak tracker-specific data into Yrd.
 * @level l1
 * @consumer @yrd/task command and km adapters
 */
import { describe, expect, it } from "vitest"
import {
  createCommandTaskSource,
  createKmTaskSource,
  type TaskProcessRequest,
  type TaskProcessResult,
} from "../src/adapters.ts"

function processReturning(
  result: TaskProcessResult,
  requests: TaskProcessRequest[] = [],
): { process: (request: TaskProcessRequest) => Promise<TaskProcessResult>; requests: TaskProcessRequest[] } {
  return {
    requests,
    async process(request) {
      requests.push(request)
      return result
    },
  }
}

describe("command task source", () => {
  it("passes an opaque task id as one argv value and projects canonical JSON", async () => {
    const id = "@yrd/core/21012; $(touch /tmp/yrd-command-injection)"
    const fake = processReturning({
      exitCode: 0,
      stdout: JSON.stringify({
        title: "Finish Yrd",
        description: "Complete the production host.",
        url: "https://example.test/tasks/21012",
        labels: ["P0", "feature"],
        revision: "rev-7",
      }),
      stderr: "",
    })
    const source = createCommandTaskSource({
      id: "local",
      command: ["task-source", "resolve", "--json"],
      cwd: "/repo",
      env: { SAFE_VALUE: "kept", GIT_DIR: "/wrong/repo", YRD_TASK_ID: "wrong" },
      process: fake.process,
    })

    const task = await source.resolve({ source: "local", id })

    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]).toMatchObject({
      kind: "task",
      argv: ["task-source", "resolve", "--json", id],
      cwd: "/repo",
    })
    expect(fake.requests[0]?.env).toMatchObject({ YRD_TASK_SOURCE: "local", YRD_TASK_ID: id })
    expect(fake.requests[0]?.env.SAFE_VALUE).toBe("kept")
    expect(fake.requests[0]?.env.GIT_DIR).toBeUndefined()
    expect(task).toEqual({
      ref: { source: "local", id },
      title: "Finish Yrd",
      description: "Complete the production host.",
      url: "https://example.test/tasks/21012",
      labels: ["P0", "feature"],
      revision: "rev-7",
    })
  })

  it.each([
    ["missing JSON", { exitCode: 0, stdout: "", stderr: "" }, "returned no JSON"],
    ["invalid JSON", { exitCode: 0, stdout: "{not-json", stderr: "" }, "returned invalid JSON"],
    ["missing title", { exitCode: 0, stdout: '{"description":"no title"}', stderr: "" }, "'title'"],
    ["a failed command", { exitCode: 9, stdout: "", stderr: "not found" }, "exited 9: not found"],
  ])("fails closed for %s", async (_case, result, message) => {
    const fake = processReturning(result)
    const source = createCommandTaskSource({ id: "local", command: ["tasks", "get"], process: fake.process })

    await expect(source.resolve({ source: "local", id: "T-1" })).rejects.toThrow(message)
  })
})

describe("km task source", () => {
  it("uses km's one-node context JSON and keeps the path-form id literal", async () => {
    const id = "@yrd/core/21012-monorepo"
    const fake = processReturning({
      exitCode: 0,
      stdout: JSON.stringify({
        node: {
          title: "Finish the Yrd monorepo",
          version: "01JYRDEVENT",
          data: {
            url: "https://example.test/@yrd/core/21012-monorepo",
            labels: ["P0", "yrd"],
          },
        },
        blocks: [
          { label: "Parent", body: ["Parent context must not become the task description."] },
          { label: "Finish the Yrd monorepo", body: ["Build the final host.", "Verify the contest path."] },
        ],
      }),
      stderr: "",
    })
    const source = createKmTaskSource({ command: ["bun", "/repo/bin/km.ts"], cwd: "/repo", process: fake.process })

    const task = await source.resolve({ source: "km", id })

    expect(fake.requests[0]?.argv).toEqual([
      "bun",
      "/repo/bin/km.ts",
      "show",
      "--one",
      "--context",
      "--json",
      id,
    ])
    expect(task).toEqual({
      ref: { source: "km", id },
      title: "Finish the Yrd monorepo",
      description: "Build the final host.\nVerify the contest path.",
      url: "https://example.test/@yrd/core/21012-monorepo",
      labels: ["P0", "yrd"],
      revision: "01JYRDEVENT",
    })
  })

  it.each([
    ["empty output", "", "returned no JSON"],
    ["invalid JSON", "[]", "must be an object"],
    ["missing node", '{"blocks":[]}', "'node'"],
    ["missing title", '{"node":{"data":{}},"blocks":[]}', "'title'"],
  ])("rejects %s", async (_case, stdout, message) => {
    const fake = processReturning({ exitCode: 0, stdout, stderr: "" })
    const source = createKmTaskSource({ process: fake.process })

    await expect(source.resolve({ source: "km", id: "@yrd/missing" })).rejects.toThrow(message)
  })
})
