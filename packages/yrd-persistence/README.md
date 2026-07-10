# `@yrd/persistence`

`@yrd/persistence` implements Core's `Journal` over a repository-local JSONL
file. It owns byte cursors, checksums, torn-tail repair, POSIX writer exclusion,
data sync, and directory sync. It does not own commands or projections.

```ts
import { createJournal } from "@yrd/persistence"

const journal = await createJournal({ dir: ".git/yrd" })
```

The returned value is a plain object with two methods:

```ts
journal.read(afterCursor)
journal.append(frame, expectedCursor)
```

## Format

`events.jsonl` contains one checksummed versioned Frame per line. A Frame is
one command cause plus every event accepted with that command.

Reads stream bytes through `Bun.JSONL.parseChunk()` and validate each decoded
Frame with Core's Zod schema. The cursor is the exclusive byte offset after a
fully newline-committed batch.

An unterminated final record is uncommitted. Readers ignore it. The next
append truncates it while holding the writer lock. A malformed
newline-terminated record is committed corruption and aborts replay.

## Concurrency

Append takes the OS lock only while it:

1. repairs an uncommitted tail;
2. compares the committed byte cursor;
3. writes one complete Frame;
4. calls `datasync()`;
5. syncs the directory when creating the file.

A stale cursor returns `{ appended: false, cursor }`. Core then replays and
retries its pure command decision. Readers do not need a writer lease.

`createJournal()` accepts an injected `Exclusive` object and Loggily logger
for focused tests or another lock backend:

```ts
const journal = await createJournal({
  dir,
  inject: { exclusive, log },
})
```

## Growth Guardrail

Replay logs a warning when the file reaches 10 MiB or an initial replay reaches
10,000 Frames. The warning points to
`@yrd/core/21012-monorepo/21060-journal-compaction-gc`, the pre-created P4
compaction and GC bead. These thresholds are reminders to implement compaction,
not configuration knobs to raise when replay becomes slow.
