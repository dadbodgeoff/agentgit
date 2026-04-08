import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConnectorBootstrapPanel } from "@/features/shared/connector-bootstrap-panel";

describe("connector bootstrap panel", () => {
  it("renders the bootstrap command, token actions, and waiting status", () => {
    render(
      <ConnectorBootstrapPanel
        bootstrapDetails={{
          bootstrapToken: "agcbt_test_123",
          workspaceId: "ws_acme_01",
          workspaceSlug: "acme-platform",
          expiresAt: "2026-04-07T19:00:00Z",
          commandHint: "agentgit-cloud-connector bootstrap --bootstrap-token agcbt_test_123",
        }}
        waitingForConnection
      />,
    );

    expect(screen.getByText("agentgit-cloud-connector bootstrap --bootstrap-token agcbt_test_123")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy token" })).toBeTruthy();
    expect(screen.getByText("Waiting for heartbeat")).toBeTruthy();
  });
});
