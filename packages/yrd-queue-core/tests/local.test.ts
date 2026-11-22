/**
 * @failure A machine-local value is read as an ordinary value: absent-because-there-is-nothing
 *           and absent-because-I-cannot-see-it render identically, and a defect reads as an empty answer.
 * @level    l1 — the real union, constructors and source reading, with a compile-time witness that a
 *           `Local<T>` is not a `T`.
 * @consumer Yrd locality marking (#28522, #24340; @cto disposition 6e5624aa, 2026-10-10)
 * @testonly none
 *
 * ROW 1  The compiler refuses to treat a `Local<T>` as a `T`: a direct read fails to typecheck until the
 *        reader narrows on `local`, which is the whole reason the marker exists.
 * ROW 2  A readable source with no rows, a readable source with rows, an absent source, an unreadable
 *        source and a partly-defective source are five different answers.
 * ROW 3  An available `undefined` is an answer from this machine, not a `{local:false}`: the source was
 *        read and had nothing to say.
 * ROW 4  A defect is never rendered as a value: unreadable and malformed-partial both come back as
 *        `local:false` carrying the sentence, while readable-empty comes back as `local:true` with the
 *        empty collection.
 */

import { describe, expect, expectTypeOf, it } from "vitest"
import {
  isLocal,
  localAbsent,
  localCollectionAnswer,
  localSourceState,
  localValue,
  type Local,
  type LocalSource,
} from "../src/index.ts"

const empty = (value: readonly string[]): boolean => value.length === 0

describe("Local<T>", () => {
  it("is not its own value: a direct read fails to typecheck until the reader narrows", () => {
    const answer: Local<string> = localValue("this machine")

    // @ts-expect-error a Local<string> is not a string; the reader must narrow on `local` first
    const direct: string = answer

    expectTypeOf<Local<string>>().not.toMatchTypeOf<string>()
    expect(direct).toEqual(answer)
    expect(isLocal(answer)).toBe(true)
    if (isLocal(answer)) expect(answer.value).toBe("this machine")
    expect(answer.local).toBe(true)
  })

  it("keeps an available undefined an answer, not an absence", () => {
    const answer = localValue<string | undefined>(undefined)

    expect(answer).toEqual({ local: true, value: undefined })
    expect(isLocal(answer)).toBe(true)
    expect(answer).not.toEqual(localAbsent("the journal could not be opened"))
  })
})

describe("LocalSource", () => {
  const absent: LocalSource<readonly string[]> = { kind: "absent" }
  const unreadable: LocalSource<readonly string[]> = { kind: "unreadable", why: "journal at /q/log refused" }
  const defective: LocalSource<readonly string[]> = {
    kind: "malformed-partial",
    value: ["run-a"],
    why: "run row 2 is not JSON; row 1 kept",
  }
  const emptyRead: LocalSource<readonly string[]> = { kind: "readable", value: [] }
  const present: LocalSource<readonly string[]> = { kind: "readable", value: ["run-a", "run-b"] }

  it("yields five distinguishable answers for the five source states", () => {
    const states = [absent, unreadable, defective, emptyRead, present].map((source) => localSourceState(source, empty))

    expect(states).toEqual(["absent", "unreadable", "malformed-partial", "readable-empty", "readable-present"])
    expect(new Set(states).size).toBe(5)
  })

  it("renders a defect as its sentence and a readable empty source as a measured empty value", () => {
    expect(localCollectionAnswer(absent, empty, "no journal on this machine")).toEqual({
      local: false,
      why: "no journal on this machine",
    })
    expect(localCollectionAnswer(unreadable, empty, "unused")).toEqual({
      local: false,
      why: "journal at /q/log refused",
    })
    expect(localCollectionAnswer(defective, empty, "unused")).toEqual({
      local: false,
      why: "run row 2 is not JSON; row 1 kept",
    })
    expect(localCollectionAnswer(emptyRead, empty, "unused")).toEqual({ local: true, value: [] })
    expect(localCollectionAnswer(present, empty, "unused")).toEqual({ local: true, value: ["run-a", "run-b"] })
  })
})
