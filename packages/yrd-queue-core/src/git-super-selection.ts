/**
 * The queue's launcher-owned git-super selection (27098).
 *
 * A frozen publication runs the git-super pinned in the tree it runs FROM, so
 * changing the deployed Yrd runtime alone never changed the tool that judged
 * #26996's revert — the base's defective git-super still received the push
 * authority. The queue must publish with the SAME physical landing root's
 * git-super it was launched with, named by absolute path and pinned by the
 * landing root's recorded submodule sha.
 *
 * `tools/yrd-runtime.mjs` freezes those two values at launch. Nothing here
 * falls back to a `git super` whose executable the ambient PATH re-resolves at
 * exec time, and nothing reads a base or candidate gitlink: a gitlink is not a
 * trust boundary.
 */
import { accessSync, constants, statSync } from "node:fs"
import { isAbsolute } from "node:path"

export const YRD_GIT_SUPER_BIN = "YRD_GIT_SUPER_BIN"
export const YRD_GIT_SUPER_SHA = "YRD_GIT_SUPER_SHA"

export type FrozenGitSuper = Readonly<{ bin: string; sha: string }>

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u

function refuse(message: string): never {
  throw new Error(`yrd: ${message}`)
}

/**
 * Read and validate the launcher's frozen git-super, or `undefined` when the
 * launcher set neither variable (a bare library call, e.g. a test or a seat
 * composing directly). A partially set or unusable selection refuses loudly:
 * a half-declared tool is a configuration defect, never a reason to fall back.
 */
export function frozenGitSuperSelection(env: NodeJS.ProcessEnv): FrozenGitSuper | undefined {
  const rawBin = env[YRD_GIT_SUPER_BIN]
  const rawSha = env[YRD_GIT_SUPER_SHA]
  if (rawBin === undefined && rawSha === undefined) return undefined
  const bin = rawBin?.trim()
  const sha = rawSha?.trim()
  if (bin === undefined || bin === "" || sha === undefined || sha === "") {
    refuse(
      `incomplete frozen git-super selection: ${YRD_GIT_SUPER_BIN}=${JSON.stringify(rawBin ?? null)} ${YRD_GIT_SUPER_SHA}=${JSON.stringify(
        rawSha ?? null,
      )}; the launcher sets both or neither`,
    )
  }
  if (!isAbsolute(bin)) {
    refuse(
      `frozen git-super ${bin} is not an absolute path; the launcher exports its own physical landing root's binary`,
    )
  }
  if (!OID.test(sha)) refuse(`frozen git-super sha ${sha} is not a commit oid`)
  let stat
  try {
    stat = statSync(bin)
  } catch {
    refuse(`frozen git-super ${bin} is missing; the landing root materialized no git-super at that path`)
  }
  if (!stat.isFile()) refuse(`frozen git-super ${bin} is not a regular file`)
  try {
    accessSync(bin, constants.X_OK)
  } catch {
    refuse(`frozen git-super ${bin} is not executable; run: chmod +x ${bin}`)
  }
  return Object.freeze({ bin, sha })
}

/**
 * The frozen selection, or a loud refusal when the launcher set none. This is
 * the queue's only git-super channel: the selected tool is invoked directly, so
 * no ambient PATH, base pin or candidate gitlink substitutes another binary.
 */
export function requireFrozenGitSuper(env: NodeJS.ProcessEnv, why: string): FrozenGitSuper {
  const selection = frozenGitSuperSelection(env)
  if (selection === undefined) {
    refuse(
      `no frozen git-super selection for ${why}: ${YRD_GIT_SUPER_BIN}/${YRD_GIT_SUPER_SHA} are unset. The queue must be launched by tools/yrd-runtime.mjs, which freezes its own physical landing root's git-super; there is no ambient-PATH or candidate fallback (27098)`,
    )
  }
  return selection
}

/**
 * Append `key=value` pairs to an environment's `GIT_CONFIG_*` composition, after
 * any entries `gitEnvironment` already wrote. The direct git-super binary takes
 * no `-c` prefix (git is not there to parse it), so the queue's `core.hooksPath`
 * travels as configuration the binary's own git children honour.
 */
export function withGitConfig(env: NodeJS.ProcessEnv, pairs: readonly string[]): NodeJS.ProcessEnv {
  if (pairs.length === 0) return env
  const declared = Number(env.GIT_CONFIG_COUNT ?? "0")
  const count = Number.isInteger(declared) && declared >= 0 ? declared : 0
  const composed: NodeJS.ProcessEnv = { ...env, GIT_CONFIG_COUNT: String(count + pairs.length) }
  pairs.forEach((pair, offset) => {
    const equals = pair.indexOf("=")
    composed[`GIT_CONFIG_KEY_${count + offset}`] = equals === -1 ? pair : pair.slice(0, equals)
    composed[`GIT_CONFIG_VALUE_${count + offset}`] = equals === -1 ? "" : pair.slice(equals + 1)
  })
  return composed
}
