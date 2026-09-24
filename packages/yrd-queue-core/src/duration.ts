/**
 * A duration as a person writes one — `45m`, `1h`, `90s`, `1500ms`, or a bare
 * number of seconds — in milliseconds, or undefined when the text is not one
 * (or is not positive).
 *
 * One reading for every place yrd takes a duration: the CLI's `--stop-after`
 * and the declaration's `health.stallAfter` (25669) parse the same grammar, so a
 * value that works in one works in the other.
 */
export function parseDuration(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*(h|m|s|ms)?$/i.exec(value.trim())
  if (!match) return undefined
  const amount = Number(match[1])
  if (Number.isNaN(amount) || amount <= 0) return undefined
  const unit = (match[2] ?? "s").toLowerCase()
  switch (unit) {
    case "h":
      return Math.round(amount * 3600 * 1000)
    case "m":
      return Math.round(amount * 60 * 1000)
    case "s":
      return Math.round(amount * 1000)
    case "ms":
      return Math.round(amount)
    default:
      return undefined
  }
}
