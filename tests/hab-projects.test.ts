/**
 * @failure Hab queue-runner declarations drift into implicit paths or commands whose argv no longer identifies the repository they operate on.
 * @level l2
 * @consumer Hallohuman Hab composition loading vendor/yrd/hab.projects.ts
 */
import { describe, expect, it } from "vitest"
import hab, { defineYrdQueueRunnerDeclarations, yrdQueueRunnerDeclarations } from "../hab.projects.ts"

describe("Yrd Hab runner declarations", () => {
  it("keeps repository and queue identity explicit in data and generated argv", () => {
    expect(yrdQueueRunnerDeclarations).toEqual([
      { serviceName: "yrd-service", repository: { name: "code", path: "." }, queue: { base: "main" }, owner: "@cto" },
    ])
    expect(hab.services).toMatchObject({
      "yrd-service": {
        command: "bun tools/yrd-runtime.mjs yrd queue up --interval 120",
        env: { TRIBE_NAME: "@yrd-service" },
      },
    })
    // No health probe: the loop's process and journal are its liveness (M7).
    expect(hab.services["yrd-service"]).not.toHaveProperty("health")
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
    // With no declared owner the page resolves to the fleet-wide default
    // (@chief). This queue's owner is @cto, and a page that reaches the wrong
    // seat is a page that arrives as news to someone who cannot act on it.
    // Still required under `on-failure`: the page moves from "the runner
    // crashed" to "the runner exhausted its restart budget", and it is the
    // same seat that has to answer it.
    expect(yrdQueueRunnerDeclarations.map(({ serviceName, owner }) => [serviceName, owner])).toEqual([
      ["yrd-service", "@cto"],
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

describe("Yrd Hab runner declarations — the restart policy that makes the exit codes mean something", () => {
  it("supervises the runner, so a designed restart-exit actually relaunches it", () => {
    // `queue up` exits 18 when the pin moves, and the relaunch on the new pin
    // IS the cure. Under `restart: "never"` that exit is inert: the service
    // leaves correctly and nothing brings it back. The incumbent resident's
    // 11 and 13 fired the same way — 13 twice on 2026-09-02, the queue down
    // both times until a person ran `hab up` — and went with it at M6; 18 is
    // what is left, and this value is what makes it do anything.
    for (const service of Object.values(hab.services)) {
      expect(service).toMatchObject({ restart: "on-failure" })
    }
  })

  it("keeps a stuck queue down while a moved pin still relaunches", () => {
    for (const service of Object.values(hab.services)) {
      expect(service.permanentExitCodes).toEqual([2])
      expect(service.permanentExitCodes).not.toContain(18)
    }
  })
})
