import { getOnboardingApi } from "@/features/onboarding/api";
import { SecretsSummary } from "@/features/onboarding/preview-view";
import { ErrorState } from "@/components/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useAsync } from "@/lib/use-async";

/** Which secrets the project's workflows need, from `preview_workflows`. Names only. */
export function ProjectSecretsSection({ org, project }: { org: string; project: string }) {
  const api = getOnboardingApi();
  const preview = useAsync(() => api.previewWorkflows({ org, project }), [api, org, project]);
  return (
    <div className="mt-8">
      <h2 className="mb-3 text-sm font-semibold">Secrets the workflows need</h2>
      {preview.error ? (
        <ErrorState message={preview.error} onRetry={preview.reload} />
      ) : preview.data ? (
        <SecretsSummary preview={preview.data} />
      ) : (
        <Skeleton className="h-16 w-full" />
      )}
    </div>
  );
}
