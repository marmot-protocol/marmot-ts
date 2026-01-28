export type OuterCursor = { created_at: number; id: string };

export function compareCursor(a: OuterCursor, b: OuterCursor): -1 | 0 | 1 {
  if (a.created_at !== b.created_at)
    return a.created_at < b.created_at ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}
