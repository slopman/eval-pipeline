import { describe, expect, it } from "vitest";

import { computeStagingAutomatedChecks } from "./staging-automated-checks.js";

describe("computeStagingAutomatedChecks", () => {
  it("flags empty draft", () => {
    const c = computeStagingAutomatedChecks({ draft: "   " });
    expect(c.find((x) => x.id === "draft_non_empty")?.passed).toBe(false);
  });

  it("runs lagna heuristic when geo digest mentions lagna", () => {
    const c = computeStagingAutomatedChecks({
      clientGeoDigest: "Lagna in Leo",
      draft: "No astrology here.",
    });
    const lagna = c.find((x) => x.id === "draft_mentions_lagna_when_geo_digest_does");
    expect(lagna).toBeDefined();
    expect(lagna!.passed).toBe(false);
  });

  it("passes lagna heuristic when draft echoes keywords", () => {
    const c = computeStagingAutomatedChecks({
      clientGeoDigest: "Ascendant details",
      draft: "The ascendant confirms …",
    });
    const lagna = c.find((x) => x.id === "draft_mentions_lagna_when_geo_digest_does");
    expect(lagna?.passed).toBe(true);
  });
});
