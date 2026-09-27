import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

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
export const gitSuperBin =
  superprojectRoot !== ""
    ? siblingGitSuperBin
    : join(dirname(fileURLToPath(import.meta.resolve("git-super/package.json"))), "bin")

if (!existsSync(join(gitSuperBin, "git-super"))) {
  throw new Error(`git-super bin not found for ${superprojectRoot || "standalone yrd"}: ${gitSuperBin}/git-super`)
}
