import { isAbsolute, join, normalize, sep } from "node:path"
import { encodeQueueComponent, formatQueueKey, parseQueueKey } from "@yrd/queue-core"

export type RemoteQueueAddress = Readonly<{
  kind: "remote"
  canonical: string
  host: string
  path: string
  queue: string
  transport: string
}>

export type LocalQueueAddress = Readonly<{
  kind: "local"
  canonical: string
  queue: string
  repository: string
  transport: string
}>

export type QueueAddress = RemoteQueueAddress | LocalQueueAddress
export type RunAddress = Readonly<{ canonical: string; number: number; queue: RemoteQueueAddress }>

function refusal(operand: string, why: string): Error {
  return new Error(
    `queue address '${operand}' must be <repo>@<branch> (legacy <repo>#<queue>), for example beorn/hh@main; ${why}`,
  )
}

function decodeHumanPart(value: string, operand: string, part: string): string {
  if (/%(?!40|23|25)/u.test(value)) {
    throw refusal(operand, `${part} has an invalid escape; use uppercase %40, %23 or %25`)
  }
  return value.replace(/%(40|23|25)/gu, (_, escape: string) => {
    if (escape === "40") return "@"
    if (escape === "23") return "#"
    return "%"
  })
}

function encodeHumanPart(value: string): string {
  return value.replace(/[%@#]/gu, (character) => {
    if (character === "%") return "%25"
    if (character === "@") return "%40"
    return "%23"
  })
}

function humanQueueBranchSeparator(value: string): number {
  const scheme = value.indexOf("://")
  const pathStart = scheme < 0 ? value.indexOf("/") : value.indexOf("/", scheme + 3)
  return value.indexOf("@", Math.max(0, pathStart + 1))
}

/** An @ after the repository path starts the new human branch spelling; URL userinfo does not. */
export function hasHumanQueueBranch(value: string): boolean {
  return humanQueueBranchSeparator(value) >= 0
}

/** Parse and canonicalize the address accepted by queue-owner commands. */
export function parseQueueAddress(operand: string): QueueAddress {
  const humanSeparator = humanQueueBranchSeparator(operand)
  const firstHash = operand.indexOf("#")
  const versioned = /^v\d+#/u.test(operand)
  const legacy = versioned || (firstHash >= 0 && (humanSeparator < 0 || firstHash < humanSeparator))
  const first = legacy ? firstHash : humanSeparator
  if (first <= 0) {
    throw refusal(operand, "the repository and queue must be separated by exactly one # or one @")
  }
  let repository: string
  let queue = operand.slice(first + 1)
  if (legacy) {
    try {
      const stored = parseQueueKey(operand)
      repository = stored.left
      queue = stored.branch
    } catch (error) {
      throw refusal(operand, error instanceof Error ? error.message : String(error))
    }
  } else {
    repository = decodeHumanPart(operand.slice(0, first), operand, "repository")
  }
  if (queue === "") throw refusal(operand, `the queue branch after ${legacy ? "#" : "@"} is empty`)
  if (legacy && !versioned && /^\d+$/u.test(queue)) {
    throw refusal(operand, `ambiguous #${queue}: a numeric queue branch or a run without an explicit @branch`)
  }
  if (!legacy && (queue.includes("@") || queue.includes("#"))) {
    throw refusal(operand, "raw @ or # in the branch is ambiguous; encode a literal delimiter")
  }
  if (!legacy) {
    queue = decodeHumanPart(queue, operand, "branch")
  }

  if (isAbsolute(repository)) {
    const path = normalize(repository)
    const canonical = formatQueueKey(path, queue)
    if (versioned && operand !== canonical) throw refusal(operand, `noncanonical v2 queue key; use ${canonical}`)
    return Object.freeze({ canonical, kind: "local", queue, repository: path, transport: path })
  }

  let host: string
  let path: string
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(repository)) {
    if (/[\\\t\r\n]/u.test(repository)) {
      throw refusal(operand, "the repository URL may not contain backslashes, tabs or newlines")
    }
    const authority = repository.slice(repository.indexOf("://") + 3).split("/", 1)[0]
    if (authority === undefined || authority === "") {
      throw refusal(operand, "the repository URL must name its host immediately after ://")
    }
    let url: URL
    try {
      url = new URL(repository)
    } catch {
      throw refusal(operand, "the repository URL is malformed")
    }
    if (url.search !== "" || url.hash !== "") {
      throw refusal(operand, "the repository may not carry a query or fragment")
    }
    // URL removes explicit default ports; the queue address must retain the caller's endpoint.
    const port = /:(\d+)$/u.exec(authority)?.[1]
    host = `${url.hostname.toLowerCase()}${port === undefined ? "" : `:${Number(port)}`}`
    path = url.pathname
  } else {
    const parts = repository.split("/")
    if (parts.length === 2 && !versioned) {
      host = "github.com"
      path = repository
    } else {
      host = (parts.shift() ?? "").toLowerCase()
      path = parts.join("/")
    }
  }

  path = path
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\.git$/u, "")
    .replace(/\/+$/gu, "")
  if (host === "" || path === "" || path.includes("#")) {
    throw refusal(operand, "the repository must name a host and non-empty path without #")
  }
  const components = path.split("/")
  if (components.some((component) => component === "" || component === "." || component === "..")) {
    throw refusal(operand, "the repository path contains an empty, . or .. component")
  }
  const canonical = formatQueueKey(`${host}/${path}`, queue)
  if (versioned && operand !== canonical) throw refusal(operand, `noncanonical v2 queue key; use ${canonical}`)
  return Object.freeze({ canonical, host, kind: "remote", path, queue, transport: `https://${host}/${path}.git` })
}

