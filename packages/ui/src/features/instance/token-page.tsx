import { useState } from "react";
import { getInstanceApi } from "@/api/instance";
import { Button } from "@/components/ui/button";
import { completeRotation } from "@/lib/instance-auth";
import { Page, PageHeader, Refusal } from "./parts";
import { useAction } from "./use-action";

/** The token in use (`instance_whoami`) and its rotation (`rotate_instance_token`). */
export function InstanceTokenPage() {
  const api = getInstanceApi();
  const [confirm, setConfirm] = useState(false);
  const rotate = useAction(() => api.rotateToken());
  return (
    <Page>
      <PageHeader title="Instance token">
        Rotating mints a new token and revokes the one this session signed in with, in one step.
      </PageHeader>
      <div className="mt-6 space-y-3 rounded-xl border border-line p-4">
        {confirm ? (
          <>
            <p role="alert" className="text-sm">
              The token this session uses is revoked at once. The new secret is shown one time: copy
              it before you leave the next screen.
            </p>
            <div className="flex gap-2">
              <Button
                variant="destructive"
                disabled={rotate.busy}
                onClick={() =>
                  void rotate.run().then((r) => {
                    if (r) completeRotation(r.secret);
                  })
                }
              >
                {rotate.busy ? "Rotating" : "Rotate and revoke this token"}
              </Button>
              <Button variant="ghost" disabled={rotate.busy} onClick={() => setConfirm(false)}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <Button variant="secondary" onClick={() => setConfirm(true)}>
            Rotate token
          </Button>
        )}
        <Refusal message={rotate.error} />
      </div>
    </Page>
  );
}
