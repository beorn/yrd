/**
 * The executable's stdout and stderr: direct, synchronous writes to the file
 * descriptor, so a document larger than a pipe's buffer reaches `| jq` and
 * `> file` whole. Bun may exit before an asynchronous `process.stdout.write`
 * of a large string drains to a pipe; @dev/3 measured the cut at 64 KiB on
 * `yrd queue list --json | jq` (2a71e626), and `queue stats --json` must not
 * repeat it (@i/10-yrd/24164). A non-blocking pipe can refuse a write with
 * EAGAIN while the reader catches up; the loop retries after a short sleep.
 * In-process callers (tests) hand the CLI their own `io` and never come here.
 */

import { writeSync } from "node:fs"

/** Write the whole text to the descriptor, however many writes it takes. */
export function writeFd(fd: number, text: string): void {
  const bytes = Buffer.from(text)
  let offset = 0
  while (offset < bytes.length) {
    try {
      offset += writeSync(fd, bytes, offset, bytes.length - offset)
    } catch (error) {
      if ((error as { code?: string }).code !== "EAGAIN") throw error
      Bun.sleepSync(1)
    }
  }
}

/** stdout and stderr as the executable writes them. */
export const fdWriters = {
  stderr: (text: string): void => {
    writeFd(2, text)
  },
  stdout: (text: string): void => {
    writeFd(1, text)
  },
} as const
