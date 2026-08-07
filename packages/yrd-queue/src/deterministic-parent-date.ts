/** Derive byte-stable commit metadata without making a child predate either parent. */
export async function deterministicParentDate(
  parents: readonly string[],
  readCommitTime: (parent: string) => Promise<string>,
): Promise<string> {
  if (parents.length === 0) throw new Error("yrd: deterministic commit requires at least one parent")
  const timestamps = await Promise.all(
    parents.map(async (parent) => {
      const output = await readCommitTime(parent)
      if (!/^\d+$/u.test(output)) throw new Error(`parent '${parent}' has invalid commit time '${output}'`)
      const timestamp = Number(output)
      if (!Number.isSafeInteger(timestamp)) throw new Error(`parent '${parent}' commit time is outside the safe range`)
      return timestamp
    }),
  )
  // A future-skew clamp, if policy ever requires one, belongs at this single boundary.
  return `${Math.max(...timestamps)} +0000`
}