/** Print the portable remote queue spelling; a local test repository has no portable address. */
export function formatQueueAddress(address: QueueAddress): string {
  if (address.kind !== "remote") {
    throw new Error(`local queue ${address.canonical} has no portable remote address`)
  }
  const repository = address.path.includes("/")
    ? `${address.host}/${encodeHumanPart(address.path)}`
    : `https://${address.host}/${encodeHumanPart(address.path)}`
  return `${repository}@${encodeHumanPart(address.queue)}`
}

/** Show a stored key as a human address without exposing its v2 wire spelling. */
export function formatStoredQueueAddress(key: string): string {
  if (!/^v\d+#/u.test(key)) return key
  const address = parseQueueAddress(key)
  return address.kind === "remote"
    ? formatQueueAddress(address)
    : `${encodeHumanPart(address.repository)}@${encodeHumanPart(address.queue)}`
}

/** A published queue run is identified by its full remote queue and a positive per-queue number. */
export function parseRunAddress(operand: string): RunAddress {
  const suffix = operand.lastIndexOf("#")
  if (suffix < 0) throw new Error(`run address '${operand}' needs <repo>@<branch>#<positive-number>`)
  const numberText = operand.slice(suffix + 1)
  if (!/^[1-9]\d*$/u.test(numberText) || !Number.isSafeInteger(Number(numberText))) {
    throw new Error(
      `run address '${operand}' has invalid number ${JSON.stringify(numberText)}; expected positive decimal without leading zeros`,
    )
  }
  const queue = parseQueueAddress(operand.slice(0, suffix))
  if (queue.kind !== "remote" || operand.indexOf("@") < 0) {
    throw new Error(
      `run address '${operand}' needs a full remote <repo>@<branch>#<number>, not a local or legacy queue`,
    )
  }
  const number = Number(numberText)
  return Object.freeze({ canonical: `${formatQueueAddress(queue)}#${number}`, number, queue })
}

/**
 * The physical path uses a literal tilde as the address separator. A literal hash is a URL fragment, but a
 * percent-escape is DECODED back to that hash by module loaders (Vitest, koffi, isomorphic-git, unstorage),
 * which then cannot resolve the real directory (27065). A tilde is RFC 3986 unreserved, so no URL consumer
 * decodes it, and Git refnames cannot contain it, so a queue component never carries one: the LAST literal
 * tilde in the directory name is always the boundary. The canonical address, the encoded queue component
 * and the Git ref namespace are unchanged.
 */
export function queueRoot(workdir: string, address: QueueAddress): string {
  const queue = encodeQueueComponent(address.queue)
  if (address.kind === "remote") return join(workdir, address.host, `${address.path}~${queue}`)
  const path = address.repository.startsWith(sep) ? address.repository.slice(sep.length) : address.repository
  return join(workdir, "local", `${path}~${queue}`)
}

/** The queue-owned clone. */
export function queueDirectory(workdir: string, address: QueueAddress): string {
  return join(queueRoot(workdir, address), "repo")
}

/**
 * The physical root the pre-27065 builder wrote: the same layout with a percent-escaped hash as the
 * separator. It exists ONLY so the queue can refuse to create a second root beside a legacy one: a
 * percent-escape is decoded back to a hash by URL-based module loaders, so nothing may read or write a
 * queue here after the cutover (@cto 524fdc93, b7bbd050).
 */
export function legacyQueueRoot(workdir: string, address: QueueAddress): string {
  const queue = encodeQueueComponent(address.queue)
  return address.kind === "remote"
    ? join(workdir, address.host, `${address.path}%23${queue}`)
    : join(
        workdir,
        "local",
        `${address.repository.startsWith(sep) ? address.repository.slice(sep.length) : address.repository}%23${queue}`,
      )
}

/** The queue-owned clone the pre-27065 builder wrote. */
export function legacyQueueDirectory(workdir: string, address: QueueAddress): string {
  return join(legacyQueueRoot(workdir, address), "repo")
}
