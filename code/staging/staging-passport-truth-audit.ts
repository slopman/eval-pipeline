/**
 * Стенд: детерминированная сверка астропаспорта с geo_snapshots.response_json (источник истины движка)
 * + эвристика «проза радикса ↔ структура D1» (interpretation / йоги / psych; без варг — там свои лагны дробных карт).
 */
import { AstroPassportSchema, type AstroPassport } from "../agentic_rag/astro-passport.js";

const SIGNS_RU = [
  "Овен",
  "Телец",
  "Близнецы",
  "Рак",
  "Лев",
  "Дева",
  "Весы",
  "Скорпион",
  "Стрелец",
  "Козерог",
  "Водолей",
  "Рыбы",
] as const;

type GeoPlanet = {
  longitude: number;
  house?: number;
  is_retrograde?: boolean;
};

type GeoTruth = {
  ascendant?: number;
  planets?: Record<string, GeoPlanet>;
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function signRuFromLongitude(longitude: number): string {
  const i = Math.floor(((longitude % 360) + 360) % 360 / 30) % 12;
  return SIGNS_RU[i] ?? "?";
}

function normalizeRu(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function signsMatch(passportSign: string, engineSignRu: string): boolean {
  const a = normalizeRu(passportSign);
  const b = normalizeRu(engineSignRu);
  if (a === b) return true;
  const enToRu: Record<string, string> = {
    aries: "овен",
    taurus: "телец",
    gemini: "близнецы",
    cancer: "рак",
    leo: "лев",
    virgo: "дева",
    libra: "весы",
    scorpio: "скорпион",
    sagittarius: "стрелец",
    capricorn: "козерог",
    aquarius: "водолей",
    pisces: "рыбы",
  };
  const maybeEn = enToRu[a];
  return Boolean(maybeEn && maybeEn === b);
}

function parseGeoTruth(responseJson: string): GeoTruth | null {
  try {
    const res = JSON.parse(responseJson) as GeoTruth;
    if (!res || typeof res !== "object") return null;
    return res;
  } catch {
    return null;
  }
}

function matchPlanetRow(passport: AstroPassport, engineKey: string) {
  const lower = engineKey.toLowerCase();
  return passport.planets.find(
    (p) =>
      p.nameEn?.trim().toLowerCase() === lower ||
      p.name?.trim().toLowerCase() === lower
  );
}

/**
 * Учитываем падежи после «в …» (Овен→Овне, Рыбы→Рыбах).
 * Эвристика: в тексте есть имя планеты (RU) и «в <Знак>», где знак ≠ структурному.
 */
function signPatternAfterV(sign: string): string {
  const table: Record<string, string> = {
    Овен: "Овн[аеиюяё]{1,2}",
    Телец: "Тельц[аеиюяё]*",
    Близнецы: "Близнец[аеиюяё]*",
    Рак: "Рак[аеиюяё]?",
    Лев: "Льв[аеиюяё]*",
    Дева: "Дев[аеиюяё]*",
    Весы: "Вес[аеиюяё]*",
    Скорпион: "Скорпион[аеиюяё]?",
    Стрелец: "Стрельц[аеиюяё]*",
    Козерог: "Козерог[аеиюяё]?",
    Водолей: "Водоле[ейяю]*",
    Рыбы: "Рыб[аеиюяё]*",
  };
  return table[sign] ?? escapeRegExp(sign);
}

/**
 * JS `\b` не считает кириллицу «границей слова». Якоря для совпадений в русском тексте.
 */
const NB = "(?:^|[^\\p{L}\\p{N}])";
const NA = "(?:[^\\p{L}\\p{N}]|$)";

export function collectPassportProseBlob(passport: AstroPassport): string {
  const chunks: string[] = [];
  if (passport.interpretation?.trim()) chunks.push(passport.interpretation.trim());
  for (const y of passport.yogas ?? []) {
    if (y?.brief?.trim()) chunks.push(y.brief.trim());
  }
  // Не включаем vargas.keyPlacements: там закономерно «лагна в Стрельце» (D9) при D1 Лев — не противоречие.
  if (passport.psychological_profile?.reasoning?.trim()) {
    chunks.push(passport.psychological_profile.reasoning.trim());
  }
  return chunks.join("\n\n");
}

export function scanInterpretationForWrongSignHints(
  interpretation: string,
  passport: AstroPassport
): string[] {
  // Ложные срабатывания возможны («аспект к Марсу в Овне») — строки hints намекают на ручную проверку.
  const text = interpretation.trim();
  if (!text) return [];

  const sentences = text.split(/\n+|(?<=[.!?])\s+/).filter((s) => s.trim().length > 8);
  const hints: string[] = [];

  for (const sent of sentences) {
    const sTrim = sent.trim();
    for (const pl of passport.planets) {
      const planetRu = pl.name?.trim();
      if (!planetRu || !sTrim.includes(planetRu)) continue;

      for (const wrongSign of SIGNS_RU) {
        if (signsMatch(pl.sign, wrongSign)) continue;
        const re = new RegExp(
          `${NB}${escapeRegExp(planetRu)}[^\\n]{0,120}?(?:\\s|^)в\\s+${signPatternAfterV(wrongSign)}${NA}`,
          "iu"
        );
        if (re.test(sTrim)) {
          hints.push(
            `Фраза с «${planetRu} … в ${wrongSign}» при структурном знаке **${pl.sign}** — возможное противоречие или ложное срабатывание (аспект к другой грахе); проверь контекст.`
          );
        }
      }
    }

    const lagnaRu = "Лагна";
    if (sTrim.includes(lagnaRu) || /лагн/i.test(sTrim)) {
      for (const wrongSign of SIGNS_RU) {
        if (signsMatch(passport.lagna.sign, wrongSign)) continue;
        const re = new RegExp(
          `${NB}(?:Лагна|лагна)[^\\n]{0,120}?(?:\\s|^)в\\s+${signPatternAfterV(wrongSign)}${NA}`,
          "iu"
        );
        if (re.test(sTrim)) {
          hints.push(
            `Фраза про лагну «в ${wrongSign}» при структурной лагне **${passport.lagna.sign}** — проверь текст (радикс, не дробная карта).`
          );
        }
      }
    }
  }

  return hints;
}

export type PassportTruthAuditResult = {
  ok: boolean;
  markdown: string;
};

/**
 * Сверка паспорта с JSON ответа geo (Swiss / calculate_geo_positions).
 */
export function auditPassportAgainstGeoSnapshot(params: {
  geoResponseJson: string;
  passportJson: string;
}): PassportTruthAuditResult {
  const geo = parseGeoTruth(params.geoResponseJson);
  const parsed = AstroPassportSchema.safeParse(JSON.parse(params.passportJson) as unknown);
  if (!parsed.success) {
    return {
      ok: false,
      markdown: [
        "## Паспорт ↔ geo (стенд)",
        "",
        "**Ошибка:** `passport_json` не парсится как `AstroPassportSchema`.",
        parsed.error.message.slice(0, 800),
      ].join("\n"),
    };
  }
  const passport = parsed.data;

  const lines: string[] = ["## Паспорт ↔ geo_snapshots (детерминированно)", ""];

  if (!geo) {
    lines.push("**Пропуск:** не удалось разобрать `response_json` geo.");
    return { ok: true, markdown: lines.join("\n") };
  }

  const mismatches: string[] = [];

  if (typeof geo.ascendant === "number") {
    const eng = signRuFromLongitude(geo.ascendant);
    if (!signsMatch(passport.lagna.sign, eng)) {
      mismatches.push(
        `**Лагна:** в паспорте «${passport.lagna.sign}», по долготе асцендента geo ожидается «${eng}».`
      );
    }
  }

  const order = ["Sun", "Moon", "Mars", "Mercury", "Jupiter", "Venus", "Saturn", "Rahu", "Ketu"];
  const planets = geo.planets;
  if (planets && typeof planets === "object") {
    for (const key of order) {
      const g = planets[key];
      if (!g || typeof g.longitude !== "number") continue;
      const row = matchPlanetRow(passport, key);
      const engSign = signRuFromLongitude(g.longitude);
      if (!row) {
        mismatches.push(`**${key}:** есть в geo, нет строки в passport.planets — проверь генерацию статики.`);
        continue;
      }
      if (!signsMatch(row.sign, engSign)) {
        mismatches.push(
          `**${key} (${row.name ?? row.nameEn}):** в паспорте знак «${row.sign}», по geo долготе ожидается «${engSign}».`
        );
      }
      if (typeof g.house === "number" && typeof row.house === "number" && g.house !== row.house) {
        mismatches.push(
          `**${key}:** дом в паспорте ${row.house}, в geo ${g.house} (целые дома).`
        );
      }
    }
  } else {
    lines.push("*В geo нет блока `planets` — сверка грах не выполнялась.*");
  }

  const proseBlob = collectPassportProseBlob(passport);
  const proseHints = scanInterpretationForWrongSignHints(proseBlob, passport);

  lines.push("### Расхождения passport.planets/lagna ↔ geo");
  if (mismatches.length === 0) {
    lines.push("*Не найдено.*");
  } else {
    for (const m of mismatches) lines.push(`- ${m}`);
  }

  lines.push(
    "",
    "### Эвристика: проза радикса ↔ структура D1 (interpretation + йоги + psych.reasoning; варги исключены)"
  );
  lines.push(
    "*То же поле зрения, что у модели в `passportPromptBlock`: свободный текст vs строки `planets`/`lagna` в JSON.*"
  );
  if (proseHints.length === 0) {
    lines.push("*Подозрительных конструкций «планета … в чужом знаке» не найдено.*");
  } else {
    for (const h of proseHints) lines.push(`- ${h}`);
  }

  const ok = mismatches.length === 0 && proseHints.length === 0;
  lines.push(
    "",
    ok
      ? "**STAGING_PASSPORT_TRUTH_STATUS:** OK"
      : "**STAGING_PASSPORT_TRUTH_STATUS:** FAIL"
  );

  return { ok, markdown: lines.join("\n") };
}
