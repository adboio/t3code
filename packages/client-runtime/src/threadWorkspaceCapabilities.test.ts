import type { OrchestrationSession, ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadWorkspaceCapabilities } from "./threadWorkspaceCapabilities.ts";

const provider = (execution?: "local" | "remote") =>
  ({ instanceId: "provider", execution }) as ServerProvider;
const session = (status: OrchestrationSession["status"]) => ({ status }) as OrchestrationSession;

describe("threadWorkspaceCapabilities", () => {
  it("does not expose local workspace actions before provider capabilities load", () => {
    expect(
      threadWorkspaceCapabilities({
        providers: null,
        providerInstanceId: "provider",
        session: session("running"),
      }),
    ).toEqual({ runsRemotely: false, hasLocalWorkspace: false, canStopSession: false });
  });

  it("exposes local workspace actions for local and legacy providers", () => {
    for (const execution of [undefined, "local"] as const) {
      expect(
        threadWorkspaceCapabilities({
          providers: [provider(execution)],
          providerInstanceId: "provider",
          session: session("running"),
        }).hasLocalWorkspace,
      ).toBe(true);
    }
  });

  it("exposes stop without local workspace actions for active remote sessions", () => {
    expect(
      threadWorkspaceCapabilities({
        providers: [provider("remote")],
        providerInstanceId: "provider",
        session: session("ready"),
      }),
    ).toEqual({ runsRemotely: true, hasLocalWorkspace: false, canStopSession: true });
    expect(
      threadWorkspaceCapabilities({
        providers: [provider("remote")],
        providerInstanceId: "provider",
        session: undefined,
      }).canStopSession,
    ).toBe(false);
  });
});
