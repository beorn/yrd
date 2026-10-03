import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

/**
 * The superproject's sibling checkout, `vendor/git-super/bin`. Inside hh this sibling is the pin every
 * candidate workspace resolves, so a test that names git-super's bin runs the version the queue runs.
 */
export const siblingGitSuperBin = resolve(import.meta.dirname, "../../../git-super/bin")
const yrdRoot = resolve(import.meta.dirname, "../..")
export const superprojectRoot = execFileSync("git", ["-C", yrdRoot, "rev-parse", "--show-superproject-working-tree"], {
  encoding: "utf8",
}).trim()

/**
 * The one lookup of git-super's bin directory for this repository's tests. Inside the superproject it is the
 * sibling checkout. A standalone clone has no sibling, so the git-super this repository depends on (its
 * package.json pin) supplies it. A missing bin fails loudly and names both places it looked.
 */
function standaloneGitSuperBin(): string {
  const packagePath = realpathSync(Bun.resolveSync("git-super/package.json", yrdRoot))
  const installed = relative(join(realpathSync(yrdRoot), "node_modules"), packagePath)
  if (installed === ".." || installed.startsWith("../") || isAbsolute(installed)) {
    throw new Error(
      `standalone yrd requires its own installed git-super package under ${yrdRoot}/node_modules; resolved ${packagePath}`,
    )
  }
  return join(dirname(packagePath), "bin")
}

export const gitSuperBin = superprojectRoot !== "" ? siblingGitSuperBin : standaloneGitSuperBin()

if (!existsSync(join(gitSuperBin, "git-super"))) {
  throw new Error(`git-super bin not found for ${superprojectRoot || "standalone yrd"}: ${gitSuperBin}/git-super`)
}

function standaloneGitSuperSha(): string {
  const manifest = JSON.parse(readFileSync(join(yrdRoot, "package.json"), "utf8")) as {
    overrides?: Record<string, unknown>
  }
  const declared = manifest.overrides?.["git-super"]
  const oid = typeof declared === "string" ? /^github:beorn\/git-super#([a-f0-9]{40})$/u.exec(declared)?.[1] : undefined
  if (oid === undefined) {
    throw new Error(
      `standalone yrd package.json requires an exact full-OID github:beorn/git-super override: ${yrdRoot}`,
    )
  }
  const lock = Bun.JSON5.parse(readFileSync(join(yrdRoot, "bun.lock"), "utf8")) as {
    overrides?: Record<string, unknown>
  }
  if (lock.overrides?.["git-super"] !== declared) {
    throw new Error(`standalone yrd git-super override differs between package.json and bun.lock: ${yrdRoot}`)
  }
  return oid
}

// Installed GitHub archives have no Git metadata; git -C there sees Yrd's HEAD.
// Frozen install supplies archive provenance; the matching declaration supplies identity.
export const gitSuperSha =
  superprojectRoot !== ""
    ? execFileSync("git", ["-C", gitSuperBin, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    : standaloneGitSuperSha()
