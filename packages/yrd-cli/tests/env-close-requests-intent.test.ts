/**
 * @failure 29772 (@cto c8d7113d ruling 2): a release request and a close request share one store, so a file
 *   whose key and intent disagree must be refused loud as malformed, a close file written before intents
 *   existed must still read as a close, and the two intents for one path must never take each other's slot.
 * @level   l1 (real request files in a temp workdir)
 * @consumer the queue round's request consumer, which dispatches on the intent this reader returns
 * @reach   fs-walk <fixture-only: the request store this test makes under the OS temp root>
 * @testonly none
 */
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import {
  closeRequestFile,
  closeRequestsDirectory,
  readCloseRequest,
  releaseRequestFile,
  writeCloseRequest,
  writeReleaseRequest,
  type EnvReleaseRequest,
} from "../src/env-close-requests.ts"

const path = "/hh/var/wt/29772-fixture"
const uid = 3001

function release(tip: string): EnvReleaseRequest {
  return {
    intent: "release-checkout",
    name: "29772-fixture",
    path,
    requester: "@dev/luna5",
    uid,
    at: "2026-10-28T18:00:00.000Z",
    predicate: "direct-admission",
    release: {
      branch: "task/29772-fixture",
      tip,
      issue: "29772",
      reason: "retain checkout",
      by: "@dev/luna5",
      submodules: false,
    },
  }
}

function store(): string {
  const workdir = mkdtempSync(join(tmpdir(), "yrd-29772-intent-"))
  mkdirSync(closeRequestsDirectory(workdir), { recursive: true })
  return workdir
}

it("keys a release apart from a close for the same path, and re-filing the same release matches it", () => {
  const workdir = store()
  const closed = writeCloseRequest(workdir, {
    intent: "close",
    name: "29772-fixture",
    path,
    requester: "@dev/luna5",
    uid,
    at: "2026-10-28T18:00:00.000Z",
    predicate: "direct-admission",
    options: {},
    head: "a".repeat(40),
  })
  const first = writeReleaseRequest(workdir, release("b".repeat(40)))
  const again = writeReleaseRequest(workdir, release("b".repeat(40)))
  expect(first.file).toBe(releaseRequestFile(workdir, path, "task/29772-fixture"))
  expect(first.file).not.toBe(closed.file)
  expect(again).toEqual({ file: first.file, alreadyStood: true })
  expect(readdirSync(closeRequestsDirectory(workdir)).sort()).toHaveLength(2)
  expect(readCloseRequest(closed.file)?.intent).toBe("close")
  expect(readCloseRequest(first.file)?.intent).toBe("release-checkout")
  expect(() => writeReleaseRequest(workdir, release("c".repeat(40)))).toThrow(/already stands/u)
})

it("reads a close file written before intents existed as a legacy close", () => {
  const workdir = store()
  const file = closeRequestFile(workdir, path)
  const { intent: _intent, ...legacy } = {
    intent: "close",
    name: "29772-fixture",
    path,
    requester: "@dev/luna2",
    uid,
    at: "2026-10-20T18:00:00.000Z",
    predicate: "direct-admission",
    options: { noRehome: true },
    head: "a".repeat(40),
  }
  writeFileSync(file, `${JSON.stringify(legacy)}\n`)
  expect(readCloseRequest(file)).toMatchObject({ intent: "close", path, options: { noRehome: true } })
})

it("refuses loud a file whose key and intent disagree", () => {
  const workdir = store()
  const releaseFile = releaseRequestFile(workdir, path, "task/29772-fixture")
  const { intent: _intent, ...unnamed } = release("b".repeat(40))
  writeFileSync(releaseFile, `${JSON.stringify(unnamed)}\n`)
  expect(() => readCloseRequest(releaseFile)).toThrow(
    /malformed: a release-keyed file must carry intent "release-checkout"/u,
  )
  const closeFile = closeRequestFile(workdir, path)
  writeFileSync(closeFile, `${JSON.stringify(release("b".repeat(40)))}\n`)
  expect(() => readCloseRequest(closeFile)).toThrow(/malformed: a close-keyed file carries intent "close" or none/u)
})
