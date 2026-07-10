import distribution from "../../../package.json" with { type: "json" }

/** The git-yrd distribution version, embedded by the production bundle. */
export const YRD_VERSION = distribution.version
