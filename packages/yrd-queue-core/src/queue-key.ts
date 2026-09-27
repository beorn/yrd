import { assertBranch, encodeQueueComponent } from "./refs.ts"

/** One stored spelling for a repository (or remote name) and its queue branch. */
export function formatQueueKey(left: string, branch: string): string {
  if (left === "" || branch === "") throw new Error("queue key needs two nonempty fields")
  if (branch.includes("#")) {
    assertBranch(branch)
    return `v2#${encodeQueueComponent(left)}#${encodeQueueComponent(branch)}`
  }
  if (left.includes("#")) throw new Error("legacy queue key cannot contain # in its left field")
  if (/^v\d+$/u.test(left)) throw new Error(`queue key ${JSON.stringify(left)} is a reserved version marker`)
  return `${left}#${branch}`
}

/** Read either the exact legacy form or the versioned form, without aliases. */
export function parseQueueKey(key: string): Readonly<{ left: string; branch: string }> {
  if (key.startsWith("v2#")) {
    const parts = key.split("#")
    const leftField = parts[1]
    const branchField = parts[2]
    if (
      parts.length !== 3 ||
      leftField === undefined ||
      leftField === "" ||
      branchField === undefined ||
      branchField === ""
    ) {
      throw new Error(`v2 queue key ${JSON.stringify(key)} needs two nonempty encoded fields`)
    }
    const left = decodeField(leftField, key)
    const branch = decodeField(branchField, key)
    if (!branch.includes("#")) throw new Error(`v2 queue key ${JSON.stringify(key)} requires a # in its branch`)
    assertBranch(branch)
    return { left, branch }
  }
  if (/^v\d+#/u.test(key)) throw new Error(`unknown queue key version in ${JSON.stringify(key)}`)
  const cut = key.indexOf("#")
  if (cut !== key.lastIndexOf("#")) {
    throw new Error(`raw # in queue key ${JSON.stringify(key)} is ambiguous; use v2#<encoded-left>#<encoded-branch>`)
  }
  if (cut <= 0 || cut !== key.lastIndexOf("#") || cut === key.length - 1) {
    throw new Error(`legacy queue key ${JSON.stringify(key)} needs exactly one # between nonempty fields`)
  }
  return { left: key.slice(0, cut), branch: key.slice(cut + 1) }
}

function decodeField(encoded: string, key: string): string {
  const bytes: number[] = []
  for (let index = 0; index < encoded.length; index++) {
    const char = encoded.charAt(index)
    if (char === "%") {
      const pair = encoded.slice(index + 1, index + 3)
      if (!/^[0-9A-F]{2}$/u.test(pair)) {
        throw new Error(`v2 queue key ${JSON.stringify(key)} has a noncanonical percent escape`)
      }
      bytes.push(Number.parseInt(pair, 16))
      index += 2
    } else if (/^[A-Za-z0-9._-]$/u.test(char)) {
      bytes.push(char.charCodeAt(0))
    } else {
      throw new Error(`v2 queue key ${JSON.stringify(key)} has a noncanonical encoded field`)
    }
  }
  let decoded: string
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes))
  } catch {
    throw new Error(`v2 queue key ${JSON.stringify(key)} has invalid UTF-8`)
  }
  if (decoded === "" || encodeQueueComponent(decoded) !== encoded) {
    throw new Error(`v2 queue key ${JSON.stringify(key)} has a noncanonical encoded field`)
  }
  return decoded
}
