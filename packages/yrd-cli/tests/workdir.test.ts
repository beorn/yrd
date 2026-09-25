import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parseQueueAddress, queueRoot } from "../src/address.ts"
import { workdirOf } from "../src/workdir.ts"

describe("workdirOf (25716 row 9)", () => {
  it("resolves to the queue root under hostWorkdir for the given address", async () => {
    const git = async () => ""
    const address = parseQueueAddress("beorn/hh#main")
    const env = { XDG_STATE_HOME: "/custom/state" }
    const workdir = await workdirOf(git, { address, env })
    expect(workdir).toBe(queueRoot("/custom/state/yrd", address))
    expect(workdir).toBe(join("/custom/state/yrd", "github.com", "beorn", "hh%23main"))
  })

  it("resolves address via originHead and remoteUrl when address is omitted", async () => {
    const git = async (args: readonly string[]) => {
      if (args[0] === "ls-remote") return "ref: refs/heads/main\tHEAD\n"
      if (args[0] === "remote") return "origin\n"
      if (args[0] === "config" && args[3] === "remote.origin.url") return "https://github.com/beorn/hh.git\0"
      return ""
    }
    const env = { XDG_STATE_HOME: "/custom/state" }
    const workdir = await workdirOf(git, { env })
    const expectedAddress = parseQueueAddress("github.com/beorn/hh#main")
    expect(workdir).toBe(queueRoot("/custom/state/yrd", expectedAddress))
  })
})
