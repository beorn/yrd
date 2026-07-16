/**
 * @failure The explicit orphan-import CLI can target the wrong file, report a refused collision as success, or omit the audit result.
 * @level l1
 * @consumer @yrd/cli
 */
import { runYrd, type YrdCliApp, type YrdCliIO, type YrdCliServices } from "@yrd/cli"
import { describe, expect, it } from "vitest"

function argv(...args: string[]): string[] {
  return ["/usr/bin/bun", "/repo/bin/yrd.ts", ...args]
}

function output() {
  let stdout = ""
  let stderr = ""
  const io: YrdCliIO = {
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
    cwd: "/repo",
    columns: 100,
  }
  return { io, stdout: () => stdout, stderr: () => stderr }
}

const app = {} as YrdCliApp

describe("yrd journal import-orphan", () => {
  it("resolves the source from the command cwd and prints the immutable import result", async () => {
    const selected: string[] = []
    const services: YrdCliServices = {
      journal: {
        async importOrphan(sourcePath) {
          selected.push(sourcePath)
          return {
            status: "imported",
            cursor: 321,
            records: 11,
            sourceSha256: "a".repeat(64),
          }
        },
      },
    }
    const result = output()

    expect(await runYrd(app, argv("journal", "import-orphan", "preserved.jsonl", "--json"), result.io, services)).toBe(
      0,
    )
    expect(selected).toEqual(["/repo/preserved.jsonl"])
    expect(JSON.parse(result.stdout())).toEqual({
      command: "journal.import-orphan",
      cursor: 321,
      records: 11,
      source: "/repo/preserved.jsonl",
      sourceSha256: "a".repeat(64),
      status: "imported",
    })
    expect(result.stderr()).toBe("")
  })

  it("returns refusal for a live identity collision", async () => {
    const services: YrdCliServices = {
      journal: {
        importOrphan: () =>
          Promise.resolve({
            status: "live-collision",
            cursor: 123,
            records: 1,
            sourceSha256: "b".repeat(64),
            collisions: [{ kind: "command", id: "01800000-0000-7000-8000-000000000001" }],
          }),
      },
    }
    const result = output()

    expect(await runYrd(app, argv("journal", "import-orphan", "/tmp/orphan.jsonl"), result.io, services)).toBe(1)
    expect(result.stdout()).toBe("")
    expect(result.stderr()).toContain("live journal identity collision")
    expect(result.stderr()).toContain("command:01800000-0000-7000-8000-000000000001")
  })

  it("fails as configuration when the host did not install the import capability", async () => {
    const result = output()

    expect(await runYrd(app, argv("journal", "import-orphan", "orphan.jsonl"), result.io)).toBe(2)
    expect(result.stdout()).toBe("")
    expect(result.stderr()).toContain("journal.import-orphan capability is not installed")
  })
})
