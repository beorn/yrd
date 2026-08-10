/**
 * @failure Hab queue-runner declarations drift into implicit paths or commands whose argv no longer identifies the repository they operate on.
 * @level l2
 * @consumer Hallohuman Hab composition loading vendor/yrd/hab.module.ts
 */
import { describe, expect, it } from "vitest"
import hab, { defineYrdQueueRunnerDeclarations, yrdQueueRunnerDeclarations } from "../hab.module.ts"

describe("Yrd Hab runner declarations", () => {
  it("keeps repository and queue identity explicit in data and generated argv", () => {
    expect(yrdQueueRunnerDeclarations).toEqual([
      { serviceName: "yrd-runner", repository: { name: "code", path: "." }, queue: { base: "main" } },
      { serviceName: "yrd-runner-pm", repository: { name: "pm", path: "pm" }, queue: { base: "main" } },
    ])
    expect(hab.services).toMatchObject({
      "yrd-runner": {
        command: "tools/installed/yrd queue run code",
        health: { command: "tools/installed/yrd queue code --check --json" },
      },
      "yrd-runner-pm": {
        command: "tools/installed/yrd queue run pm",
        health: { command: "tools/installed/yrd queue pm --check --json" },
      },
    })
  })

  it("refuses duplicate and incomplete runner declarations before Hab consumes them", () => {
    expect(() =>
      defineYrdQueueRunnerDeclarations([
        { serviceName: "yrd-code", repository: { name: "code", path: "." }, queue: { base: "main" } },
        { serviceName: "yrd-code-2", repository: { name: "code", path: "pm" }, queue: { base: "main" } },
      ]),
    ).toThrow("duplicate repository name 'code'")
    expect(() =>
      defineYrdQueueRunnerDeclarations([
        { serviceName: "yrd-code", repository: { name: "code", path: "" }, queue: { base: "main" } },
      ]),
    ).toThrow("repository path requires text")
  })
})
