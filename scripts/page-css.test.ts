import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PAGE_TOKENS_CSS } from "../packages/core/src/pages/page-tokens.generated";
import { OUT, render, renderTokens } from "./page-css";

describe("server-page CSS tokens", () => {
  test("the generated module is current with packages/ui/src/styles.css", () => {
    expect(readFileSync(OUT, "utf8")).toBe(render());
  });

  test("light and dark carry the UI's accent, radius and fonts", () => {
    const { light, dark } = renderTokens(
      readFileSync(new URL("../packages/ui/src/styles.css", import.meta.url), "utf8"),
    );
    expect(light).toContain("--accent:#0070f3");
    expect(light).toContain("--radius:8px");
    expect(light).toContain('--font-mono:"Geist Mono",ui-monospace');
    expect(dark).toContain("--accent:#3291ff");
    expect(PAGE_TOKENS_CSS).toContain(light);
  });
});
