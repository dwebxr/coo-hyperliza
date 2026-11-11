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

// Cc controls, Cf format characters (zero-width, bidi overrides and isolates, tags) and the
// line/paragraph separators (Zl, Zp)
const INVISIBLE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
// Everything that can end a line: Cc controls and the line/paragraph separators
const LINE_BREAKING_CHARS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

/** Replaces control, format (zero-width, bidi) and line/paragraph separator characters with `replacement`. */
export function stripInvisibleChars(value: string, replacement = ''): string {
  return value.replace(INVISIBLE_CHARS, replacement);
}

// Format characters (Cf: bidi controls and isolates, zero-width space, joiner and non-joiner, word
// joiner, tag characters, BOM, soft hyphen...), except what emoji are made of: a subdivision flag's
// tag sequence (U+1F3F4, tags, cancel tag) is matched whole and kept, and a zero-width joiner
// between two pictographs (each possibly followed by VS16 or a skin tone) is kept. Variation
// selectors, keycap marks and skin tones are not format characters and are kept anyway.
const FORMAT_CHARS = /\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}|(?<=\p{Extended_Pictographic}[\u{FE0F}\u{1F3FB}-\u{1F3FF}]?)\u200D(?=\p{Extended_Pictographic})|(\p{Cf})/gu;

/** `value` without format characters, emoji sequences kept whole (FORMAT_CHARS). */
export function stripFormatChars(value: string): string {
  return value.replace(FORMAT_CHARS, (match, format: string | undefined) => (format === undefined ? match : ''));
}

/**
 * Untrusted text as one line of at most `max` code points: control characters and line/paragraph
 * separators become spaces, so it cannot start a new line in a log or a new section in a prompt,
 * and format characters (bidi overrides, zero-width characters, tags) are removed except inside
 * emoji (stripFormatChars). Runs of ordinary spaces are kept.
 */
export function oneLine(value: string, max: number): string {
  // A code point is at most two UTF-16 units: nothing beyond 2 x max units can survive the cut
  return truncateCodePoints(stripFormatChars(head(value, max * 2).replace(LINE_BREAKING_CHARS, ' ')).trim(), max).trimEnd();
}

/** The first `units` UTF-16 units of `value`, never ending in half a surrogate pair. */
function head(value: string, units: number): string {
  if (value.length <= units) return value;
  const code = value.charCodeAt(units - 1);
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? units - 1 : units);
}

export const SHOWN_NAME_MAX = 32;

/**
 * A name from the world (a player, an entity, an action label) as it is logged, prompted and
 * spoken: control, format and line/paragraph separator characters become spaces, whitespace is
 * collapsed, and it is cut to `max` code points (coo-world's shown() does the same to the names in
 * its tip announcements). Empty when nothing visible is left or the value is not a string.
 */
export function shownName(value: unknown, max = SHOWN_NAME_MAX): string {
  if (typeof value !== 'string') return '';
  // Only the start can survive the cut: an over-long value is not scanned whole
  return truncateCodePoints(stripInvisibleChars(head(value, max * 8), ' ').replace(/\s+/g, ' ').trim(), max).trimEnd();
}

/**
 * The first `maxItems` of a list of names (such as a stored reply's action names), each as
 * shownName(name, maxEach); what is not text or has nothing visible is left out. [] for anything
 * that is not an array.
 */
export function shownNames(values: unknown, maxItems: number, maxEach = SHOWN_NAME_MAX): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .slice(0, maxItems)
    .map((value) => shownName(value, maxEach))
    .filter(Boolean);
}
