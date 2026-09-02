/**
 * @failure Hab queue-runner declarations drift into implicit paths or commands whose argv no longer identifies the repository they operate on.
 * @level l2
 * @consumer Hallohuman Hab composition loading vendor/yrd/hab.projects.ts
 */
import { describe, expect, it } from "vitest"
import hab, {
  YRD_REPOSITORY_ALIASES,
  defineYrdQueueRunnerDeclarations,
  yrdQueueRunnerDeclarations,
} from "../hab.projects.ts"
import { YRD_REPOSITORY_ALIASES_ENV, takeYrdComposition } from "../packages/yrd-cli/src/repository-composition.ts"

describe("Yrd Hab runner declarations", () => {
  it("keeps repository and queue identity explicit in data and generated argv", () => {
    expect(yrdQueueRunnerDeclarations).toEqual([
      { serviceName: "yrd-runner", repository: { name: "code", path: "." }, queue: { base: "main" }, owner: "@cto" },
    ])
    expect(hab.services).toMatchObject({
      "yrd-runner": {
        command: "bun tools/yrd-runtime.mjs yrd queue run code",
        health: { command: "bun tools/yrd-runtime.mjs yrd queue code --check --json" },
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
        { serviceName: "yrd-code", repository: { name: "code", path: "." }, queue: { base: "main" }, owner: "@cto" },
        {
          serviceName: "yrd-code-2",
          repository: { name: "code", path: "elsewhere" },
          queue: { base: "main" },
          owner: "@cto",
        },
      ]),
    ).toThrow("duplicate repository name 'code'")
    expect(() =>
      defineYrdQueueRunnerDeclarations([
        { serviceName: "yrd-code", repository: { name: "code", path: "" }, queue: { base: "main" }, owner: "@cto" },
      ]),
    ).toThrow("repository path requires text")
    expect(() =>
      defineYrdQueueRunnerDeclarations([
        { serviceName: "yrd-code", repository: { name: "code", path: "." }, queue: { base: "main" }, owner: "  " },
      ]),
    ).toThrow("owner requires text")
  })
})

describe("Yrd Hab runner declarations — who is paged when a runner stays down", () => {
  it("names @cto, not the runtime-health default", () => {
    // `restart: "never"` is the andon policy: a crashed runner stays exited and
    // pages ONCE. With no declared owner that page resolves to the fleet-wide
    // default (@chief). This queue's owner is @cto, and a page that reaches the
    // wrong seat is a page that arrives as news to someone who cannot act on it.
    expect(yrdQueueRunnerDeclarations.map(({ serviceName, owner }) => [serviceName, owner])).toEqual([
      ["yrd-runner", "@cto"],
    ])
  })

  it("spreads the owner into the Hab service entry so the andon page routes to it", () => {
    // `HabServiceDefinition.owner` exists in ag/packages/hab-config
    // (src/index.ts, "Tribe seat/mailbox paged when this service's restart
    // budget exhausts") and `SERVICE_KEYS` in that same file now lists
    // "owner" among the allowed keys, with a missing owner on a
    // `restart: "never"` resident demoted to a WARNING rather than a FATAL
    // config error. So the service entry carries the registry row's owner
    // directly, and a crashed runner's page reaches @cto instead of falling
    // back to the fleet-wide @chief default.
    for (const service of Object.values(hab.services)) {
      expect(service).toMatchObject({ owner: "@cto" })
    }
  })
})
