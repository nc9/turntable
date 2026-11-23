import { useState } from "react";
import { getInstanceApi, type BackupResult } from "@/api/instance";
import { Button } from "@/components/ui/button";
import { formatSize } from "@/lib/format";
import { sanitize } from "@/log/parser";
import { Page, PageHeader, Refusal } from "./parts";
import { useAction } from "./use-action";

/**
 * Backups: runs `db_backup` and shows where the file is, how big and its sha256. The file stays
 * on the host under the data dir; this page never offers it for download.
 */
export function InstanceBackupsPage() {
  const api = getInstanceApi();
  const [done, setDone] = useState<BackupResult | null>(null);
  const backup = useAction(() => api.dbBackup());
  return (
    <Page>
      <PageHeader title="Backups">
        Writes a consistent copy of the SQLite database to a new file under the data dir. Use it
        before an upgrade that applies migrations.
      </PageHeader>
      <div className="mt-6 space-y-3">
        <Button
          disabled={backup.busy}
          onClick={() =>
            void backup.run().then((r) => {
              if (r) setDone(r);
            })
          }
        >
          {backup.busy ? "Backing up" : "Back up now"}
        </Button>
        <Refusal message={backup.error} />
        {done ? (
          <dl
            data-result="backup"
            className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-xl border border-line p-4 text-sm"
          >
            <dt className="text-dim">Path</dt>
            <dd className="break-all font-mono text-[13px]">{sanitize(done.path)}</dd>
            <dt className="text-dim">Size</dt>
            <dd className="font-mono text-[13px]">
              {formatSize(done.sizeBytes)} ({done.sizeBytes} bytes)
            </dd>
            <dt className="text-dim">sha256</dt>
            <dd className="break-all font-mono text-[13px]">{sanitize(done.sha256)}</dd>
          </dl>
        ) : null}
      </div>
    </Page>
  );
}
