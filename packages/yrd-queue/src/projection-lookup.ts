import { createHash } from "node:crypto"

export type QueueProjectionLookupEntry<Value> = Readonly<{
  key: string
  value: Value
}>

export type QueueProjectionLookupNode<Value> = Readonly<{
  prefix: string
  children: Readonly<Record<string, QueueProjectionLookupNode<Value>>>
  entries?: readonly QueueProjectionLookupEntry<Value>[]
}>

/**
 * JSON-compatible persistent radix lookup. Updates copy only one bounded
 * SHA-256 path; explicit enumeration remains proportional to stored values.
 */
export type QueueProjectionLookup<Value> = Readonly<{
  root?: QueueProjectionLookupNode<Value>
}>

export function projectionLookupGet<Value>(
  lookup: Readonly<QueueProjectionLookup<Value>>,
  key: string,
): Value | undefined {
  let node = lookup.root
  let remaining = lookupDigest(key)
  while (node !== undefined) {
    if (!remaining.startsWith(node.prefix)) return undefined
    remaining = remaining.slice(node.prefix.length)
    if (remaining.length === 0) return node.entries?.find((entry) => entry.key === key)?.value
    const edge = remaining[0]
    if (edge === undefined) return undefined
    remaining = remaining.slice(1)
    node = node.children[edge]
  }
  return undefined
}

export function projectionLookupSet<Value>(
  lookup: Readonly<QueueProjectionLookup<Value>>,
  key: string,
  value: Value,
): QueueProjectionLookup<Value> {
  return { root: setLookupNode(lookup.root, lookupDigest(key), key, value) }
}

export function projectionLookupValues<Value>(lookup: Readonly<QueueProjectionLookup<Value>>): readonly Value[] {
  const values: Value[] = []
  const pending = lookup.root === undefined ? [] : [lookup.root]
  while (pending.length > 0) {
    const node = pending.pop()
    if (node === undefined) continue
    for (const entry of node.entries ?? []) values.push(entry.value)
    for (const child of Object.values(node.children)) pending.push(child)
  }
  return values
}

function lookupDigest(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}

function setLookupNode<Value>(
  node: Readonly<QueueProjectionLookupNode<Value>> | undefined,
  path: string,
  key: string,
  value: Value,
): QueueProjectionLookupNode<Value> {
  if (node === undefined) return { prefix: path, children: {}, entries: [{ key, value }] }

  const shared = commonPrefixLength(node.prefix, path)
  if (shared < node.prefix.length) {
    const existingSuffix = node.prefix.slice(shared)
    const existingEdge = existingSuffix[0]
    if (existingEdge === undefined) throw new Error("yrd: Queue projection lookup split lost its existing edge")
    const existing: QueueProjectionLookupNode<Value> = {
      ...node,
      prefix: existingSuffix.slice(1),
    }
    const remaining = path.slice(shared)
    const branch: QueueProjectionLookupNode<Value> = {
      prefix: path.slice(0, shared),
      children: { [existingEdge]: existing },
    }
    if (remaining.length === 0) return { ...branch, entries: [{ key, value }] }
    const edge = remaining[0]
    if (edge === undefined) throw new Error("yrd: Queue projection lookup split lost its new edge")
    return {
      ...branch,
      children: {
        ...branch.children,
        [edge]: { prefix: remaining.slice(1), children: {}, entries: [{ key, value }] },
      },
    }
  }

  const remaining = path.slice(shared)
  if (remaining.length === 0) {
    const entries = setLookupEntry(node.entries ?? [], key, value)
    return entries === node.entries ? node : { ...node, entries }
  }
  const edge = remaining[0]
  if (edge === undefined) throw new Error("yrd: Queue projection lookup lost its child edge")
  const child = setLookupNode(node.children[edge], remaining.slice(1), key, value)
  if (child === node.children[edge]) return node
  return { ...node, children: { ...node.children, [edge]: child } }
}

function setLookupEntry<Value>(
  entries: readonly QueueProjectionLookupEntry<Value>[],
  key: string,
  value: Value,
): readonly QueueProjectionLookupEntry<Value>[] {
  const index = entries.findIndex((entry) => entry.key === key)
  if (index < 0) return [...entries, { key, value }]
  if (entries[index]?.value === value) return entries
  return entries.map((entry, candidate) => (candidate === index ? { key, value } : entry))
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left[index] === right[index]) index += 1
  return index
}
