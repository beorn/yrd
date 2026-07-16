/**
 * @failure A frozen projection that is shallow, mutable, or re-walked per event breaks replay integrity or turns replay quadratic.
 * @level l1
 * @consumer @yrd/core
 */
import { describe, expect, it } from "vitest"
import { cloneFrozen, freeze } from "../src/immutable.ts"

describe("freeze", () => {
  it("freezes nested objects and arrays to full depth", () => {
    const value = freeze({ a: { b: [{ c: 1 }] }, d: [1, 2] })
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.a)).toBe(true)
    expect(Object.isFrozen(value.a.b)).toBe(true)
    expect(Object.isFrozen(value.a.b[0])).toBe(true)
    expect(Object.isFrozen(value.d)).toBe(true)
  })

  it("is idempotent and preserves structural sharing across repeated projections", () => {
    const shared = freeze({ deep: { list: [1, 2, 3] } })
    // the replay hot path: each event projects a new root that shares the old subtrees
    let state: { generation: number; shared: unknown } = { generation: 0, shared }
    for (let index = 0; index < 1000; index += 1) {
      state = freeze({ generation: index, shared: state.shared }) as typeof state
    }
    expect(state.shared).toBe(shared)
    expect(Object.isFrozen(state)).toBe(true)
    expect(Object.isFrozen(state.shared)).toBe(true)
  })

  it("still deep-freezes subtrees that were shallow-frozen elsewhere", () => {
    const child = { mutable: 1 }
    const shallow = Object.freeze({ child })
    const value = freeze({ shallow })
    expect(Object.isFrozen(value.shallow)).toBe(true)
    expect(Object.isFrozen(value.shallow.child)).toBe(true)
    expect(() => {
      ;(child as { mutable: number }).mutable = 2
    }).toThrow(TypeError)
  })

  it("handles cyclic values without recursing forever", () => {
    type Node = { name: string; next?: Node }
    const node: Node = { name: "a" }
    node.next = node
    const frozen = freeze(node)
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(frozen.next).toBe(frozen)
  })

  it("cloneFrozen leaves the source mutable and returns a deep-frozen clone", () => {
    const source = { keep: { n: 1 } }
    const clone = cloneFrozen(source)
    expect(clone).toEqual(source)
    expect(Object.isFrozen(clone)).toBe(true)
    expect(Object.isFrozen(clone.keep)).toBe(true)
    source.keep.n = 2
    expect(clone.keep.n).toBe(1)
  })
})
