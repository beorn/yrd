/**
 * @failure A library logger created while the yrd host owns output still opened
 *          the ambient LOG_FILE, so an unusable path aborted construction with
 *          ENOENT before any process operation started (loggily 28430).
 * @level   l1
 * @consumer createYrdLogger (the yrd host) plus yrd-process's fallback logger
 * @testonly none
 */

import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createYrdLogger } from "../src/observability.ts"

describe("yrd logging boundary — a host owns output", () => {
  it("never opens an unusable LOG_FILE for a fallback library logger", () => {
    const previous = process.env.LOG_FILE
    const missing = join(
      tmpdir(),
      `yrd-logging-boundary-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      "absent-parent",
      "log.jsonl",
    )
    process.env.LOG_FILE = missing
    const stderr: string[] = []
    try {
      // The host first (createYrdLogger installs setDefaultOutput), then the
      // fallback library logger yrd-process builds with no config array.
      const host = createYrdLogger({ level: "debug", spans: true, spanRows: true, explicitLevel: true }, (text) => {
        stderr.push(text)
        return text.length
      })
      const fallback = createLogger("yrd:process")
      fallback.info?.("process fallback reached the host")

      expect(stderr.join("\n")).toContain("process fallback reached the host")
      expect(existsSync(missing)).toBe(false)
      expect(existsSync(dirname(missing))).toBe(false)
      host[Symbol.dispose]()
    } finally {
      if (previous === undefined) delete process.env.LOG_FILE
      else process.env.LOG_FILE = previous
    }
  })
})
