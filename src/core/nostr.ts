import { Rumor } from "applesauce-common/helpers";

/**
 * Type guard to check if a value is a Rumor
 */
export function isRumorLike(value: unknown): value is Rumor {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.pubkey === "string" &&
    typeof r.kind === "number" &&
    typeof r.created_at === "number" &&
    typeof r.content === "string" &&
    Array.isArray(r.tags)
  );
}
