# Staging sources (snapshot)

This directory is a **point-in-time copy** of `astro_bot/src/staging/` from the monorepo plus one related utility for the LLM-judge story.

| Path | Origin in repo |
|------|----------------|
| `staging/*.ts` | `astro_bot/src/staging/` |
| `utils-reference/staging-composer-graph-llm.ts` | `astro_bot/src/utils/staging-composer-graph-llm.ts` |

## Build context

Files **do not compile standalone**: imports resolve from `astro_bot/` (`../agentic_rag`, `../db`, `@langchain/*`, etc.). Treat this folder as **architecture evidence**, not a separate package.

To run tests or CLI staging flows, use the main project:

```bash
cd astro_bot && npm test -- --run src/staging
```
