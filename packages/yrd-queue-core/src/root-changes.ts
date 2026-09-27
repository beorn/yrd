/** Validated git-super receipt facts used by event queue merges. */
import { createLegacyBackend, executableFor, type Git } from "./git.ts"

/** The approved root-entry facts; no child repository, remote or delivery policy. */
export type RootChanges = Readonly<{
  merge: string
  encoded: string
  changes: readonly Readonly<{ path: string; mode: "160000"; from: string; to: string }>[]
  /** Present only when read from the producer's temporary local ref. */
  receipt?: Readonly<{ ref: string; oid: string }>
}>

/** Read a live producer receipt, or validate its exact copied Root-Changes bytes. */
export async function readRootChanges(git: Git, merge: string, copied?: string): Promise<RootChanges | undefined> {
  const format = (await git(["rev-parse", "--show-object-format"])).trim()
  if (format !== "sha1" && format !== "sha256") {
    throw new Error(`Root-Changes: unsupported repository object format ${format}`)
  }
  const width = format === "sha1" ? 40 : 64
  const oid = (value: unknown): value is string =>
    typeof value === "string" && new RegExp(`^[0-9a-f]{${width}}$`, "u").test(value) && !/^0+$/u.test(value)
  function invalid(reason: string): never {
    throw new Error(`Root-Changes for ${merge}: ${reason}`)
  }
  if (!oid(merge)) invalid(`Merge must be a full ${format} commit OID`)
  let json: string
  let receipt: RootChanges["receipt"]
  if (copied === undefined) {
    const ref = `refs/git-super/receipts/${merge}`
    const repo = (await git(["rev-parse", "--absolute-git-dir"])).trim()
    if (repo === "") throw new Error(`Root-Changes for ${merge}: git returned an empty repository store`)
    const backend = createLegacyBackend(executableFor(git))
    if (backend.listRefs === undefined) throw new Error("Root-Changes: Gitomic backend lacks listRefs")
    const receiptOid = (await backend.listRefs(repo, ref)).get(ref)
    if (receiptOid === undefined) return undefined
    if (!oid(receiptOid) || (await git(["cat-file", "-t", receiptOid])).trim() !== "commit") {
      invalid(`present receipt ref ${ref} does not name one commit`)
    }
    if ((await git(["show", "-s", "--format=%P", receiptOid])).trim() !== merge) {
      invalid(`receipt ${receiptOid} must have sole parent ${merge}`)
    }
    const tree = await git(["ls-tree", "-z", receiptOid])
    const file = /^100644 blob ([0-9a-f]+)\treceipt\.json\0$/u.exec(tree)
    const blob = file?.[1]
    if (!oid(blob)) invalid(`receipt ${receiptOid} must contain exactly one regular receipt.json blob`)
    json = await git(["cat-file", "blob", blob])
    // Text transport must round-trip the original blob, never replacement-decode invalid bytes.
    if ((await git(["hash-object", "--stdin"], json)).trim() !== blob) {
      invalid(`receipt.json at ${receiptOid} is not lossless UTF-8`)
    }
    receipt = { ref, oid: receiptOid }
  } else {
    if (copied === "" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(copied)) {
      invalid("copied trailer is not canonical base64")
    }
    const bytes = Buffer.from(copied, "base64")
    if (bytes.toString("base64") !== copied) invalid("copied trailer is not canonical base64")
    try {
      json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch (error) {
      throw new Error(`Root-Changes for ${merge}: copied trailer is not UTF-8`, { cause: error })
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new Error(`Root-Changes for ${merge}: receipt.json is not JSON`, { cause: error })
  }
  // JSON.parse owns grammar. Audit only object-key uniqueness, including escaped keys it would overwrite.
  const tokens = json.match(/"(?:\\[\s\S]|[^"\\])*"|[{}[\]:]/gu) ?? []
  const objects: (Set<string> | undefined)[] = []
  for (const [index, token] of tokens.entries()) {
    if (token === "{") objects.push(new Set())
    else if (token === "[") objects.push(undefined)
    else if (token === "}" || token === "]") objects.pop()
    else if (token.startsWith('"') && tokens[index + 1] === ":") {
      const keys = objects.at(-1)
      const key = JSON.parse(token) as string
      if (keys === undefined || keys.has(key)) invalid(`duplicate JSON field ${key}`)
      keys.add(key)
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) invalid("payload must be an object")
  const value = parsed as Record<string, unknown>
  if (
    Object.keys(value).sort().join(",") !== "changes,merge,version" ||
    value.version !== 1 ||
    value.merge !== merge ||
    !Array.isArray(value.changes)
  ) {
    invalid("payload must have version 1, the exact Merge, and a changes array")
  }
  if ((await git(["cat-file", "-t", merge])).trim() !== "commit") invalid("Merge does not name a commit")
  const paths = new Set<string>()
  const changes: RootChanges["changes"][number][] = []
  for (const item of value.changes as unknown[]) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) invalid("change row must be an object")
    const row = item as Record<string, unknown>
    if (
      Object.keys(row).sort().join(",") !== "from,mode,path,to" ||
      row.mode !== "160000" ||
      typeof row.path !== "string" ||
      !oid(row.from) ||
      !oid(row.to)
    ) {
      invalid("change row requires path, mode 160000 and full from/to OIDs")
    }
    const path = row.path as string
    if (
      path.includes("\0") ||
      path.includes("\\") ||
      path.split("/").some((part) => part === "" || part === "." || part === "..") ||
      Buffer.from(path, "utf8").toString("utf8") !== path ||
      paths.has(path)
    ) {
      invalid(`change path ${path} must be unique, root-relative UTF-8 without traversal`)
    }
    paths.add(path)
    const actual = await git(["--literal-pathspecs", "ls-tree", "-r", "-z", "--full-tree", merge, "--", path])
    if (actual !== `160000 commit ${row.to}\t${path}\0`) {
      invalid(`change ${path} mode/to does not match the exact Merge tree`)
    }
    changes.push({ path, mode: "160000", from: row.from as string, to: row.to as string })
  }
  return {
    merge,
    encoded: Buffer.from(json, "utf8").toString("base64"),
    changes,
    ...(receipt === undefined ? {} : { receipt }),
  }
}
