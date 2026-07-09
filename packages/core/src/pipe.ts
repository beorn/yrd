type Step<Input, Output> = (value: Input) => Output

export type PipeBuilder<Value> = {
  then<Output>(step: Step<Value, Output>): PipeBuilder<Output>
  build(): Value
}

/** Compose an arbitrary number of plugins while preserving each intermediate
 * capability type. Use pipe() for short, visually complete compositions. */
export function from<Value>(value: Value): PipeBuilder<Value> {
  return {
    then<Output>(step: Step<Value, Output>): PipeBuilder<Output> {
      return from(step(value))
    },
    build(): Value {
      return value
    },
  }
}

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
export function pipe<A, B, C, D, E, F, G, H, I, J>(
  seed: A,
  ab: Step<A, B>,
  bc: Step<B, C>,
  cd: Step<C, D>,
  de: Step<D, E>,
  ef: Step<E, F>,
  fg: Step<F, G>,
  gh: Step<G, H>,
  hi: Step<H, I>,
  ij: Step<I, J>,
): J
export function pipe<A, B, C, D, E, F, G, H, I, J, K>(
  seed: A,
  ab: Step<A, B>,
  bc: Step<B, C>,
  cd: Step<C, D>,
  de: Step<D, E>,
  ef: Step<E, F>,
  fg: Step<F, G>,
  gh: Step<G, H>,
  hi: Step<H, I>,
  ij: Step<I, J>,
  jk: Step<J, K>,
): K
export function pipe<A, B, C, D, E, F, G, H, I, J, K, L>(
  seed: A,
  ab: Step<A, B>,
  bc: Step<B, C>,
  cd: Step<C, D>,
  de: Step<D, E>,
  ef: Step<E, F>,
  fg: Step<F, G>,
  gh: Step<G, H>,
  hi: Step<H, I>,
  ij: Step<I, J>,
  jk: Step<J, K>,
  kl: Step<K, L>,
): L
export function pipe<A, B, C, D, E, F, G, H, I, J, K, L, M>(
  seed: A,
  ab: Step<A, B>,
  bc: Step<B, C>,
  cd: Step<C, D>,
  de: Step<D, E>,
  ef: Step<E, F>,
  fg: Step<F, G>,
  gh: Step<G, H>,
  hi: Step<H, I>,
  ij: Step<I, J>,
  jk: Step<J, K>,
  kl: Step<K, L>,
  lm: Step<L, M>,
): M
/** Compose with*() plugins left-to-right while threading each plugin's added
 * capabilities into the next plugin's input type. For longer application
 * compositions, group cohesive domain plugins behind one named with* plugin. */
export function pipe(seed: unknown, ...steps: Array<(value: any) => any>): unknown {
  let result = seed
  for (const step of steps) result = step(result)
  return result
}
