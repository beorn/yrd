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

export function freeze<Value>(value: Value): DeepReadonly<Value> {
  const seen = new WeakSet<object>()
  const visit = (current: unknown): void => {
    if (typeof current !== "object" || current === null || seen.has(current)) return
    seen.add(current)
    for (const child of Object.values(current)) visit(child)
    Object.freeze(current)
  }
  visit(value)
  return value as DeepReadonly<Value>
}
