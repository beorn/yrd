/**
 * @failure Hab queue-runner declarations drift into implicit paths or commands whose argv no longer identifies the repository they operate on.
 * @level l2
 * @consumer Hallohuman Hab composition loading vendor/yrd/hab.projects.ts
 */
import { describe, expect, it } from "vitest"
import hab, {
  defineYrdQueueRunnerDeclarations,
  yrdQueueRunnerDeclarations,
} from "../hab.projects.ts"

describe("Yrd Hab runner declarations", () => {
  it("keeps repository and queue identity explicit in data and generated argv", () => {
    expect(yrdQueueRunnerDeclarations).toEqual([
      { serviceName: "yrd-runner", repository: { name: "code", path: "." }, queue: { base: "main" }, owner: "@cto" },
    ])
    expect(hab.services).toMatchObject({
      "yrd-runner": {
        command: "bun tools/yrd-runtime.mjs yrd queue up",
        health: { command: "bun tools/yrd-runtime.mjs yrd queue list --json" },
      },
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
    // With no declared owner the page resolves to the fleet-wide default
    // (@chief). This queue's owner is @cto, and a page that reaches the wrong
    // seat is a page that arrives as news to someone who cannot act on it.
    // Still required under `on-failure`: the page moves from "the runner
    // crashed" to "the runner exhausted its restart budget", and it is the
    // same seat that has to answer it.
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

describe("Yrd Hab runner declarations — the restart policy that makes the exit codes mean something", () => {
  it("supervises the runner, so a designed restart-exit actually relaunches it", () => {
    // The exit taxonomy in packages/yrd-cli/src/habitant-exit.ts dispositions
    // `source-stale` (11), `installed-plan-stale` (13) and `root-pin-moved`
    // (18) `restart-immediately`. Under `restart: "never"` every one of them
    // was inert: the runner left correctly and nothing brought it back. 13
    // fired twice on 2026-09-02 and the queue stayed down both times until a
    // person ran `hab up`.
    for (const service of Object.values(hab.services)) {
      expect(service).toMatchObject({ restart: "on-failure" })
    }
  })

  it("declares NO key hab-config does not accept — an unknown one takes the whole composition down", () => {
    // This is the guard on a specific near-miss, not a style rule. The obvious
    // way to keep the two `stand-down` codes (16, 17) down while 11/13/18
    // restart is `permanentExitCodes`, and it reads as declarable because
    // hab-core's restart taxonomy implements exactly that policy. It is not:
    // the key is absent from `SERVICE_KEYS` in ag/packages/hab-config
    // (src/index.ts), `validateServiceKeys` pushes `unknown key '<key>'` onto
    // `diagnostics.errors`, and `checkHabConfig` then returns NO habplan —
    // so the mistake does not disable this service, it disables every service
    // Hab supervises. Adding the key to hab-config is the prerequisite, and
    // it is a change in ag.
    const allowed = new Set(["command", "env", "health", "restart", "owner"])
    for (const service of Object.values(hab.services)) {
      expect(Object.keys(service).filter((key) => !allowed.has(key))).toEqual([])
    }
  })
})
