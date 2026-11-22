// TODO(#17): read the caller's role from the session and call the approve operation. Until the
// approvals API exists, nobody can approve from the UI, so the answer is always "not allowed".
export function useCanApproveUntrusted(): { allowed: boolean; reason: string } {
  return {
    allowed: false,
    reason: "Approving needs the operator role. The approvals API (#17) is not available yet.",
  };
}
