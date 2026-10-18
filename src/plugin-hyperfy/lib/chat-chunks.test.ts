import { describe, expect, it, vi } from 'vitest';
import { splitChatText, WORLD_CHAT_MAX_LENGTH } from './chat-chunks';

// Mirror the world's trim -> grapheme-aware cut(500) -> trimEnd policy.
function applyWorldChatPolicy(text: string): string {
  let body = text.trim();
  if (body.length > 500) {
    let end = 0;
    if (typeof Intl.Segmenter === 'function') {
      for (const { index, segment } of new Intl.Segmenter().segment(body.slice(0, 502))) {
        if (index + segment.length > 500) break;
        end = index + segment.length;
      }
    }
    if (!end) {
      const code = body.charCodeAt(499);
      end = code >= 0xd800 && code <= 0xdbff ? 499 : 500;
    }
    body = body.slice(0, end);
  }
  return body.trimEnd();
}

describe('splitChatText', () => {
  it('keeps short text and text exactly at the world limit unchanged', () => {
    expect(WORLD_CHAT_MAX_LENGTH).toBe(500);
    expect(splitChatText('Hello!')).toEqual(['Hello!']);
    expect(splitChatText('a'.repeat(500))).toEqual(['a'.repeat(500)]);
  });

  it('trims text and drops empty input', () => {
    expect(splitChatText('  Hello! \n')).toEqual(['Hello!']);
    expect(splitChatText('')).toEqual([]);
    expect(splitChatText(' \t\r\n　')).toEqual([]);
    expect(splitChatText(' one \n\n two \n\n three ', { max: 8 })).toEqual(['one', 'two', 'three']);
  });

  it('prefers the last Japanese sentence ending that fits', () => {
    expect(splitChatText('こんにちは。元気？そう！またね。', { max: 10 })).toEqual(['こんにちは。元気？', 'そう！またね。']);
  });

  it.each(['.', '!', '?'])('breaks English sentences after %s followed by whitespace', (punctuation) => {
    expect(splitChatText(`Hello there${punctuation} Good morning everyone.`, { max: 15 })).toEqual([
      `Hello there${punctuation}`, 'Good morning', 'everyone.',
    ]);
  });

  it.each(['」', '』', '）', ')', '】', '〕', '〉', '》', '"', "'", '’', '”', '」』）'])(
    'keeps the closing punctuation %s with a Japanese sentence end', (closing) => {
      const sentence = `「これは日本語の文章です。${closing}`;
      const chunks = splitChatText(`${sentence}${'続き'.repeat(20)}`, { max: sentence.length + 4 });
      expect(chunks[0]).toBe(sentence);
      expect(chunks[1]).toMatch(/^続き/);
    }
  );

  it.each(['.', '!', '?'])('does not treat %s inside a word as a sentence end', (punctuation) => {
    const word = `foo${punctuation}bar`;
    expect(splitChatText(`${word} baz rest`, { max: 11 })).toEqual([`${word} baz`, 'rest']);
  });

  it('prefers a newline over a later sentence or whitespace break', () => {
    expect(splitChatText('First line\nSecond. Third fourth', { max: 20 })).toEqual(['First line', 'Second. Third fourth']);
    expect(splitChatText('First line\r\nSecond. Third fourth', { max: 20 })).toEqual(['First line', 'Second. Third fourth']);
  });

  it('does not spend a chunk on an early newline in a long reply', () => {
    const chunks = splitChatText(`Sure!\n${'word '.repeat(400)}`);
    expect(chunks.map((chunk) => chunk.length)).toEqual([500, 499, 499, 500]);
    expect(chunks[0]).toMatch(/^Sure!\nword /);
  });

  it('falls through an early newline to a later sentence end', () => {
    expect(splitChatText('Hi\nA longer sentence. More words', { max: 25 })).toEqual([
      'Hi\nA longer sentence.', 'More words',
    ]);
  });

  it('falls through an early sentence end to later whitespace', () => {
    expect(splitChatText('Hi! several words remain', { max: 20 })).toEqual(['Hi! several words', 'remain']);
  });

  it('hard-cuts when all soft breaks are too early', () => {
    const text = `Hi!\n ${'あ'.repeat(40)}`;
    expect(splitChatText(text, { max: 20 })).toEqual([text.slice(0, 20), text.slice(20, 40), text.slice(40)]);
  });

  it('does not spend a chunk on the only early space in a Japanese line', () => {
    const text = `🛒 ${'あ'.repeat(1000)}`;
    expect(splitChatText(text)).toEqual([text.slice(0, 500), text.slice(500, 1000), text.slice(1000)]);
  });

  it.each(['😀', '👩🏽‍🚀', '👨‍👩‍👧‍👦', '🇯🇵', 'e\u0301'])('hard-cuts without splitting the grapheme %s', (grapheme) => {
    const text = grapheme.repeat(7);
    const chunks = splitChatText(text, { max: grapheme.length * 2 + 1 });
    expect(chunks).toEqual([grapheme.repeat(2), grapheme.repeat(2), grapheme.repeat(2), grapheme]);
    expect(chunks.join('')).toBe(text);
  });

  it('keeps surrogate pairs intact when Intl.Segmenter is unavailable', () => {
    vi.stubGlobal('Intl', { ...Intl, Segmenter: undefined });
    try {
      expect(splitChatText('😀'.repeat(7), { max: 5 })).toEqual(['😀😀', '😀😀', '😀😀', '😀']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(['https://example.com/item', 'http://example.com/item'])('keeps the URL %s whole', (url) => {
    expect(splitChatText(`Look ${url} now`, { max: url.length })).toEqual(['Look', url, 'now']);
    expect(splitChatText(`Look:${url} now`, { max: url.length })).toEqual(['Look:', url, 'now']);
  });

  it('does not split at punctuation inside a URL at the start of a chunk', () => {
    const url = 'https://example.com/あ。い';
    expect(splitChatText(`${url} next words`, { max: url.length })).toEqual([url, 'next words']);
  });

  it('ignores sentence punctuation inside a URL after an introductory word', () => {
    const first = 'Look https://example.com/あ。い next words';
    expect(splitChatText(`${first} more words later`, { max: first.length })).toEqual([first, 'more words later']);
  });

  it.each(['🛒 HoverBoard — 505 JPYC', `🛒 ${'限定商品'.repeat(105)} — 505 JPYC`])(
    'keeps a shop URL whole in its own chunk after the header %s', (header) => {
      const url = 'https://open-pay.jp/ja/@a?product='.padEnd(500, 'x');
      expect(`${header}\n${url}`.length).toBeGreaterThan(500);
      expect(splitChatText(`${header}\n${url}`)).toEqual([header, url]);
    }
  );

  it('hard-cuts an oversized URL rather than getting stuck', () => {
    const url = `https://example.com/${'a'.repeat(60)}`;
    const chunks = splitChatText(url, { max: 25 });
    expect(chunks.join('')).toBe(url);
    expect(chunks.every((chunk) => chunk.length <= 25)).toBe(true);
  });

  it('limits chunk count and makes room for an ellipsis at a word boundary', () => {
    expect(splitChatText('one two three four five six seven', { max: 10, maxChunks: 2 })).toEqual(['one two', 'three…']);
    expect(splitChatText('a'.repeat(2500))).toEqual([
      'a'.repeat(500), 'a'.repeat(500), 'a'.repeat(500), `${'a'.repeat(499)}…`,
    ]);
  });

  it('does not add an ellipsis when all text fits in the allowed chunks', () => {
    expect(splitChatText('a'.repeat(2000))).toEqual(Array(4).fill('a'.repeat(500)));
  });

  it('preserves graphemes when reserving room for the ellipsis', () => {
    expect(splitChatText('👩🏽‍🚀'.repeat(4), { max: 15, maxChunks: 1 })).toEqual(['👩🏽‍🚀👩🏽‍🚀…']);
  });

  it('omits a fitting URL rather than damaging it to make room for the ellipsis', () => {
    const url = 'https://example.com/item';
    expect(splitChatText(`${url} more`, { max: url.length, maxChunks: 1 })).toEqual(['…']);
    expect(splitChatText(`${url} more`, { max: url.length + 1, maxChunks: 1 })).toEqual(['…']);
    expect(splitChatText(`Look ${url} more text`, { max: 30, maxChunks: 1 })).toEqual(['Look…']);
  });

  it('reserves two units to separate the truncation marker from a final URL', () => {
    const url = 'https://example.com/item';
    expect(splitChatText(`Look ${url} more text`, { max: 31, maxChunks: 1 })).toEqual([`Look ${url} …`]);
    expect(splitChatText(`${url} more`, { max: url.length + 2, maxChunks: 1 })).toEqual([`${url} …`]);
    const shopUrl = 'https://open-pay.jp/ja/@a?product=x';
    expect(splitChatText(`${shopUrl} more`, { max: shopUrl.length + 2, maxChunks: 1 })).toEqual([`${shopUrl} …`]);
  });

  it('stops with an ellipsis if a single grapheme cannot fit', () => {
    expect(splitChatText('👩🏽‍🚀hello', { max: 3 })).toEqual(['…']);
    expect(splitChatText('abc', { max: 1, maxChunks: 1 })).toEqual(['…']);
  });

  it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid limits (%s)', (limit) => {
    expect(() => splitChatText('text', { max: limit })).toThrow(RangeError);
    expect(() => splitChatText('text', { maxChunks: limit })).toThrow(RangeError);
  });

  it('keeps random-ish long inputs within 500 UTF-16 units without losing text before truncation', () => {
    const pieces = ['hello ', '日本語。', '😀', '👩🏽‍🚀', 'e\u0301', '\n', 'Done! ', 'https://example.com/item ', 'x'.repeat(73), '「日本語。」', 'https://example.com/あ。い '];
    let seed = 12345;
    let completeSamples = 0;
    let truncatedSamples = 0;
    for (let sample = 0; sample < 50; sample++) {
      let text = '';
      for (let i = 0; i < 20 + sample * 5; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        text += pieces[seed % pieces.length];
      }
      const chunks = splitChatText(text);
      expect(chunks.length).toBeLessThanOrEqual(4);
      for (const chunk of chunks) {
        expect(chunk.length).toBeGreaterThan(0);
        expect(chunk.length).toBeLessThanOrEqual(500);
        expect(chunk).toBe(chunk.trim());
        expect(applyWorldChatPolicy(chunk)).toBe(chunk);
        expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      }
      const sent = chunks.join('').replace(/…$/, '').replace(/\s/g, '');
      const original = text.replace(/\s/g, '');
      if (chunks.at(-1)?.endsWith('…')) {
        truncatedSamples++;
        expect(original.startsWith(sent)).toBe(true);
      } else {
        completeSamples++;
        expect(sent).toBe(original);
      }
    }
    expect(completeSamples).toBeGreaterThan(0);
    expect(truncatedSamples).toBeGreaterThan(0);
  });
});
