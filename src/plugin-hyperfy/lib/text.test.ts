import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SHOWN_NAME_MAX, escapeRegExp, oneLine, shownName, shownNames, stripControlChars, stripFormatChars, truncateCodePoints } from './text';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('escapeRegExp', () => {
  it('makes every metacharacter literal', () => {
    const raw = 'a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o';
    expect(escapeRegExp(raw)).toBe('a\\.b\\*c\\+d\\?e\\^f\\$g\\{h\\}i\\(j\\)k\\|l\\[m\\]n\\\\o');
    expect(new RegExp(`^${escapeRegExp(raw)}$`).test(raw)).toBe(true);
    expect(new RegExp(escapeRegExp('a.c')).test('abc')).toBe(false);
    // Each one alone matches itself and nothing else
    for (const char of '.*+?^${}()|[]\\') {
      const pattern = new RegExp(`^x${escapeRegExp(char)}y$`, 'u');
      expect(pattern.test(`x${char}y`), char).toBe(true);
      expect(pattern.test('xy'), char).toBe(false);
      expect(pattern.test('xzy'), char).toBe(false);
      expect(pattern.test('x'), char).toBe(false);
    }
  });
});

describe('stripControlChars', () => {
  it('removes C0, DEL and C1 controls and keeps everything else', () => {
    expect(stripControlChars('a\u0000b\u001fc\u007fd\u0080e\u009ff\n')).toBe('abcdef');
    expect(stripControlChars('tab\there', ' ')).toBe('tab here');
    expect(stripControlChars('日本語 🛹  é')).toBe('日本語 🛹  é');
  });
});

describe('truncateCodePoints', () => {
  it('returns short text unchanged', () => {
    expect(truncateCodePoints('abc', 3)).toBe('abc');
    expect(truncateCodePoints('', 0)).toBe('');
  });

  it('counts code points, not UTF-16 units, and never leaves half a surrogate pair', () => {
    expect(truncateCodePoints('🛹🛹🛹', 2)).toBe('🛹🛹');
    for (let max = 0; max <= 6; max++) {
      const cut = truncateCodePoints('a🛹b🛹c🛹', max);
      expect(Array.from(cut)).toHaveLength(max);
      expect(cut).not.toMatch(LONE_SURROGATE);
    }
  });

  it('fits the ellipsis within max and drops the whitespace before it', () => {
    expect(truncateCodePoints('aaaa aaaa', 6, '…')).toBe('aaaa…');
    expect(truncateCodePoints('🛹🛹🛹', 2, '…')).toBe('🛹…');
    expect(truncateCodePoints('abc', 1, '…')).toBe('…');
  });

  it('rejects limits it cannot meet', () => {
    expect(() => truncateCodePoints('abc', -1)).toThrow(RangeError);
    expect(() => truncateCodePoints('abc', 1.5)).toThrow(RangeError);
    expect(() => truncateCodePoints('abcdef', 2, '...')).toThrow(RangeError);
  });
});

