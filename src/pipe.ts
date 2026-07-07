/** Compose with*() plugins left-to-right: pipe(createBay(...), withA(), withB()). */
export function pipe<T>(seed: T, ...fns: Array<(t: T) => T>): T {
  let out = seed
  for (const fn of fns) out = fn(out)
  return out
}
