export type DeepReadonly<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value

export function cloneFrozen<Value>(value: Value): DeepReadonly<Value> {
  return freeze(structuredClone(value))
}

/**
 * Objects this module has already frozen to full depth. Structural sharing makes
 * re-freezing a projected state O(new nodes) instead of O(whole state): replay
 * folds thousands of events over an ever-growing state, and without this memo the
 * per-event re-walk turns replay quadratic (measured ~6.5s at ~280-PR scale in a
 * real journal; ~0.2s with the memo). Only objects proven deeply frozen by THIS
 * function are memoized — an externally `Object.freeze`d (possibly shallow) object
 * is still visited, so the deep-freeze guarantee is preserved.
 */
const deeplyFrozen = new WeakSet<object>()

export function freeze<Value>(value: Value): DeepReadonly<Value> {
  const visiting = new WeakSet<object>()
  const visit = (current: unknown): void => {
    if (typeof current !== "object" || current === null) return
    if (deeplyFrozen.has(current) || visiting.has(current)) return
    visiting.add(current)
    for (const child of Object.values(current)) visit(child)
    Object.freeze(current)
    deeplyFrozen.add(current)
  }
  visit(value)
  return value as DeepReadonly<Value>
}