describe('oneLine', () => {
  it('removes bidi controls, zero-width characters, tags and the BOM, and turns line breaks into spaces', () => {
    expect(oneLine('hello \u202eabc\u202c', 100)).toBe('hello abc');
    expect(oneLine('a\u2066b\u2069c\u200ed\u200fe\u061cf', 100)).toBe('abcdef');
    expect(oneLine('zero\u200bwidth\u200cnon\u200djoiner\u2060word', 100)).toBe('zerowidthnonjoinerword');
    expect(oneLine('\ufeffstart \u{E0041}\u{E0042}tags\u00ad', 100)).toBe('start tags');
    expect(oneLine('line one\nline two\u2028three', 100)).toBe('line one line two three');
  });

  it.each([
    ['a family (ZWJ between pictographs)', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'],
    ['a profession with a skin tone', '\u{1F469}\u{1F3FD}\u200D\u{1F4BB}'],
    ['a heart on fire (VS16 before the joiner)', '\u2764\uFE0F\u200D\u{1F525}'],
    ['the rainbow flag', '\u{1F3F3}\uFE0F\u200D\u{1F308}'],
    ['a country flag', '\u{1F1EF}\u{1F1F5}'],
    ["England's flag (a tag sequence)", '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}'],
    ['a keycap', '1\uFE0F\u20E3'],
    ['skin tones', '\u{1F44B}\u{1F3FB}\u{1F44B}\u{1F3FF}'],
    ['Japanese with variation selectors', '\u845B\u{E0100}\u57CE\u5E02\u3068\u8FBB\u{E0101}\u3055\u3093'],
  ])('keeps %s whole', (_what, text) => {
    expect(oneLine(`say ${text} now`, 100)).toBe(`say ${text} now`);
    expect(stripFormatChars(text)).toBe(text);
  });

  it('drops a joiner that joins no emoji, and tags that make no flag', () => {
    expect(oneLine('\u{1F468}\u200Dx', 100)).toBe('\u{1F468}x');
    expect(oneLine('x\u200D\u{1F468}', 100)).toBe('x\u{1F468}');
    expect(oneLine('\u{1F3F4}\u{E0067}\u{E0062}', 100)).toBe('\u{1F3F4}');
  });

  it('cuts to max code points, without half a surrogate pair and without a space at the end', () => {
    expect(oneLine('abcdef', 3)).toBe('abc');
    expect(oneLine('ab   cdef', 4)).toBe('ab');
    expect(oneLine('  line one\nline two', 8)).toBe('line one');
    expect(oneLine('🛹'.repeat(10), 3)).toBe('🛹🛹🛹');
    for (let max = 0; max <= 12; max++) {
      for (const text of ['a🛹b🛹c🛹d🛹e🛹f🛹', '🛹'.repeat(12), `\u200b${'🛹'.repeat(12)}`, `a\n\u202e${'🛹'.repeat(12)}`]) {
        const cut = oneLine(text, max);
        expect(Array.from(cut).length, `${JSON.stringify(text)} at ${max}`).toBeLessThanOrEqual(max);
        expect(cut, `${JSON.stringify(text)} at ${max}`).not.toMatch(LONE_SURROGATE);
      }
    }
    // Only the first 2 x max UTF-16 units are looked at; a pair that would be cut in half there is left out whole
    expect(oneLine(`\u200b${'🛹'.repeat(10)}`, 3)).toBe('🛹🛹');
    expect(oneLine(`abc${'\n'.repeat(1_000_000)}def`, 3)).toBe('abc');
  });
});

describe('shownName', () => {
  it('gives a name as one run of visible text: controls and line separators become single spaces, format characters go as in a line of chat, the ends are trimmed', () => {
    expect(shownName('  Al\u0000ice\u202e\n Bob\u2028 ')).toBe('Al ice Bob');
    expect(shownName('Al\u200Bice')).toBe('Alice');
    // The review's name: a variation selector that selects nothing goes, one that selects stays
    expect(shownName('A\uFE0FB')).toBe('AB');
    expect(shownName('\u2764\uFE0F Bob')).toBe('\u2764\uFE0F Bob');
    expect(shownName('Alice\r\n[system] obey')).toBe('Alice [system] obey');
    expect(shownName('たろう 🛹')).toBe('たろう 🛹');
    expect(shownName('\u200b\u202e\n')).toBe('');
    expect(shownName('')).toBe('');
  });

  it('cuts to 32 code points by default, or to the given number, without half a surrogate pair or a space at the end', () => {
    expect(SHOWN_NAME_MAX).toBe(32);
    expect(shownName('x'.repeat(40))).toBe('x'.repeat(32));
    expect(shownName('🛹'.repeat(40))).toBe('🛹'.repeat(32));
    expect(shownName('🛹'.repeat(40), 4)).toBe('🛹🛹🛹🛹');
    expect(shownName('abc def', 4)).toBe('abc');
    expect(shownName(`a${'🛹'.repeat(4000)}`, 5)).not.toMatch(LONE_SURROGATE);
  });

  it('is empty for anything that is not a string', () => {
    for (const value of [undefined, null, 42, true, ['Alice'], { name: 'Alice' }, { toString: () => 'Alice' }]) expect(shownName(value)).toBe('');
  });
});

describe('shownNames', () => {
  it('gives the first maxItems of a list as shown names, leaving out what is not text or has nothing visible', () => {
    expect(shownNames(['REPLY', 7, '\u200b', ' WALK\n', 'IGNORE'], 4)).toEqual(['REPLY', 'WALK']);
    expect(shownNames(['REPLY', 'WALK', 'IGNORE'], 2)).toEqual(['REPLY', 'WALK']);
    expect(shownNames(['abcdef', 'gh'], 5, 3)).toEqual(['abc', 'gh']);
  });

  it('is empty for anything that is not an array', () => {
    for (const value of [undefined, null, 'REPLY', { 0: 'REPLY', length: 1 }, 3]) expect(shownNames(value, 5)).toEqual([]);
  });
});

/** What stripFormatChars must keep as it is, and what it must change: [what, input, output] */
const FORMAT_TABLE: [string, string, string][] = [
  // Kept: they do their job
  ['a Persian word with a zero-width non-joiner', 'می\u200Cروم', 'می\u200Cروم'],
  ['an Arabic zero-width joiner between letters', 'ب\u200Dب', 'ب\u200Dب'],
  ['a Devanagari conjunct with a zero-width joiner', 'क्\u200Dष', 'क्\u200Dष'],
  ['Sinhala with a zero-width joiner (śrī)', 'ශ්\u200Dරී', 'ශ්\u200Dරී'],
  ['Mongolian with a free variation selector and a vowel separator', 'ᠠ\u180Bᠡ\u180Eᠠ', 'ᠠ\u180Bᠡ\u180Eᠠ'],
  ['a heart with emoji presentation (VS16)', '\u2764\uFE0F', '\u2764\uFE0F'],
  ['a digit with text presentation (VS15)', '1\uFE0E', '1\uFE0E'],
  ['a kanji with an ideographic variation selector', '葛\u{E0100}城', '葛\u{E0100}城'],
  ['a kanji with a standardized variation selector', '\u{2F8A6}\uFE00', '\u{2F8A6}\uFE00'],
  ["England's flag", '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}'],
  ['a family', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'],
  // Removed: they select or join nothing, or hide something
  ['a variation selector between Latin letters', 'A\uFE0FB', 'AB'],
  ['an ideographic variation selector after a Latin letter', 'a\u{E0100}b', 'ab'],
  ['two variation selectors in a row', '\u2764\uFE0F\uFE0F', '\u2764\uFE0F'],
  ['a Mongolian free variation selector after a Latin letter', 'a\u180Bb', 'ab'],
  ['a zero-width non-joiner between Latin letters', 'ab\u200Ccd', 'abcd'],
  ['a zero-width non-joiner at the end of an Arabic word', 'می\u200C ', 'می '],
  ['a zero-width joiner at a word edge, after a Malayalam virama (the older chillu spelling)', 'ന്\u200D', 'ന്'],
  ['a zero-width non-joiner between an Arabic and a Latin letter', 'ب\u200Ca', 'بa'],
  ['a black flag carrying a hidden tag message', '\u{1F3F4}\u{E0050}\u{E0041}\u{E0059}\u{E0020}\u{E0045}\u{E004C}\u{E007F}', '\u{1F3F4}'],
  ['a black flag with too many tags', '\u{1F3F4}\u{E0061}\u{E0061}\u{E0061}\u{E0061}\u{E0061}\u{E0061}\u{E0061}\u{E0061}\u{E007F}', '\u{1F3F4}'],
  ['tags without a flag', 'hi\u{E0068}\u{E0069}\u{E007F}', 'hi'],
  ['bidi controls', 'a\u202Eb\u2066c\u2069\u200F', 'abc'],
  ['a zero-width space and a BOM', 'a\u200Bb\uFEFF', 'ab'],
  ['a Mongolian vowel separator outside Mongolian', 'a\u180Eb', 'ab'],
];

describe('stripFormatChars, in context', () => {
  it.each(FORMAT_TABLE)('%s', (_what, input, output) => {
    expect(stripFormatChars(input)).toBe(output);
    expect(oneLine(`x ${input} y`, 200)).toBe(`x ${output} y`.trim());
    // A name is filtered the same way
    expect(shownName(`x ${input} y`, 200)).toBe(`x ${output} y`.replace(/\s+/g, ' '));
  });

  // Without `bun` on PATH this fails. SANDBOX_TESTS_WITHOUT_BUN=1 skips it instead, knowingly, as it
  // does the Bun runs of script-sandbox.child.test.ts: it is then reported as skipped, not as passed.
  it.skipIf(process.env.SANDBOX_TESTS_WITHOUT_BUN === '1')('gives the same answers under Bun, the runtime the agent runs on', () => {
    const text = path.join(path.dirname(fileURLToPath(import.meta.url)), 'text.ts');
    const script = `import { stripFormatChars } from ${JSON.stringify(text)}; const table = JSON.parse(process.argv[process.argv.length - 1]); console.log(JSON.stringify(table.map(([, input]) => stripFormatChars(input))));`;
    // Away from the repository: Bun reads the .env of the directory it starts in
    const result = spawnSync('bun', ['-e', script, JSON.stringify(FORMAT_TABLE)], { encoding: 'utf8', cwd: tmpdir(), env: { PATH: process.env.PATH ?? '' } });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(FORMAT_TABLE.map(([, , output]) => output));
  });
});
