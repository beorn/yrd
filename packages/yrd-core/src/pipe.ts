export type AppPlugin<Input, Output> = (input: Input) => Output

export function pipe<A>(base: A): A
export function pipe<A, B>(base: A, p1: AppPlugin<A, B>): B
export function pipe<A, B, C>(base: A, p1: AppPlugin<A, B>, p2: AppPlugin<B, C>): C
export function pipe<A, B, C, D>(base: A, p1: AppPlugin<A, B>, p2: AppPlugin<B, C>, p3: AppPlugin<C, D>): D
export function pipe<A, B, C, D, E>(
  base: A,
  p1: AppPlugin<A, B>,
  p2: AppPlugin<B, C>,
  p3: AppPlugin<C, D>,
  p4: AppPlugin<D, E>,
): E
export function pipe<A, B, C, D, E, F>(
  base: A,
  p1: AppPlugin<A, B>,
  p2: AppPlugin<B, C>,
  p3: AppPlugin<C, D>,
  p4: AppPlugin<D, E>,
  p5: AppPlugin<E, F>,
): F
export function pipe<A, B, C, D, E, F, G>(
  base: A,
  p1: AppPlugin<A, B>,
  p2: AppPlugin<B, C>,
  p3: AppPlugin<C, D>,
  p4: AppPlugin<D, E>,
  p5: AppPlugin<E, F>,
  p6: AppPlugin<F, G>,
): G
export function pipe<A, B, C, D, E, F, G, H>(
  base: A,
  p1: AppPlugin<A, B>,
  p2: AppPlugin<B, C>,
  p3: AppPlugin<C, D>,
  p4: AppPlugin<D, E>,
  p5: AppPlugin<E, F>,
  p6: AppPlugin<F, G>,
  p7: AppPlugin<G, H>,
): H
export function pipe(base: unknown, ...plugins: AppPlugin<never, unknown>[]): unknown {
  let result = base
  for (const plugin of plugins) result = plugin(result as never)
  return result
}
