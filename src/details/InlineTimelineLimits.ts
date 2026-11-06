/** Bounded candidate window; card byte/component budgets may display fewer. */
export const DEFAULT_INLINE_TIMELINE_MAX_ITEMS = 50;
export const MAX_INLINE_TIMELINE_ITEMS = 100;

export function resolveInlineTimelineLimit(value: unknown = DEFAULT_INLINE_TIMELINE_MAX_ITEMS): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_INLINE_TIMELINE_ITEMS) {
    throw new Error(`Invalid config field: liveCards.inlineTimelineMaxItems (expected integer 1..${MAX_INLINE_TIMELINE_ITEMS})`);
  }
  return value;
}
