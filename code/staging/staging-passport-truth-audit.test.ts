import { describe, expect, it } from "vitest";

import {
  auditPassportAgainstGeoSnapshot,
  scanInterpretationForWrongSignHints,
  signRuFromLongitude,
} from "./staging-passport-truth-audit.js";
import type { AstroPassport } from "../agentic_rag/astro-passport.js";

function planet(
  name: string,
  nameEn: string,
  sign: string,
  house: number
): AstroPassport["planets"][number] {
  return {
    name,
    nameEn,
    sign,
    house,
    degree: 12,
    nakshatra: "Test",
    retrograde: false,
    dignity: "neutral",
  };
}

function minimalPassport(overrides: Partial<AstroPassport>): AstroPassport {
  const base: AstroPassport = {
    lagna: {
      sign: "Лев",
      signEn: "Leo",
      degree: 29,
      nakshatra: "Uttara",
    },
    planets: [
      planet("Солнце", "Sun", "Дева", 2),
      planet("Луна", "Moon", "Рыбы", 8),
      planet("Марс", "Mars", "Скорпион", 4),
      planet("Меркурий", "Mercury", "Дева", 2),
      planet("Юпитер", "Jupiter", "Стрелец", 5),
      planet("Венера", "Venus", "Рак", 12),
      planet("Сатурн", "Saturn", "Стрелец", 5),
      planet("Раху", "Rahu", "Овен", 9),
      planet("Кету", "Ketu", "Весы", 3),
    ],
    yogas: [],
    shadbala: {
      strongest: null,
      weakest: null,
      rankings: [],
      ishta_kashta: null,
    },
    vargas: { D9: null, D10: null, D7: null },
    ashtakavarga: null,
    dashaCurrentPeriod: null,
    avasthas: null,
    interpretation: "",
    gandanta: null,
    metadata: {
      generatedAt: "2026-01-01T00:00:00.000Z",
      geoFingerprint: "fp",
      modelUsed: "test",
      instrumentsUsed: [],
    },
    psychological_profile: null,
  };
  return { ...base, ...overrides, planets: overrides.planets ?? base.planets };
}

describe("signRuFromLongitude", () => {
  it("maps ecliptic longitude to Russian sign", () => {
    expect(signRuFromLongitude(0)).toBe("Овен");
    expect(signRuFromLongitude(29.9)).toBe("Овен");
    expect(signRuFromLongitude(30)).toBe("Телец");
    expect(signRuFromLongitude(345)).toBe("Рыбы");
  });
});

describe("auditPassportAgainstGeoSnapshot", () => {
  const geo = JSON.stringify({
    ascendant: 120 + 28,
    planets: {
      Sun: { longitude: 150 + 10, house: 2 },
      Moon: { longitude: 330 + 14.5, house: 8 },
      Mars: { longitude: 210 + 5, house: 4 },
      Mercury: { longitude: 150 + 8, house: 2 },
      Jupiter: { longitude: 240 + 12, house: 5 },
      Venus: { longitude: 90 + 10, house: 12 },
      Saturn: { longitude: 240 + 18, house: 5 },
      Rahu: { longitude: 10, house: 9 },
      Ketu: { longitude: 190, house: 3 },
    },
  });

  it("returns OK when passport matches geo signs", () => {
    const p = minimalPassport({});
    const { ok, markdown } = auditPassportAgainstGeoSnapshot({
      geoResponseJson: geo,
      passportJson: JSON.stringify(p),
    });
    expect(ok).toBe(true);
    expect(markdown).toContain("STAGING_PASSPORT_TRUTH_STATUS:** OK");
  });

  it("flags lagna / planet sign mismatches vs geo", () => {
    const p = minimalPassport({
      lagna: { ...minimalPassport({}).lagna, sign: "Дева" },
    });
    const { ok, markdown } = auditPassportAgainstGeoSnapshot({
      geoResponseJson: geo,
      passportJson: JSON.stringify(p),
    });
    expect(ok).toBe(false);
    expect(markdown).toContain("Лагна");
    expect(markdown).toContain("STAGING_PASSPORT_TRUTH_STATUS:** FAIL");
  });

  it("flags interpretation phrases contradicting structured Moon sign", () => {
    const p = minimalPassport({
      interpretation: "Луна в Овне даёт импульсивность.",
    });
    const { ok, markdown } = auditPassportAgainstGeoSnapshot({
      geoResponseJson: geo,
      passportJson: JSON.stringify(p),
    });
    expect(ok).toBe(false);
    expect(markdown).toContain("Эвристика:");
    expect(markdown).toMatch(/Луна|Овен/i);
  });

  it("flags yoga brief contradicting structured Moon sign", () => {
    const p = minimalPassport({
      interpretation: "",
      yogas: [
        {
          name: "TestYoga",
          strength: null,
          planets: ["Moon"],
          brief: "Луна в Овне даёт импульсивность.",
        },
      ],
    });
    const { ok, markdown } = auditPassportAgainstGeoSnapshot({
      geoResponseJson: geo,
      passportJson: JSON.stringify(p),
    });
    expect(ok).toBe(false);
    expect(markdown).toContain("Эвристика:");
  });

  it("does not treat divisional lagna phrases in varga keyPlacements as D1 contradictions", () => {
    const p = minimalPassport({
      interpretation: "Лагна в знаке Льва.",
      vargas: {
        D9: {
          lagnaSign: "Стрелец",
          keyPlacements: "Навамша: лагна в Стрельце. Дашамша: лагна в Тельце. Саптамша: лагна в Водолее.",
        },
        D10: null,
        D7: null,
      },
    });
    const { ok, markdown } = auditPassportAgainstGeoSnapshot({
      geoResponseJson: geo,
      passportJson: JSON.stringify(p),
    });
    expect(ok).toBe(true);
    expect(markdown).toContain("STAGING_PASSPORT_TRUTH_STATUS:** OK");
  });
});

describe("scanInterpretationForWrongSignHints", () => {
  it("does not flag when phrase matches structured sign", () => {
    const p = minimalPassport({});
    const hints = scanInterpretationForWrongSignHints("Луна в Рыбах даёт чувствительность.", p);
    expect(hints.length).toBe(0);
  });
});
