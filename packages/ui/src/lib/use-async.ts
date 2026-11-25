import { useCallback, useEffect, useState } from "react";

export type Async<T> = {
  data: T | null;
  error: string | null;
  /** The `code` of an ApiError, when the failure had one. */
  errorCode: string | null;
  loading: boolean;
  reload: () => void;
};

const errorCodeOf = (e: unknown): string | null =>
  e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string"
    ? (e as { code: string }).code
    : null;

/** Run an async loader when `deps` change; keeps the last result while a reload is in flight. */
export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): Async<T> {
  const [state, setState] = useState<{
    data: T | null;
    error: string | null;
    errorCode: string | null;
    loading: boolean;
  }>({
    data: null,
    error: null,
    errorCode: null,
    loading: true,
  });
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    load().then(
      (data) => live && setState({ data, error: null, errorCode: null, loading: false }),
      (e: unknown) =>
        live &&
        setState({
          data: null,
          error: e instanceof Error ? e.message : "Request failed",
          errorCode: errorCodeOf(e),
          loading: false,
        }),
    );
    return () => {
      live = false;
    };
  }, [...deps, n]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { ...state, reload };
}
