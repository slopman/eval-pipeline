/**
 * Срез поля RagState для стенда.
 * Список ключей должен совпадать с `Annotation.Root` → `RagState` в `agentic_rag/graph.ts`.
 */
import { sanitizeForStagingJson } from "./staging-state-sanitize.js";

/** Порядок как в RagState; при добавлении полей в граф — дополнить здесь. */
export const RAG_STATE_STAGING_VISIBLE_KEYS = [
  "userQuery",
  "messages",
  "extractedTerms",
  "searchTheses",
  "toolsNeeded",
  "libraryQuotes",
  "sortedData",
  "draft",
  "needsMoreInfo",
  "loopCounter",
  "isChartRequest",
  "chartData",
  "chartImagePath",
  "nextAction",
  "leaderComment",
  "stagingStandDiscrepanciesMd",
  "stagingPassportTruthMd",
  "stagingPassportTruthOk",
  "conversationDigest",
  "dialogFocusHint",
  "supervisorUsesFullHistory",
  "clientGeoDigest",
  "clientGeoFingerprint",
  "clientToolDigest",
  "clientPresetSummary",
  "clientEffectiveCalculationSummary",
  "routerScenario",
  "toolRunTarget",
  "toolRunArgs",
  "bookExportBookId",
  "bookExportTitleQuery",
  "bookExportPath",
  "bookExportFileName",
  "clientCalculationIndex",
  "recallPastCalculationIds",
  "rawMaterial",
  "memoryRecall",
  "astroPassport",
  "periodicPassportJson",
  "remedyPassportJson",
  "clientsRegistryBrief",
  "sessionId",
] as const;

function shapeMessagesForStaging(
  msgs: unknown,
  tail = 5,
  previewLen = 600
): Record<string, unknown> {
  if (!Array.isArray(msgs)) {
    return { count: 0, tail_preview: [], note: "non-array messages" };
  }
  const slice = msgs.slice(-tail);
  const tail_preview = slice.map((m) => {
    if (m && typeof m === "object" && typeof (m as { getType?: () => string }).getType === "function") {
      const msg = m as { getType: () => string; content: unknown };
      let text: string;
      if (typeof msg.content === "string") text = msg.content;
      else {
        try {
          text = JSON.stringify(msg.content);
        } catch {
          text = "[unserializable content]";
        }
      }
      return {
        type: msg.getType(),
        content:
          text.length > previewLen ? `${text.slice(0, previewLen)}…[len=${text.length}]` : text,
      };
    }
    return sanitizeForStagingJson(m, { maxDepth: 4, maxString: previewLen });
  });
  return { count: msgs.length, tail_preview };
}

/**
 * Узкий «видимый» снимок RagState для JSON манифеста (после superstep).
 */
export function buildRagStateVisibleBundle(state: Record<string, unknown>): Record<string, unknown> {
  const raw: Record<string, unknown> = {};

  for (const key of RAG_STATE_STAGING_VISIBLE_KEYS) {
    if (!(key in state)) continue;
    const v = state[key];

    if (key === "messages") {
      raw[key] = shapeMessagesForStaging(v);
      continue;
    }

    if (key === "chartData" && v !== null && typeof v === "object") {
      raw[key] = sanitizeForStagingJson(v, { maxDepth: 5, maxString: 2500, maxKeys: 50 });
      continue;
    }

    if (key === "toolRunArgs" && v !== null && typeof v === "object") {
      raw[key] = sanitizeForStagingJson(v, { maxDepth: 6, maxString: 2000, maxKeys: 40 });
      continue;
    }

    raw[key] = v;
  }

  return sanitizeForStagingJson(raw, {
    maxString: 12_000,
    maxDepth: 12,
    maxArray: 24,
    maxKeys: 48,
  }) as Record<string, unknown>;
}
