/**
 * Binds a loggily span to a stage-clock frame, so the command's stage
 * breakdown is DERIVED from the spans rather than kept in a list beside them.
 *
 * WHY. The breakdown used to name a hardcoded handful of `stage()` call sites
 * while `setup`, `acquire`, `materialize`, `submodules:walk` and
 * `queue:compose` were timed as spans a few lines away in the same log. It
 * reported their several seconds as `unaccountedMs` — a line asserting that the
 * missing time was uninstrumented when it was instrumented, named, and merely
 * not summed. That sends a reader to add instrumentation that already exists.
 * A hand-kept stage list could not have held anyway: step spans take their
 * namespace from the operator's `.yrd.yml`, so the set of span names is open
 * and partly data-driven, and no literal list can enumerate it.
 *
 * WHERE IT BINDS. At the span's CONSTRUCTOR, not at its emitted event. Spans
 * are dropped on the way out by the sink's namespace filter, so an accounting
 * built by reading the emitted stream would shrink whenever an operator
 * narrowed `DEBUG` — emptiest under `DEBUG=yrd:perf`, which is precisely what
 * you set to read this breakdown. Binding at construction makes the rows
 * independent of which namespaces anybody chose to print.
 *
 * WHAT IS NOT COUNTED. Whether a span object exists at all is still loggily's
 * decision (`spans: false` at the default `warn` level creates none). That
 * costs nothing here: the breakdown is a `debug` line, so it is emitted only at
 * the levels where spans are also on. When no span is created this wrapper
 * returns `undefined` exactly as the bare logger does, so nothing about a
 * default-level run changes.
 *
 * NESTING. Handled by the stage clock, which charges wall clock to whichever
 * stage is innermost; see `stage-clock.ts`. `submodules:walk` inside
 * `submodules:materialize` inside `materialize` inside `acquire` yields four
 * disjoint rows, not four overlapping ones.
 */

import type { ConditionalLogger, LazyProps, SpanLogger } from "loggily"
import { openStage } from "./stage-clock.ts"

/** Wrap `logger` so every span it creates — and every span created by its
 * children, and by those spans' own children — also opens a stage frame named
 * for the span's namespace. That name is the logger name loggily itself uses,
 * so a row reads `yrd:queue:compose` exactly as the `SPAN` line does.
 *
 * Apply this ONCE, to the host-owned root. Children are wrapped on the way out,
 * so a logger handed down through core, queue and process code stays accounted
 * for without any call site knowing this exists. */
export function withStageAccounting<Logger extends ConditionalLogger>(logger: Logger): Logger {
  return new Proxy(logger, {
    get(target, property, receiver): unknown {
      if (property === "span") {
        const createSpan = Reflect.get(target, property, target) as
          | ((namespace?: string, props?: LazyProps) => SpanLogger)
          | undefined
        if (createSpan === undefined) return undefined
        return (namespace?: string, props?: LazyProps): SpanLogger =>
          accountSpan(createSpan.call(target, namespace, props))
      }
      if (property === "child") {
        const createChild = Reflect.get(target, property, target) as (...args: unknown[]) => ConditionalLogger
        return (...args: unknown[]) => withStageAccounting(createChild.apply(target, args))
      }
      return Reflect.get(target, property, receiver) as unknown
    },
  }) as Logger
}

/** Open the span's stage and close it when the span does. Both exits are
 * covered: `using` disposes, and `observeYrdLifecycle` calls `end()` in a
 * `finally`. The handle is idempotent, so a span that takes both paths is
 * charged once. */
function accountSpan(span: SpanLogger): SpanLogger {
  const stage = openStage(span.name)
  const finish = (release: () => void): (() => void) => {
    return () => {
      try {
        release()
      } finally {
        stage.close()
      }
    }
  }
  return new Proxy(span, {
    get(target, property, receiver): unknown {
      if (property === "end" || property === Symbol.dispose) {
        const release = Reflect.get(target, property, target) as () => void
        return finish(() => {
          release.call(target)
        })
      }
      if (property === "span") {
        const createSpan = Reflect.get(target, property, target) as (
          namespace?: string,
          props?: LazyProps,
        ) => SpanLogger
        return (namespace?: string, props?: LazyProps): SpanLogger =>
          accountSpan(createSpan.call(target, namespace, props))
      }
      if (property === "child") {
        const createChild = Reflect.get(target, property, target) as (...args: unknown[]) => ConditionalLogger
        return (...args: unknown[]) => withStageAccounting(createChild.apply(target, args))
      }
      return Reflect.get(target, property, receiver) as unknown
    },
  })
}
