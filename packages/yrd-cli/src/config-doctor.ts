import { diagnoseFlowPin, type FlowDiagnostic, type FlowPin, type YrdConfig } from "@yrd/config"

type FlowOwner = Readonly<{ id: string; flow?: FlowPin }>

export type YrdFlowDoctorFinding = FlowDiagnostic & Readonly<{ owner: string; ownerKind: "PR" | "Run" }>

/** Inspect only durable pins; config is capability authority, never runtime
 * state. Keeping this projection pure makes `doctor --json` deterministic. */
export function diagnoseYrdFlows(
  durable: Readonly<{ prs: readonly FlowOwner[]; runs: readonly FlowOwner[] }>,
  config: YrdConfig,
): readonly YrdFlowDoctorFinding[] {
  const inspect = (ownerKind: YrdFlowDoctorFinding["ownerKind"], owners: readonly FlowOwner[]) =>
    owners.flatMap((owner) =>
      owner.flow === undefined
        ? []
        : diagnoseFlowPin(owner.flow, config).map((finding) => ({ ...finding, owner: owner.id, ownerKind })),
    )
  return [...inspect("PR", durable.prs), ...inspect("Run", durable.runs)]
}
