export type QueueReadFailure = Readonly<{
  code: "queue-read-boundary-moved"
  message: string
  readCursor: number
  journalCursor: number
  showing: "last-complete" | "bounded-partial"
}>

export function queueReadFailureMessage(failure: QueueReadFailure): string {
  const snapshot = failure.showing === "last-complete" ? "last complete" : "bounded partial"
  return `${failure.message}; showing ${snapshot} snapshot; retrying`
}
