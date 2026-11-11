/** `value` with every RegExp metacharacter escaped, for use as a literal inside a pattern. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Unicode general category Cc: C0 controls, DEL and C1 controls (U+0000-001F, U+007F-009F)
const CONTROL_CHARS = /\p{Cc}/gu;

/** Replaces every control character (C0, DEL, C1) in `value` with `replacement`. */
export function stripControlChars(value: string, replacement = ''): string {
  return value.replace(CONTROL_CHARS, replacement);
}

/**
 * `value` cut to at most `max` code points, so a surrogate pair is never split (grapheme clusters
 * such as flags or ZWJ emoji can still be cut). When it is cut and `ellipsis` is given, the result
 * ends with the ellipsis, still within `max` code points, and whitespace before it is dropped.
 */
export function truncateCodePoints(value: string, max: number, ellipsis = ''): string {
  if (!Number.isSafeInteger(max) || max < 0) throw new RangeError('max must be a non-negative safe integer');
  const chars = Array.from(value);
  if (chars.length <= max) return value;
  const room = max - Array.from(ellipsis).length;
  if (room < 0) throw new RangeError('ellipsis is longer than max');
  const kept = chars.slice(0, room).join('');
  return ellipsis ? `${kept.trimEnd()}${ellipsis}` : kept;
}
