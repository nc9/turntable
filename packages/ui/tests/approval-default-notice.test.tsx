import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalDefaultNotice } from "../src/features/runs/approval-default-notice";

const pol = (source: "configured" | "default") => [
  { environment: "production", required: 1, allowAuthorApproval: true, source },
  { environment: "release", required: 1, allowAuthorApproval: true, source },
];

describe("approval default notice", () => {
  test("solo says who the only approver is and what changes", () => {
    const html = renderToStaticMarkup(
      <ApprovalDefaultNotice mode="solo" policies={pol("default")} />,
    );
    expect(html).toContain("Solo: you are the only person who can approve");
    expect(html).toContain('data-approval-default="solo"');
  });
  test("strict explains the stronger default and offers an explicit policy", () => {
    const html = renderToStaticMarkup(
      <ApprovalDefaultNotice mode="strict" policies={pol("default")} />,
    );
    expect(html).toContain("need two people");
    expect(html).toContain("Settings, Approvals");
  });
  test("an explicit policy shows no default notice", () => {
    expect(
      renderToStaticMarkup(<ApprovalDefaultNotice mode="solo" policies={pol("configured")} />),
    ).toBe("");
  });
});
