/**
 * Сжатие произвольных кусков LangGraph state / updates для JSON-манифеста стенда.
 */

const DEFAULT_MAX_STRING = 2_000;
const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_ARRAY = 8;
const DEFAULT_MAX_KEYS = 40;

export type StagingSanitizeOpts = {
  maxString?: number;
  maxDepth?: number;
  maxArray?: number;
  maxKeys?: number;
};

export function sanitizeForStagingJson(
  value: unknown,
  opts: StagingSanitizeOpts = {}
): unknown {
  const maxString = opts.maxString ?? DEFAULT_MAX_STRING;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxArray = opts.maxArray ?? DEFAULT_MAX_ARRAY;
  const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;

  const walk = (v: unknown, depth: number): unknown => {
    if (v == null) return v;
    if (depth > maxDepth) return "[maxDepth]";

    if (typeof v === "string") {
      if (v.length <= maxString) return v;
      return `${v.slice(0, maxString)}…[truncated len=${v.length}]`;
    }
    if (typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v === "bigint") return v.toString();
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "function") return "[function]";

    if (Array.isArray(v)) {
      if (v.length === 0) return [];
      const head = v.slice(0, maxArray).map((x) => walk(x, depth + 1));
      if (v.length > maxArray) {
        return [...head, `…+${v.length - maxArray} more`];
      }
      return head;
    }

    if (typeof v === "object") {
      const anyV = v as Record<string, unknown> & {
        getType?: () => string;
        content?: unknown;
      };
      if (typeof anyV.getType === "function" && "content" in anyV) {
        const role = String(anyV.getType());
        return { type: role, content: walk(anyV.content, depth + 1) };
      }
      if (Array.isArray(anyV.id) && anyV.kwargs && typeof anyV.kwargs === "object") {
        return { _lc_id: anyV.id.join("."), kwargs: walk(anyV.kwargs, depth + 1) };
      }

      const keys = Object.keys(anyV);
      if (keys.length > maxKeys) {
        const partial: Record<string, unknown> = {};
        for (const k of keys.slice(0, maxKeys)) {
          partial[k] = walk(anyV[k], depth + 1);
        }
        partial["…"] = `+${keys.length - maxKeys} keys`;
        return partial;
      }
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        out[k] = walk(anyV[k], depth + 1);
      }
      return out;
    }

    return String(v);
  };

  return walk(value, 0);
}
