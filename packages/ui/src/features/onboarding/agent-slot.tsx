// RESERVED SLOT: "Connect an agent" (lane D). The wizard renders <AgentSlot> at the end of the
// finish screen. It stays empty until the server publishes the operation lane D's step calls
// (`create_onboarding_agent_token`, read from the OpenAPI document), so this page never calls an
// operation that does not exist. Lane D replaces `AgentStepPlaceholder` with its step; nothing
// else in the wizard needs to change.
import { useState } from "react";
import type { OnboardingApi } from "@/api/onboarding";
import { Button } from "@/components/ui/button";
import { useAsync } from "@/lib/use-async";

export const AGENT_OPERATION = "create_onboarding_agent_token";

export function AgentSlot({ api, org }: { api: OnboardingApi; org: string }) {
  const available = useAsync(() => api.hasOperation(AGENT_OPERATION), [api]);
  const [open, setOpen] = useState(false);
  if (!available.data) return null;
  return (
    <div data-slot="connect-agent" className="space-y-1.5">
      <h3 className="text-[13px] font-semibold">Connect an agent</h3>
      {open ? (
        <AgentStepPlaceholder org={org} />
      ) : (
        <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
          Connect an agent
        </Button>
      )}
    </div>
  );
}

/** Lane D: replace this with the connect-an-agent step. */
function AgentStepPlaceholder({ org }: { org: string }) {
  return <p className="text-[13px] text-dim">The agent step for {org} is not built yet.</p>;
}
