export type Rgb = Readonly<{ r: number; g: number; b: number }>

function channel(value: number): number {
  const v = value / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG contrast ratio between two resolved colors: 1 (identical) to 21 (black/white). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * The floor that separates a marker which actually reads as turning on and off
 * from two look-alike foregrounds.
 *
 * The item-13 audit measured the broken foreground-vs-foreground swing at
 * ~1.12:1 and the working foreground-vs-background swing well above this. A
 * pulse is only a pulse if an eye can see it, so "the color changed" is not the
 * assertion — this is.
 */
export const PERCEPTIBLE_SWING = 2

/**
 * One real half-period of the pane's 900ms pulse.
 *
 * The markers ride silvery's SHARED wall-clock phase, so there is no injectable
 * clock to advance: a test observes the other phase the way an operator's eye
 * does, by waiting. Callers must budget a test timeout above this.
 */
export const PULSE_HALF_PERIOD_MS = 950
