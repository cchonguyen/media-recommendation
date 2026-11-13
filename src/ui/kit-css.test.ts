import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUNDLE_CSS, TOKENS_CSS } from "./kit-css.generated";

const read = (name: string) =>
  readFileSync(new URL(`../../.harness/design-system/${name}`, import.meta.url), "utf8");
const DRIFT = "Kit CSS drifted. Run: node scripts/build-kit-css.mjs";

describe("kit CSS", () => {
  it("TOKENS_CSS matches tokens.css", () => {
    expect(TOKENS_CSS === read("tokens.css"), DRIFT).toBe(true);
  });
  it("BUNDLE_CSS matches bundle.css", () => {
    expect(BUNDLE_CSS === read("bundle.css"), DRIFT).toBe(true);
  });
  it("tokens contain azure and light scheme", () => {
    expect(TOKENS_CSS).toContain("--neon-azure");
    expect(TOKENS_CSS).toContain("prefers-color-scheme: light");
  });
  it("bundle contains azure accent and dialog", () => {
    expect(BUNDLE_CSS).toContain('[data-accent="azure"]');
    expect(BUNDLE_CSS).toContain(".ui-dialog");
  });
});
