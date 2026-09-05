/**
 * A stored queue failure or wait: a stable code and the concrete fact.
 * Context is carried when known; an incident does not assign an actor.
 */

import { isAbsolute } from "node:path"
import { trailers, type ChangeRecord } from "./records.ts"

export const INCIDENT_TRAILERS = ["Code", "Subject", "Via", "Evidence", "Next"] as const

/** New writers use local codes; readers also accept unknown historical codes. */
const CODES = {
  "yrd-setup-unusable": "The queue could not prepare the tree it must judge.",
  "yrd-queue-crash": "The queue stopped before it could decide the change.",
  "yrd-check-unresolved": "A check could not determine whether the tree passed.",
  "yrd-submodule-main-regression": "A settled component main breaks the root without the candidate's content.",
  "gitlink-off-main": "The candidate names a component commit not yet carried by its main.",
  "yrd-merge-unresolved": "git-super could not compose the change; context preserves its own diagnosis.",
} as const

export type IncidentCode = keyof typeof CODES

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

/** Read the fact and supplied context; retired trailers need no compatibility reader. */
export function incidentFrom(record: ChangeRecord): Incident {
  const values = Object.fromEntries(
    INCIDENT_TRAILERS.flatMap((name) => {
      const found = trailers(record, name)
      if (found.length === 0 && name !== "Code" && name !== "Subject") return []
      if (found.length !== 1 || found[0]?.trim() === "" || found[0]?.includes("\n")) {
        throw new Error(
          `record ${record.sha.slice(0, 12)} carries ${String(found.length)} ${name}: trailers; a queue incident needs exactly one non-empty value`,
        )
      }
      return [[PROPERTY[name], found[0]]]
    }),
  ) as Incident
  if (values.evidence !== undefined && !isAbsolute(values.evidence)) {
    throw new Error(`record ${record.sha.slice(0, 12)} Evidence: is not an absolute path: ${values.evidence}`)
  }
  return values
}

/** Write registered local facts and supplied context, never an invented owner. */
export function incidentTrailers(
  incident: Incident & { readonly code: IncidentCode },
): readonly (readonly [string, string])[] {
  if (incident.evidence !== undefined && !isAbsolute(incident.evidence)) {
    throw new Error(`incident Evidence: is not an absolute path: ${incident.evidence}`)
  }
  return INCIDENT_TRAILERS.flatMap((name) => {
    const value = incident[PROPERTY[name]]
    if (value === undefined && name !== "Code" && name !== "Subject") return []
    if (value === undefined || value.trim() === "" || value.includes("\n")) {
      throw new Error(`incident ${name}: must be one non-empty line`)
    }
    return [[name, value] as const]
  })
}

/** The concrete fact first; context belongs in the full view. */
export function incidentLine(incident: Incident): string {
  return `${incident.subject} (${incident.code})`
}

/** One field per line, subject first, with absent context left out. */
export function incidentLines(incident: Incident): readonly string[] {
  return [
    `subject: ${incident.subject}`,
    `code: ${incident.code}`,
    ...(["via", "evidence", "next"] as const).flatMap((name) =>
      incident[name] === undefined ? [] : [`${name}: ${incident[name]}`],
    ),
  ]
}
