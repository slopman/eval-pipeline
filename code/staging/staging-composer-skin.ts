/**
 * Режим стенда «Composer в шкуре узла»: после прогона графа вызывается Cursor SDK (composer-2)
 * по каждому шагу с state_visible_bundle — ловим противоречия с расчётным наталом и слабые промпты.
 *
 * Важно: Composer НЕ получает тот же system/user промпт, что внутренний LLM узла (Groq/Gemini).
 * Узел отрабатывает как в проде; затем Composer получает отдельный аудиторский промпт + JSON снимка state
 * (state_visible_bundle / update_visible). То есть это наблюдатель по артефактам шага, не «параллельный тот же вызов».
 *
 * Требует `CURSOR_API_KEY`. Отключить глобально: `STAGING_COMPOSER_SKIN_DISABLE=1`.
 *
 * Опционально: `STAGING_COMPOSER_SKIN_NODE_ALLOWLIST` — через запятую имена узлов
 * (пересечение с step.node_ids); пусто = все шаги.
 */
import { extractCursorPromptText } from "../utils/cursor-sdk-pro-lead.js";
import type { StagingGraphStepRecord, StagingRunManifest } from "./run-manifest.js";

const MAX_STEP_JSON_CHARS = 28_000;

export function resolveStagingComposerSkinConfig(): {
  modelId: string;
  apiKey: string;
  cwd: string;
} | null {
  if (/^(1|true|yes)$/i.test(process.env.STAGING_COMPOSER_SKIN_DISABLE?.trim() ?? "")) {
    return null;
  }
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (!apiKey) return null;
  const modelId =
    process.env.STAGING_COMPOSER_MODEL?.trim() ||
    process.env.CURSOR_PRO_LEAD_MODEL?.trim() ||
    "composer-2";
  const cwd =
    process.env.CURSOR_STAGING_COMPOSER_CWD?.trim() ||
    process.env.CURSOR_PRO_LEAD_CWD?.trim() ||
    process.cwd();
  return { modelId, apiKey, cwd };
}

function parseNodeAllowlist(): Set<string> | null {
  const raw = process.env.STAGING_COMPOSER_SKIN_NODE_ALLOWLIST?.trim();
  if (!raw) return null;
  const ids = raw
    .split(/[,|]/g)
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

function stepMatchesAllowlist(step: StagingGraphStepRecord): boolean {
  const allow = parseNodeAllowlist();
  if (!allow) return true;
  return step.node_ids.some((id) => allow.has(id));
}

function truncateJsonBlock(obj: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(obj, null, 2);
  } catch {
    s = String(obj);
  }
  if (s.length <= MAX_STEP_JSON_CHARS) return s;
  const budget = MAX_STEP_JSON_CHARS - 120;
  const head = Math.floor(budget / 2);
  const tail = budget - head;
  return `${s.slice(0, head)}\n… [truncated ${s.length - budget} chars] …\n${s.slice(-tail)}`;
}

function buildComposerSkinPrompt(params: {
  step: StagingGraphStepRecord;
  userQuery: string;
  scenarioId: string;
}): string {
  const { step, userQuery, scenarioId } = params;
  const bundleJson = step.state_visible_bundle
    ? truncateJsonBlock(step.state_visible_bundle)
    : "(нет state_visible_bundle — шаг пропущен для аудита содержимого)";
  const updateJson = truncateJsonBlock(step.update_visible);

  return `Ты — аудитор стенда астрологического бота (LangGraph). Ответь на русском, Markdown.

## Иерархия источников истины (строго)
1. **Расчётный натал** — то, что следует из расчёта планет/домов/лагны в данных сеанса: прежде всего блоки вроде clientGeoDigest, структурированный расчёт в chartData / tool digests, НЕ выдумывай долготы.
2. **Структурированный astroPassport и выводы расчётных тулов** этого сеанса — вторичный опорный слой.
3. **НЕ считать истиной:** свободный текст супервизора (leaderComment), краткие саммари диалога, цитаты книг как замена фактам лагны/домов.

## Контекст прогона
- scenario_id: ${scenarioId}
- Запрос пользователя (кратко): ${userQuery.replace(/\s+/g, " ").slice(0, 500)}

## Узел(ы) графа после шага
${step.node_ids.join(", ") || "(неизвестно)"}
step_index: ${step.step_index}
from_cache: ${step.from_cache === true}

## Дельта update_visible (JSON)
\`\`\`json
${updateJson}
\`\`\`

## Снимок RagState после шага state_visible_bundle (JSON)
\`\`\`json
${bundleJson}
\`\`\`

## Задача
1. **Противоречия:** где текст в bundle (draft, passport-текст, комментарии) расходится с расчётным наталом из п.1 (лагна, знаки планет, дома, ретроградность).
2. **Риски промпта:** что может сломать дешёвую модель на этом шаге.
3. **Правки:** 1–3 конкретные формулировки правил для системных промптов (коротко).

Структура ответа:
## Противоречия
## Риски промпта
## Предлагаемые правки

Если данных мало — так и напиши; не выдумывай координаты планет.`;
}

/**
 * Последовательные вызовы Composer по шагам манифеста (мутация записей graph_steps).
 */
export async function runComposerSkinAuditOnManifest(params: {
  manifest: StagingRunManifest;
  userQuery: string;
  modelId: string;
  apiKey: string;
  cwd: string;
}): Promise<void> {
  const steps = params.manifest.graph_steps;
  if (!steps?.length) return;

  const delayMs = Number.parseInt(process.env.STAGING_COMPOSER_STEP_DELAY_MS?.trim() ?? "0", 10);
  const scenarioId = params.manifest.meta.scenario_id;

  const { Agent } = await import("@cursor/sdk");

  for (const step of steps) {
    if (!stepMatchesAllowlist(step)) {
      step.composer_skin_notes =
        "[skipped] не входит в STAGING_COMPOSER_SKIN_NODE_ALLOWLIST";
      step.composer_skin_recorded_at_iso = new Date().toISOString();
      continue;
    }

    if (!step.state_visible_bundle || Object.keys(step.state_visible_bundle).length === 0) {
      step.composer_skin_error = "no state_visible_bundle";
      step.composer_skin_recorded_at_iso = new Date().toISOString();
      continue;
    }

    const prompt = buildComposerSkinPrompt({
      step,
      userQuery: params.userQuery,
      scenarioId,
    });

    try {
      const result = await Agent.prompt(prompt, {
        apiKey: params.apiKey,
        model: { id: params.modelId },
        local: { cwd: params.cwd },
      });
      step.composer_skin_notes = extractCursorPromptText(result);
      step.composer_skin_recorded_at_iso = new Date().toISOString();
      step.composer_skin_error = undefined;
    } catch (err: unknown) {
      let msg: string;
      if (err instanceof Error) {
        const retry = (err as Error & { isRetryable?: boolean }).isRetryable;
        msg =
          typeof retry === "boolean"
            ? `${err.message} (retryable=${retry})`
            : err.message;
      } else {
        msg = String(err);
      }
      step.composer_skin_error = msg;
      step.composer_skin_recorded_at_iso = new Date().toISOString();
    }

    if (delayMs > 0 && Number.isFinite(delayMs)) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
