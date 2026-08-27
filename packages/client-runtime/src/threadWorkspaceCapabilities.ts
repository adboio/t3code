import {
  providerExecutesRemotely,
  type OrchestrationSession,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

export interface ThreadWorkspaceCapabilities {
  readonly runsRemotely: boolean;
  readonly hasLocalWorkspace: boolean;
  readonly canStopSession: boolean;
}

export function threadWorkspaceCapabilities(input: {
  readonly providers: ReadonlyArray<ServerProvider> | null | undefined;
  readonly providerInstanceId: ProviderInstanceId | string | null | undefined;
  readonly session: OrchestrationSession | null | undefined;
}): ThreadWorkspaceCapabilities {
  const provider = input.providers?.find(
    (candidate) => candidate.instanceId === input.providerInstanceId,
  );
  const runsRemotely = provider !== undefined && providerExecutesRemotely(provider);
  return {
    runsRemotely,
    hasLocalWorkspace: provider !== undefined && !runsRemotely,
    canStopSession: runsRemotely && input.session != null && input.session.status !== "stopped",
  };
}
