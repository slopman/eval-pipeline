# Eval pipeline — LangGraph staging & LLM-as-judge

Portfolio-facing snapshot of how we **evaluate** a production LangGraph agent: **deterministic checks** plus an optional **second LLM** (Cursor Composer) that audits the same `state_visible_bundle` the downstream model would see—per node / per step.

This folder is **deliberately incomplete**: it holds staging sources + redacted proof excerpts. The runnable system lives in `astro_bot/`.

**Domain context:** This pipeline evaluates **astro_bot**—a highly deterministic multi-agent state machine that runs **complex chart math** (Vedic / Jyotisha style: primary radix “D1”, divisional “vargas” such as D9/D10/D7, multiple strength models). The domain’s strict tabular output and free-text interpretation side-by-side make it an excellent **stress test** for subtle LLM hallucination and for eval harnesses that must separate *real* contradictions from *apparent* ones.

---

## TL;DR / The problem we solved

**The problem:** In complex multi-agent DAGs, the model’s prose can **subtly disagree** with underlying deterministic math. Ordinary unit tests don’t parse natural-language semantics; naïve string heuristics on mixed corpora (radix + secondary layers) can **false-alarm** on valid text.

**The solution:** A **dual-layer** evaluation pipeline: (1) a **deterministic structural checker** on passport JSON vs the engine snapshot, plus **bounded prose heuristics** scoped to the right narrative slice; and (2) an **asynchronous LLM-as-judge** (Cursor Composer) that reviews the same `state_visible_bundle` at **each graph step**, flagging *semantic* tension between tool outputs (e.g. two different “strongest planet” rankings that are actually different metrics) before anything ships to production.

---

## Architecture (what a tech lead should see)

1. **Graph execution & recording**  
   Staging CLI streams LangGraph steps, persists a **manifest** (`schema_version`, `graph_steps[]`, `telegram_side_effects`, etc.). Each step can carry `update_visible` — the subset of state surfaced to prompts.

2. **`state_visible_bundle`**  
   Serializable slice (user query, digests, passport JSON, tool logs, draft, …). **Both** the production narrator and the judge consume this shape — same inputs, separable roles.

3. **Deterministic passport truth (`stagingPassportTruth`)**  
   Code-driven report: structured passport vs engine snapshot (`geo_snapshots.response_json`), plus bounded **prose heuristics** (e.g. “radix narrative ↔ D1 structure”). No LLM — reproducible FAIL/OK.

4. **Composer skin (`composer_skin_notes`)**  
   Optional async Markdown audit per step: interprets **multi-source tension** inside one bundle (e.g. two tool-derived strength summaries that use different metrics—think directional strength vs a full composite score). This is **not** the same artifact as `stagingPassportTruth`; overlap is intentional triangulation.

5. **Composer bridge for inner-graph LLM calls**  
   `code/utils-reference/staging-composer-graph-llm.ts`: staging-only LangChain chat adapter routing graph LLM calls through Cursor SDK when `STAGING_GRAPH_LLM_PROVIDER=composer`.

6. **Sanitization / RAG bundle helpers**  
   Supporting modules for safe snapshots and librarian-visible bundles (`staging-state-sanitize.ts`, `staging-rag-visible-bundle.ts`, automated checks).

---

## Repo map

| Location | Role |
|----------|------|
| `eval-pipeline/code/staging/` | Snapshot of `astro_bot/src/staging/` |
| `eval-pipeline/code/utils-reference/` | Composer adapter reference |
| `eval-pipeline/artifacts/manifest-snippets.anonymized.json` | Redacted before/after truth excerpts |
| `astro_bot/staging-runs/<run_id>/manifest.json` | Full traces (large; may contain fixture/geo text) |
| `astro_bot/src/agentic_rag/graph.ts` | Production graph wiring staging hooks |

---

## Evidence: real-world catch (semantic false positives)

### What the stand checks

- **Deterministic alignment** of the structured passport to `geo_snapshots.response_json` (engine source of truth).
- **Heuristic A:** free-text *interpretation* vs **structural** planet signs (catches overlay / narrative drift from static JSON).
- **Heuristic B (radix-only):** free-text *about the primary chart* vs **D1** structure (`interpretation` / yoga blurbs / psych reasoning). **Divisional “vargas”** are excluded from this pass—each varga has its **own** ascendant text; that is not a D1 contradiction.

### The false positive

A **lagna (ascendant) phrase scanner** matched lines like “ascendant in Sagittarius / Taurus / Aquarius” inside **varga key-placement prose** (D9 / D10 / D7). Those signs are **correct** for the **divisional** charts, not errors against **D1**. The heuristic had **conflated** radix lagna with `vargas.*.keyPlacements`.

