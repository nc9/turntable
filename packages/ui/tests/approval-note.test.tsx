import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalNote } from "../src/features/runs/trust";

test("a label approval shows the label and who added it", () => {
  const html = renderToStaticMarkup(
    <ApprovalNote
      run={{
        approval: {
          by: "@maint",
          at: 1,
          via: { kind: "label", label: "ci:approved", eventId: "9" },
        },
      }}
    />,
  );
  expect(html).toContain("Approved by label ci:approved, from @maint");
});

test("a signed approval and a run with none", () => {
  expect(
    renderToStaticMarkup(<ApprovalNote run={{ approval: { by: "alice", at: 1 } }} />),
  ).toContain("Approved by alice");
  expect(renderToStaticMarkup(<ApprovalNote run={{}} />)).toBe("");
});
