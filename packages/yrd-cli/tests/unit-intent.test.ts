import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { readUnitIntent, UNIT_INTENT_FILE_ENV } from "../src/unit-intent.ts"

describe("readUnitIntent (25430, @cto 16ab7d00)", () => {
  it("returns none when HAB_UNIT_INTENT_FILE is unset or empty", () => {
    expect(readUnitIntent("stop", {}, new Date())).toMatchObject({
      kind: "none",
      why: expect.stringContaining("is not set"),
    })
    expect(readUnitIntent("stop", { [UNIT_INTENT_FILE_ENV]: "  " }, new Date())).toMatchObject({
      kind: "none",
      why: expect.stringContaining("is not set"),
    })
  })

  it("returns none when intent file does not exist or has invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "unit-intent-test-"))
    const missing = join(dir, "missing.json")
    expect(readUnitIntent("stop", { [UNIT_INTENT_FILE_ENV]: missing }, new Date())).toMatchObject({
      kind: "none",
      why: expect.stringContaining("no readable intent"),
    })

    const badJson = join(dir, "bad.json")
    writeFileSync(badJson, "not json\n")
    expect(readUnitIntent("stop", { [UNIT_INTENT_FILE_ENV]: badJson }, new Date())).toMatchObject({
      kind: "none",
      why: expect.stringContaining("no readable intent"),
    })
  })

  it("returns none when verb does not match", () => {
    const dir = mkdtempSync(join(tmpdir(), "unit-intent-test-"))
    const file = join(dir, "intent.json")
    writeFileSync(
      file,
      `${JSON.stringify({ verb: "stop", by: "@chief", reason: "maintenance", at: "2026-09-24T07:15:00.000Z" })}\n`,
    )
    expect(readUnitIntent("start", { [UNIT_INTENT_FILE_ENV]: file }, new Date("2026-09-24T07:00:00.000Z"))).toMatchObject({
      kind: "none",
      why: expect.stringContaining("is for \"stop\", not start"),
    })
  })

  it("returns none when by or reason is missing or empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "unit-intent-test-"))
    const file = join(dir, "intent.json")
    writeFileSync(file, `${JSON.stringify({ verb: "stop", reason: "cutover", at: "2026-09-24T07:15:00.000Z" })}\n`)
    expect(readUnitIntent("stop", { [UNIT_INTENT_FILE_ENV]: file }, new Date("2026-09-24T07:00:00.000Z"))).toMatchObject({
      kind: "none",
      why: expect.stringContaining("has no by and reason"),
    })

    writeFileSync(file, `${JSON.stringify({ verb: "stop", by: "@chief", reason: "  ", at: "2026-09-24T07:15:00.000Z" })}\n`)
    expect(readUnitIntent("stop", { [UNIT_INTENT_FILE_ENV]: file }, new Date("2026-09-24T07:00:00.000Z"))).toMatchObject({
      kind: "none",
      why: expect.stringContaining("has no by and reason"),
    })
  })

  it("returns none when at is missing or unparseable (no fallback to now)", () => {
    const dir = mkdtempSync(join(tmpdir(), "unit-intent-test-"))
    const file = join(dir, "intent.json")

    // Missing 'at'
    writeFileSync(file, `${JSON.stringify({ verb: "stop", by: "@chief", reason: "cutover" })}\n`)
    const missingAt = readUnitIntent("stop", { [UNIT_INTENT_FILE_ENV]: file }, new Date("2026-09-24T07:00:00.000Z"))
    expect(missingAt).toMatchObject({
      kind: "none",
      why: expect.stringContaining("has no valid timestamp"),
    })

    // Unparseable 'at'
    writeFileSync(file, `${JSON.stringify({ verb: "stop", by: "@chief", reason: "cutover", at: "not-a-date" })}\n`)
    const unparseableAt = readUnitIntent("stop", { [UNIT_INTENT_FILE_ENV]: file }, new Date("2026-09-24T07:00:00.000Z"))
    expect(unparseableAt).toMatchObject({
      kind: "none",
      why: expect.stringContaining("unparseable timestamp"),
    })
  })

  it("returns none when stop intent was written before process started (stale intent)", () => {
    const dir = mkdtempSync(join(tmpdir(), "unit-intent-test-"))
    const file = join(dir, "intent.json")
    const processStartedAt = new Date("2026-09-24T07:00:00.000Z")
    const staleAt = "2026-09-23T20:00:00.000Z"

    writeFileSync(
      file,
      `${JSON.stringify({ verb: "stop", by: "@chief", reason: "yesterday maintenance", at: staleAt })}\n`,
    )
    const result = readUnitIntent("stop", { [UNIT_INTENT_FILE_ENV]: file }, processStartedAt)
    expect(result).toMatchObject({
      kind: "none",
      why: expect.stringContaining("before this process started"),
    })
  })

  it("returns none when stop intent has no startedAt to verify freshness", () => {
    const dir = mkdtempSync(join(tmpdir(), "unit-intent-test-"))
    const file = join(dir, "intent.json")
    writeFileSync(
      file,
      `${JSON.stringify({ verb: "stop", by: "@chief", reason: "cutover", at: "2026-09-24T07:15:00.000Z" })}\n`,
    )
    const result = readUnitIntent("stop", { [UNIT_INTENT_FILE_ENV]: file })
    expect(result).toMatchObject({
      kind: "none",
      why: expect.stringContaining("cannot be verified without the process start time"),
    })
  })

  it("returns intent fact when stop intent is fresh (at or after startedAt)", () => {
    const dir = mkdtempSync(join(tmpdir(), "unit-intent-test-"))
    const file = join(dir, "intent.json")
    const processStartedAt = "2026-09-24T07:00:00.000Z"
    const freshAt = "2026-09-24T07:15:00.000Z"

    writeFileSync(
      file,
      `${JSON.stringify({ verb: "stop", by: "@chief", reason: "redeploy", at: freshAt })}\n`,
    )
    // Pass ISO string startedAt
    const result = readUnitIntent("stop", { [UNIT_INTENT_FILE_ENV]: file }, processStartedAt)
    expect(result).toEqual({
      kind: "intent",
      fact: {
        by: "@chief",
        reason: "redeploy",
        since: freshAt,
      },
    })

    // Exact equal timestamp (at === startedAt)
    writeFileSync(
      file,
      `${JSON.stringify({ verb: "stop", by: "@operator", reason: "immediate stop", at: processStartedAt })}\n`,
    )
    const exactResult = readUnitIntent("stop", { [UNIT_INTENT_FILE_ENV]: file }, new Date(processStartedAt))
    expect(exactResult).toEqual({
      kind: "intent",
      fact: {
        by: "@operator",
        reason: "immediate stop",
        since: processStartedAt,
      },
    })
  })

  it("returns intent fact for valid start intent", () => {
    const dir = mkdtempSync(join(tmpdir(), "unit-intent-test-"))
    const file = join(dir, "intent.json")
    const at = "2026-09-24T07:00:00.000Z"
    writeFileSync(
      file,
      `${JSON.stringify({ verb: "start", by: "@chief", reason: "morning launch", at })}\n`,
    )
    const result = readUnitIntent("start", { [UNIT_INTENT_FILE_ENV]: file }, at)
    expect(result).toEqual({
      kind: "intent",
      fact: {
        by: "@chief",
        reason: "morning launch",
        since: at,
      },
    })
  })
})
