type Step<Input, Output> = (value: Input) => Output

export function pipe<A>(seed: A): A
export function pipe<A, B>(seed: A, ab: Step<A, B>): B
export function pipe<A, B, C>(seed: A, ab: Step<A, B>, bc: Step<B, C>): C
export function pipe<A, B, C, D>(seed: A, ab: Step<A, B>, bc: Step<B, C>, cd: Step<C, D>): D
export function pipe<A, B, C, D, E>(seed: A, ab: Step<A, B>, bc: Step<B, C>, cd: Step<C, D>, de: Step<D, E>): E
export function pipe<A, B, C, D, E, F>(
  seed: A,
  ab: Step<A, B>,
  bc: Step<B, C>,
  cd: Step<C, D>,
  de: Step<D, E>,
  ef: Step<E, F>,
): F
export function pipe<A, B, C, D, E, F, G>(
  seed: A,
  ab: Step<A, B>,
  bc: Step<B, C>,
  cd: Step<C, D>,
  de: Step<D, E>,
  ef: Step<E, F>,
  fg: Step<F, G>,
): G
export function pipe<A, B, C, D, E, F, G, H>(
  seed: A,
  ab: Step<A, B>,
  bc: Step<B, C>,
  cd: Step<C, D>,
  de: Step<D, E>,
  ef: Step<E, F>,
  fg: Step<F, G>,
  gh: Step<G, H>,
): H
export function pipe<A, B, C, D, E, F, G, H, I>(
  seed: A,
  ab: Step<A, B>,
  bc: Step<B, C>,
  cd: Step<C, D>,
  de: Step<D, E>,
  ef: Step<E, F>,
  fg: Step<F, G>,
  gh: Step<G, H>,
  hi: Step<H, I>,
): I
export function pipe(seed: unknown, ...steps: Array<(value: any) => any>): unknown {
  let result = seed
  for (const step of steps) result = step(result)
  return result
}
