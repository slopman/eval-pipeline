import type { StagingAutomatedCheckRecord } from "./run-manifest.js";

export function computeStagingAutomatedChecks(
  finalState: Record<string, unknown>
): StagingAutomatedCheckRecord[] {
  const checks: StagingAutomatedCheckRecord[] = [];
  const draft = typeof finalState.draft === "string" ? finalState.draft : "";
  const draftNonEmpty = draft.trim().length > 0;
  checks.push({
    id: "draft_non_empty",
    passed: draftNonEmpty,
    detail: draftNonEmpty ? undefined : "final state has empty draft",
  });

  const geo = typeof finalState.clientGeoDigest === "string" ? finalState.clientGeoDigest : "";
  const digestMentionsLagna = /\b(lagna|ascendant|асцендент|лагна)\b/i.test(geo);
  const draftMentionsLagna = /\b(lagna|ascendant|асцендент|лагна)\b/i.test(draft);
  if (digestMentionsLagna) {
    checks.push({
      id: "draft_mentions_lagna_when_geo_digest_does",
      passed: draftMentionsLagna,
      detail: draftMentionsLagna
        ? undefined
        : "clientGeoDigest references lagna/asc but draft has no matching keywords (heuristic)",
    });
  }

  const passportTruthMd =
    typeof finalState.stagingPassportTruthMd === "string"
      ? finalState.stagingPassportTruthMd.trim()
      : "";
  if (passportTruthMd.length > 0) {
    const ok = finalState.stagingPassportTruthOk === true;
    checks.push({
      id: "staging_passport_truth_ok",
      passed: ok,
      detail: ok
        ? undefined
        : "Паспорт vs geo_snapshots или эвристика interpretation — см. stagingPassportTruthMd в манифесте",
    });
  }

  return checks;
}