### What the manifest showed (pre-fix)

**Run `0f8440ac-42df-48b3-ae97-74a4ec29f327`:**

- **Geo vs passport structure:** no discrepancies — the “passport.planets/lagna ↔ geo” block was clean.
- **FAIL** came **only** from the prose heuristic: it fired on “in Sagittarius / Taurus / Aquarius” while structural D1 lagna was **Leo**. In the same run, `composer_skin_notes` after context load already **explained** the honest reading: varga text, not a radix bug.

### Code fix

In `staging-passport-truth-audit.ts`, **`vargas.*.keyPlacements`** was removed from the prose blob used for the lagna/sign scan. The heuristic now targets **interpretation + yogas + psych.reasoning** (radix narrative). The report title and lagna hint copy were updated. A **regression test** ensures vargas with different lagnas do **not** fail the check.

### Post-fix run

**`f96ee10b-669c-498b-8994-9214e8d54bcf`:** `stagingPassportTruthMd` uses the “radix prose ↔ D1 (vargas excluded)” section; status **OK** (see `artifacts/manifest-snippets.anonymized.json`).

### Composer vs `stagingPassportTruth` (two QA layers)

- **`stagingPassportTruthMd`:** deterministic — structure ↔ geo + radix-scoped prose rules.
- **`composer_skin_notes`:** per-step LLM audit of the **bundle**—e.g. empty early graph (nothing to verify), then “contradictions” that are really **metric mixing** (e.g. one tool’s “strongest by partial strength” vs passport’s “strongest by full composite strength”), or a table column whose semantics are **relational** (ruled houses) vs **placement** in the geo digest.

So one run could **FAIL** deterministic checks on a bad heuristic while Composer simultaneously articulated **different**, legitimate tensions between tool layers—those are **separate** signals.

<details>
<summary>Russian version (оригинал)</summary>

### Стенд

- **Детерминированная сверка** астропаспорта с `geo_snapshots.response_json` (источник истины движка).
- **Эвристика «текст interpretation ↔ структурные знаки планет»** — ловит рассинхрон overlay/прозы со статикой.
- **Эвристика «проза радикса ↔ структура D1»** (`interpretation` / йоги / psych; **без варг** — там свои лагны дробных карт).

### Обнаружены ложные срабатывания

Эвристика лагны находила фразы вида «лагна в Стрельце / Тельце / Водолее» в тексте **варг** (D9/D10/D7) — это **корректные** лагны дробных карт, а не противоречие **D1**. Сканер смешивал лагну радикса и фразы из `vargas.*.keyPlacements`.

### Что видно по логу и манифесту

**Прогон `0f8440ac-42df-48b3-ae97-74a4ec29f327` (до правки эвристики):**

- С **geo** всё сошлось: блок «Расхождения passport.planets/lagna ↔ geo» — **не найдено**.
- **FAIL** шёл только от эвристики по прозе: совпали строки про лагну «в Стрелец», «в Телец», «в Водолей» при структурной лагне **Лев**. Уже в `composer_skin_notes` после загрузки контекста было верно отмечено: это текст варг, а не ошибка радикса.

### Что сделано в коде

В `staging-passport-truth-audit.ts` из просмотра эвристики убраны **`vargas.*.keyPlacements`** — эвристика идёт по **interpretation + йоги + psych.reasoning** (проза радикса). Заголовок отчёта и подсказка про лагну обновлены. Добавлен тест: варги с другими лагнами **не дают FAIL**.

### Прогон после правки

**`f96ee10b-669c-498b-8994-9214e8d54bcf`:** в `stagingPassportTruthMd` секция переименована в «проза радикса ↔ структура D1 (… варги исключены)», статус **OK** (см. JSON-выдержку в `artifacts/manifest-snippets.anonymized.json`).

### Composer vs `stagingPassportTruth`

- **`stagingPassportTruthMd`** — детерминированный отчёт (структура ↔ geo + эвристика радикса).
- **`composer_skin_notes`** на шагах манифеста — текст аудита по снимку `state_visible_bundle`: пустой ранний бандл, затем типичные **«противоречия»** вроде двух разных «самых сильных» планет (**дигбала** vs полная **шадбала**) или колонки «дома» в таблице благотворности vs размещение в geo — это **риски смешения метрик/семантики полей**, а не обязательно баг эфемерид.

Итого: один прогон мог давать **FAIL** только от старой эвристики (варги), при том что Composer уже объяснял другие напряжения между слоями тулов — это **разные слои контроля качества**.

</details>

---
