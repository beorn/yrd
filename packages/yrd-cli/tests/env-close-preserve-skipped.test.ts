/**
 * @failure 29406: `yrd env close --preserve` read only the schema fields of bearly's preserve
 *          receipt and dropped its `skipped: [{path, head, reason}]` list (bearly 530b6b79db3b,
 *          29392), so a storeless child that was consulted and skipped was never named to the
 *          operator — the 29392 close recorded that naming as NOT MEASURED through yrd's output.
 * @level   l1 (the receipt parser over literal JSON; no git, no subprocess)
 * @consumer every seat closing an environment whose submodule shared main has no primary store for
 * @testonly none
 */

import { describe, expect, it } from "vitest"
import { parseWorktreePreserveReceipt, WORKTREE_PRESERVE_SCHEMA } from "../src/env-commands.ts"

const CLI = "/stub/tools/worktree.ts"
const SKIPPED = {
  path: "vendor/brain8",
  head: "0123456789abcdef0123456789abcdef01234567",
  reason: "clean on its recorded pin; shared main has no primary store for it",
}

/** A bearly receipt as tools/worktree.ts prints it since 29392: `skipped` is always present. */
const receipt = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema: WORKTREE_PRESERVE_SCHEMA,
    slot: "wt-@dev8",
    path: "/hh/var/wt/wt-@dev8",
    preserved: true,
    reason: "dirty",
    ref: "wip/wt-@dev8-preserve-20261015",
    sha: "89abcdef0123456789abcdef0123456789abcdef",
    submodules: [],
    skipped: [SKIPPED],
    ...overrides,
  })

describe("parseWorktreePreserveReceipt carries bearly's skipped list (29406)", () => {
  it("maps each skipped repository by path, head and reason", () => {
    const parsed = parseWorktreePreserveReceipt(receipt(), CLI)
    expect(parsed.skipped).toEqual([SKIPPED])
  })

  it("reads a receipt without the key as nothing skipped: bearly before 29392 preserved or threw, it never skipped", () => {
    // JSON.stringify drops an undefined value, so the key is absent from the wire receipt.
    const parsed = parseWorktreePreserveReceipt(receipt({ skipped: undefined }), CLI)
    expect(parsed.skipped).toEqual([])
  })

  it.each([
    ["skipped", { skipped: "vendor/brain8" }, "skipped (expected an array)"],
    ["skipped[0]", { skipped: ["vendor/brain8"] }, "skipped[0] (expected an object)"],
    ["skipped[0].path", { skipped: [{ ...SKIPPED, path: 7 }] }, "skipped[0].path (expected a string)"],
    ["skipped[0].head", { skipped: [{ ...SKIPPED, head: null }] }, "skipped[0].head (expected a string)"],
    [
      "skipped[0].reason",
      { skipped: [{ path: SKIPPED.path, head: SKIPPED.head }] },
      "skipped[0].reason (expected a string)",
    ],
  ])("refuses a malformed %s by name, naming the CLI", (_field, overrides, expected) => {
    expect(() => parseWorktreePreserveReceipt(receipt(overrides), CLI)).toThrow(`invalid ${expected}`)
    expect(() => parseWorktreePreserveReceipt(receipt(overrides), CLI)).toThrow(CLI)
  })
})
