/**
 * @failure Hab queue-runner declarations drift into implicit paths or commands whose argv no longer identifies the repository they operate on.
 * @level l2
 * @consumer Hallohuman Hab composition loading vendor/yrd/hab.module.ts
 */
import { describe, expect, it } from "vitest"
import hab, {
  YRD_REPOSITORY_ALIASES,
  defineYrdQueueRunnerDeclarations,
  yrdQueueRunnerDeclarations,
} from "../hab.module.ts"
import { YRD_REPOSITORY_ALIASES_ENV, takeYrdComposition } from "../packages/yrd-cli/src/repository-composition.ts"

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

  it("hands every runner the same declarations the CLI resolves aliases from", () => {
    for (const service of Object.values(hab.services)) {
      expect(service.env).toMatchObject({ YRD_REPOSITORY_ALIASES })
    }
    // Round-tripped through the reader, so a registry the CLI would refuse
    // fails here rather than at a runner's first `queue run <repository>`.
    expect(takeYrdComposition({ [YRD_REPOSITORY_ALIASES_ENV]: YRD_REPOSITORY_ALIASES })).toEqual({
      aliases: yrdQueueRunnerDeclarations.map(({ repository, queue }) => ({
        repository: { name: repository.name, path: repository.path },
        queue: { base: queue.base },
      })),
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
