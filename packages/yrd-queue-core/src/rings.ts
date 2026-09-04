/**
 * The onion: the whole cake on one screen.
 *
 * `run.ts` is the bare loop. Every feature that is not the loop is one ring —
 * a function from the step bundle to the step bundle, living in one file of its
 * own — and this list is where the loop learns about it. Adding a feature is one
 * file and one line here; deleting one is the same two edits, and there is
 * nowhere else for a stray half of it to hide.
 */

import type { Ring, Steps } from "./run.ts"
import { withPause } from "./with-pause.ts"

/** The rings, outermost first: the first named here sees a step call before the rest. */
export const RINGS: readonly Ring[] = [withPause]

/** The bare loop's steps with every ring around them, outermost last to wrap. */
export const composed = (base: Steps): Steps => RINGS.reduceRight((steps, ring) => ring(steps), base)
