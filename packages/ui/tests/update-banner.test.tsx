import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BuildVersionLabel, UpdateBanner, UpdateBannerView } from "../src/components/update-banner";

test("the banner is a polite status with Refresh and Dismiss buttons", () => {
  const html = renderToStaticMarkup(
    <UpdateBannerView version="0.1.0-dev8+aaaaaaaa" onRefresh={() => {}} onDismiss={() => {}} />,
  );
  expect(html).toContain('role="status"');
  expect(html).toContain('aria-live="polite"');
  expect(html).not.toContain('role="alert"');
  expect(html).toContain("A new version of Turntable is available");
  expect(html).toContain("0.1.0-dev8");
  expect(html).not.toContain("+aaaaaaaa");
  expect(html).toMatch(/<button[^>]*>Refresh<\/button>/);
  expect(html).toMatch(/<button[^>]*>Dismiss<\/button>/);
});

test("nothing renders when there is no update", () => {
  expect(renderToStaticMarkup(<UpdateBanner />)).toBe("");
});

test("the version label shows the trimmed version with the full string on hover", () => {
  const html = renderToStaticMarkup(
    <BuildVersionLabel version="0.1.0-dev7+594b21af" sha="594b21af0123" />,
  );
  expect(html).toContain("Turntable 0.1.0-dev7");
  expect(html).toContain('title="0.1.0-dev7+594b21af, sha 594b21af0123"');
});

test("the version label is hidden in a dev build", () => {
  expect(renderToStaticMarkup(<BuildVersionLabel version="" />)).toBe("");
  expect(renderToStaticMarkup(<BuildVersionLabel />)).toBe("");
});
