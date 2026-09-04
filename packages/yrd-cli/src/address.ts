import { isAbsolute, join, normalize, sep } from "node:path"
import { encodeQueueComponent } from "@yrd/queue-core"

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

function refusal(operand: string, why: string): Error {
  return new Error(`queue address '${operand}' must be <repo>#<queue>, for example beorn/hh#main; ${why}`)
}

/** Parse and canonicalize the address accepted by queue-owner commands. */
export function parseQueueAddress(operand: string): QueueAddress {
  const first = operand.indexOf("#")
  if (first <= 0 || first !== operand.lastIndexOf("#")) {
    throw refusal(operand, "the repository and queue must be separated by exactly one #")
  }
  const repository = operand.slice(0, first)
  const queue = operand.slice(first + 1)
  if (queue === "") throw refusal(operand, "the queue branch after # is empty")

  if (isAbsolute(repository)) {
    const path = normalize(repository)
    return Object.freeze({ canonical: `${path}#${queue}`, kind: "local", queue, repository: path, transport: path })
  }

  let host: string
  let path: string
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(repository)) {
    let url: URL
    try {
      url = new URL(repository)
    } catch {
      throw refusal(operand, "the repository URL is malformed")
    }
    if (url.search !== "" || url.hash !== "") {
      throw refusal(operand, "the repository may not carry a query or fragment")
    }
    host = url.hostname.toLowerCase()
    path = url.pathname
  } else {
    const parts = repository.split("/")
    if (parts.length === 2) {
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
  const canonical = `${host}/${path}#${queue}`
  return Object.freeze({ canonical, host, kind: "remote", path, queue, transport: `https://${host}/${path}.git` })
}

/** The directory whose children are this queue's repo, checkouts, logs and tmp. */
export function queueRoot(workdir: string, address: QueueAddress): string {
  const queue = encodeQueueComponent(address.queue)
  if (address.kind === "remote") return join(workdir, address.host, `${address.path}#${queue}`)
  const path = address.repository.startsWith(sep) ? address.repository.slice(sep.length) : address.repository
  return join(workdir, "local", `${path}#${queue}`)
}

/** The queue-owned clone. */
export function queueDirectory(workdir: string, address: QueueAddress): string {
  return join(queueRoot(workdir, address), "repo")
}
