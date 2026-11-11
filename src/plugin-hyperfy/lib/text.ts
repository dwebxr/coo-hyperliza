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

/*
 * Format characters (Cf: bidi controls and isolates, zero-width space, word joiner, BOM, soft
 * hyphen, tags, and the joiners where they join nothing) are removed, and so are variation
 * selectors that select nothing. Kept, where they do their job:
 *   - a zero-width joiner between two pictographs (the first possibly followed by VS16 or a skin
 *     tone): an emoji ZWJ sequence;
 *   - a zero-width joiner or non-joiner between two letters or marks of a script that uses them for
 *     shaping (JOINING_SCRIPTS: Arabic and Persian, Syriac, N'Ko, Mongolian, the Indic scripts,
 *     Sinhala, Khmer, Myanmar), and the Mongolian vowel separator between Mongolian letters;
 *   - the tags of a subdivision flag: a black flag, 3 to 7 tag letters or digits, the cancel tag;
 *   - a variation selector right after a character that takes it: VS15/VS16 after an emoji
 *     character, an ideographic variation selector (VS17-VS256) after a Han character, VS1-VS14
 *     after a Han, Myanmar or mathematical character, a Mongolian free variation selector after a
 *     Mongolian letter.
 * Keycap marks and skin tones are not format characters and are kept anyway.
 */
const MAY_STRIP = /[\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{180B}-\u{180D}\u{180F}]/u;
const FORMAT = /\p{Cf}/u;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const EMOJI_MODIFIER = /[\u{FE0F}\u{1F3FB}-\u{1F3FF}]/u;
const LETTER_OR_MARK = /[\p{L}\p{M}]/u;
const JOINING_SCRIPTS =
  /[\p{scx=Arab}\p{scx=Syrc}\p{scx=Nkoo}\p{scx=Mong}\p{scx=Deva}\p{scx=Beng}\p{scx=Guru}\p{scx=Gujr}\p{scx=Orya}\p{scx=Taml}\p{scx=Telu}\p{scx=Knda}\p{scx=Mlym}\p{scx=Sinh}\p{scx=Khmr}\p{scx=Mymr}]/u;
const MONGOLIAN = /\p{Script=Mong}/u;
const mongolianLetter = (c: string | undefined) => c !== undefined && MONGOLIAN.test(c) && /\p{L}/u.test(c);
const SUBDIVISION_TAG = /[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]/u;
const HAN = /\p{Script=Han}/u;
const VS1_TO_14_BASE = /[\p{Script=Han}\p{Script=Mymr}\p{Sm}]/u;
const EMOJI = /\p{Emoji}/u;

const ZWJ = '\u200D';
const ZWNJ = '\u200C';
const MVS = '\u180E';
const BLACK_FLAG = '\u{1F3F4}';
const CANCEL_TAG = '\u{E007F}';

const joins = (c: string | undefined) => c !== undefined && LETTER_OR_MARK.test(c) && JOINING_SCRIPTS.test(c);

/** Whether variation selector `vs` selects something after `base` (see above). */
function selects(vs: number, base: string | undefined): boolean {
  if (base === undefined) return false;
  if (vs === 0xfe0e || vs === 0xfe0f) return EMOJI.test(base);
  if (vs >= 0xfe00 && vs <= 0xfe0d) return VS1_TO_14_BASE.test(base);
  if (vs >= 0xe0100) return HAN.test(base);
  return mongolianLetter(base);
}

/** `value` without format characters or variation selectors, except where they do their job (see above). */
export function stripFormatChars(value: string): string {
  if (!MAY_STRIP.test(value)) return value;
  const chars = Array.from(value);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const code = c.codePointAt(0)!;
    if (c === BLACK_FLAG) {
      // A subdivision flag is kept whole; a black flag with anything else keeps the flag alone
      let end = i + 1;
      while (end < chars.length && SUBDIVISION_TAG.test(chars[end])) end++;
      const tags = end - i - 1;
      if (tags >= 3 && tags <= 7 && chars[end] === CANCEL_TAG) {
        out.push(...chars.slice(i, end + 1));
        i = end;
        continue;
      }
      out.push(c);
      continue;
    }
    const isVs = (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0xe0100 && code <= 0xe01ef) || (code >= 0x180b && code <= 0x180d) || code === 0x180f;
    if (isVs) {
      if (selects(code, out[out.length - 1])) out.push(c);
      continue;
    }
    if (c === ZWJ || c === ZWNJ) {
      const before = out[out.length - 1];
      const next = chars[i + 1];
      // An emoji ZWJ sequence: the pictograph before may carry VS16 or a skin tone
      const pictographBefore = before !== undefined && (PICTOGRAPH.test(before) || (EMOJI_MODIFIER.test(before) && PICTOGRAPH.test(out[out.length - 2] ?? '')));
      if ((c === ZWJ && pictographBefore && next !== undefined && PICTOGRAPH.test(next)) || (joins(before) && joins(next))) out.push(c);
      continue;
    }
    if (c === MVS) {
      if (mongolianLetter(out[out.length - 1]) && mongolianLetter(chars[i + 1])) out.push(c);
      continue;
    }
    if (FORMAT.test(c)) continue;
    out.push(c);
  }
  return out.join('');
}

/**
 * Untrusted text as one line of at most `max` code points: control characters and line/paragraph
 * separators become spaces, so it cannot start a new line in a log or a new section in a prompt,
 * and format characters and variation selectors are removed except where they do their job
 * (stripFormatChars). Runs of ordinary spaces are kept.
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
