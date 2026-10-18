/**
 * A named failure, with the context that failure needs. Actor routing belongs
 * to the change's Next value, not to diagnostic content.
 */

import { isAbsolute } from "node:path"

export const INCIDENT_TRAILERS = ["Code", "Subject", "Via", "Evidence", "Next"] as const

export type Incident = Readonly<{
  code: string
  subject: string
  via?: string
  evidence?: string
  next?: string
}>

const PROPERTY: Readonly<Record<(typeof INCIDENT_TRAILERS)[number], keyof Incident>> = {
  Code: "code",
  Subject: "subject",
  Via: "via",
  Evidence: "evidence",
  Next: "next",
}

/** Required facts and only the supplied context; old actor fields are not diagnostic content. */
export function incidentTrailers(incident: Incident): readonly (readonly [string, string])[] {
  const trailers: (readonly [string, string])[] = []
  for (const name of INCIDENT_TRAILERS) {
    const value = incident[PROPERTY[name]]
    if (value === undefined && name !== "Code" && name !== "Subject") continue
    if (typeof value !== "string" || value.trim() === "" || value.includes("\n")) {
      throw new Error(`incident ${name}: must be one non-empty line`)
    }
    if (name === "Evidence" && !isAbsolute(value)) {
      throw new Error(`incident Evidence: is not an absolute path: ${value}`)
    }
    trailers.push([name, value])
  }
  return trailers
}

/** The subject first, followed by its code and available compact context. */
export function incidentLine(incident: Incident): string {
  return [`${incident.subject} [${incident.code}]`, ...incidentLines(incident).slice(2)].join("; ")
}

/** One supplied field per line, subject first. */
export function incidentLines(incident: Incident): readonly string[] {
  return [
    `subject: ${incident.subject}`,
    `code: ${incident.code}`,
    ...(incident.via === undefined ? [] : [`via: ${incident.via}`]),
    ...(incident.evidence === undefined ? [] : [`evidence: ${incident.evidence}`]),
    ...(incident.next === undefined ? [] : [`next: ${incident.next}`]),
  ]
}

/** Decode both historical owner-bearing rows and current diagnostics without rewriting either. */
export function incidentIn(
  record: Readonly<Record<string, unknown>>,
):
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "incident"; incident: Incident }>
  | Readonly<{ kind: "malformed"; reason: string }> {
  const fields = ["code", "subject", "via", "evidence", "next"] as const
  if (fields.every((name) => record[name] === undefined)) return { kind: "none" }
  const absent = ["code", "subject"].filter((name) => record[name] === undefined)
  const unreadable = fields.filter((name) => record[name] !== undefined && typeof record[name] !== "string")
  if (absent.length > 0 || unreadable.length > 0) {
    return {
      kind: "malformed",
      reason: [
        ...(absent.length === 0 ? [] : [`missing ${absent.join(", ")}`]),
        ...(unreadable.length === 0 ? [] : [`not a string: ${unreadable.join(", ")}`]),
      ].join("; "),
    }
  }
  const incident: Incident = {
    code: record.code as string,
    subject: record.subject as string,
    ...(record.via === undefined ? {} : { via: record.via as string }),
    ...(record.evidence === undefined ? {} : { evidence: record.evidence as string }),
    ...(record.next === undefined ? {} : { next: record.next as string }),
  }
  try {
    incidentTrailers(incident)
    return { kind: "incident", incident }
  } catch (error) {
    return { kind: "malformed", reason: error instanceof Error ? error.message : String(error) }
  }
}
