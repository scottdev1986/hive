import type { ProcessIdentity } from "./terminal-host-contract";

// Live Workspace inventory identity. The VisibilityTerminalHost admission
// profile that used to live in this file is retired; production admits
// through WorkspaceVisibilityAuthority and holds the lease open with touch().
export type VisibilitySourceIdentity = Readonly<{
  sessionId: string;
  process: ProcessIdentity;
}>;
