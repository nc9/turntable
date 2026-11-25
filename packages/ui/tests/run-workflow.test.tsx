import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DispatchInput, PreviewWorkflow } from "../src/api/onboarding";
import { DispatchForm } from "../src/features/runs/run-workflow";
import { dispatchWorkflows, initialInputs, validateDispatch } from "../src/lib/dispatch-form";

const wf = (path: string, dispatch_inputs: DispatchInput[] | null): PreviewWorkflow => ({
  path,
  name: path,
  triggers: [],
  ingested: true,
  too_large: false,
  dispatch_inputs,
  jobs: [],
});
const INPUTS = [
  {
    name: "channel",
    type: "choice" as const,
    required: false,
    default: "stable",
    options: ["stable", "beta"],
    description: null,
  },
  {
    name: "dry_run",
    type: "boolean" as const,
    required: false,
    default: null,
    options: [],
    description: null,
  },
  {
    name: "version",
    type: "string" as const,
    required: true,
    default: null,
    options: [],
    description: "Version to cut",
  },
];

describe("run workflow form (#617)", () => {
  test("only workflows with workflow_dispatch are offered", () => {
    const all = [wf("a.yml", null), wf("b.yml", INPUTS), wf("c.yml", [])];
    expect(dispatchWorkflows(all).map((w) => w.path)).toEqual(["b.yml", "c.yml"]);
  });

  test("renders a select for choice, a checkbox for boolean, text for string; ref prefilled", () => {
    const html = renderToStaticMarkup(
      <DispatchForm
        workflows={dispatchWorkflows([wf("release.yml", INPUTS)])}
        defaultBranch="main"
        busy={false}
        error={null}
        onSubmit={() => {}}
      />,
    );
    expect(html).toMatch(/<select[^>]*id="dispatch-input-channel"/);
    expect(html).toContain('<option value="beta">beta</option>');
    expect(html).toMatch(
      /<input[^>]*id="dispatch-input-dry_run"[^>]*type="checkbox"|<input[^>]*type="checkbox"[^>]*id="dispatch-input-dry_run"/,
    );
    expect(html).toMatch(/<input[^>]*id="dispatch-input-version"/);
    expect(html).toMatch(/id="dispatch-ref"[^>]*value="main"|value="main"[^>]*id="dispatch-ref"/);
  });

  test("starting values and validation", () => {
    const values = initialInputs(INPUTS);
    expect(values).toEqual({ channel: "stable", dry_run: "false", version: "" });
    expect(validateDispatch(INPUTS, "main", values)).toEqual({ version: "Required." });
    expect(validateDispatch(INPUTS, " ", { ...values, version: "1", channel: "x" })).toEqual({
      ref: "Enter a branch or tag.",
      channel: "Pick one of the options.",
    });
    expect(validateDispatch(INPUTS, "main", { ...values, version: "1" })).toEqual({});
  });
});
