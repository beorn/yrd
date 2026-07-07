import { appendFile, mkdir } from "node:fs/promises"
import { createReadStream, existsSync } from "node:fs"
import { createInterface } from "node:readline"
import { dirname } from "node:path"
import type { BayEvent, Journal } from "./types.ts"

/**
 * jsonl journal — the replayable source of history (spec § How it's built).
 * Append-only; one BayEvent per line; replay folds state from the top.
 * Fail-loud: a malformed line is a corruption signal, never skipped silently.
 */
export function createJsonlJournal(path: string): Journal {
  let dirReady = false

  async function ensureDir(): Promise<void> {
    if (dirReady) return
    await mkdir(dirname(path), { recursive: true })
    dirReady = true
  }

  return {
    async append(event: BayEvent): Promise<void> {
      await ensureDir()
      await appendFile(path, JSON.stringify(event) + "\n", "utf8")
    },

    async *replay(): AsyncIterable<BayEvent> {
      if (!existsSync(path)) return // fresh bay: empty journal is valid
      const lines = createInterface({
        input: createReadStream(path, "utf8"),
        crlfDelay: Infinity,
      })
      let lineNo = 0
      for await (const line of lines) {
        lineNo++
        if (line.trim() === "") continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch (cause) {
          throw new Error(
            `bay journal corrupt at ${path}:${lineNo} — invalid JSON. ` +
              `Repair or move the journal aside; refusing to fold partial history.`,
            { cause },
          )
        }
        const event = parsed as BayEvent
        if (typeof event.type !== "string" || typeof event.ts !== "string") {
          throw new Error(
            `bay journal corrupt at ${path}:${lineNo} — missing type/ts. ` +
              `Repair or move the journal aside; refusing to fold partial history.`,
          )
        }
        yield event
      }
    },
  }
}
