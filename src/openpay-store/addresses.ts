/**
 * What in a piece of text reads as an address to pay at or write to: what a browser would open,
 * what a person would type in again as one, and wallet addresses. Seller text has these removed
 * (catalog.ts sanitizeText), and the agent's link message must hold none but the purchase URL
 * (catalog.ts formatLinkMessage); both use findAddresses.
 *
 * Recognised, each with the path, port, query or fragment that follows it up to a space:
 * - anything with a scheme: `scheme://…` (unknown and misspelt ones too, `hxxps://`), and
 *   `mailto:` `javascript:` `vbscript:` `data:` `file:` `tel:` `sms:` `intent:`;
 * - a host name: labels of letters, digits and marks in any script (IDN) or punycode, joined by
 *   the separators below, when
 *   - its last label is a listed top-level domain (TLDS), or
 *   - its last label could be one (2 to 63 Latin letters, punycode, or a listed one) and a `/`,
 *     `:port`, `?…` or `#…` follows, or it comes after `@` (`name@host`, which is also an e-mail
 *     address) or after `//`, or
 *   - its first label is `www`, or
 *   - it is an IPv4 address;
 *   together with a `name@` or `//` right before it (back to the space);
 * - a bracketed IPv6 address (`[2606:4700::1111]`);
 * - a wallet address: `0x` and 40 hex digits.
 *
 * Separators between labels, by character:
 * - `.` `．` `․` always: browsers read them as the dot of a host name (IDNA, or NFKC);
 * - `‧` `·` `•` always: not to a browser, but a person reads them as a dot and types one;
 * - `。` `｡` (browsers read them as a dot) and `・` `･` (a person does) only between two labels in
 *   Latin letters and digits: they are also the full stop and the middle dot of ordinary Japanese
 *   text, after which the next word may be English (`おいしいです。It is good`, `コーヒー・カップ`);
 * - de-fangs: `[.]` `(.)` `{.}` with any of the dots above inside, `[dot]` `(dot)` `{dot}`, and the
 *   word `dot` between spaces (`evil dot com`), each with up to three spaces around it.
 *
 * Not addresses: a host whose last label is not listed and has nothing after it (`Node.js`,
 * `photo.jpg`, `Mt.Fuji`; also `evil.test`), a last label with a digit (`v1.2`, `1.5kg`), a
 * one-letter one (`e.g.`), and a last label written like the first word of a sentence (a capital,
 * then small letters) right after a label in another script (`おいしいです.It is good`).
 *
 * One pass, linear in the length of the text: every character is looked at a bounded number of
 * times (the optional ScanSteps counts them).
 */

export interface AddressSpan {
  start: number;
  end: number;
}

/** Counts the characters a scan looked at. */
export interface ScanSteps {
  count: number;
}

// Every country code, the generic top-level domains in common use, and some in other scripts
const COUNTRY_TLDS =
  'ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg er es et eu fi fj fk fm fo fr ga gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sk sl sm sn so sr ss st su sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw';
const GENERIC_TLDS =
  'com net org info biz edu gov int mil arpa name pro mobi app dev xyz shop store site online top link click live life world tech cloud blog news page web win vip club fun art icu buzz rest bar today email space website zone tokyo osaka nagoya yokohama kyoto okinawa moe cool wiki pay cash money bank finance exchange market trade sale deals gift gifts ltd inc llc company network digital media social chat run studio design agency solutions services support help center care family love fyi lol best ninja guru expert systems tools codes host hosting domains download stream games game bet casino poker loan loans credit cards crypto nft wallet eth sol';
const SCRIPT_TLDS = 'コム みんな 世界 クラウド ストア ポイント セール ファッション 書籍 通販 グーグル 中国 中國 香港 台湾 台灣 新加坡 рф онлайн сайт орг ком 한국 닷컴';
export const TLDS: ReadonlySet<string> = new Set(`${COUNTRY_TLDS} ${GENERIC_TLDS} ${SCRIPT_TLDS}`.split(' '));

const ALWAYS_DOTS = new Set([0x2e, 0xff0e, 0x2024, 0x2027, 0xb7, 0x2022]);
const LATIN_ONLY_DOTS = new Set([0x3002, 0xff61, 0x30fb, 0xff65]);
const CLOSING: Record<number, number> = { 0x5b: 0x5d, 0x28: 0x29, 0x7b: 0x7d };
const SCHEMES = new Set(['mailto', 'javascript', 'vbscript', 'data', 'file', 'tel', 'sms', 'intent']);
const LABEL_CHAR = /^[\p{L}\p{N}\p{M}-]$/u;
const SPACE = /\s/;
// A label in Latin letters, digits and hyphens, also in their full-width forms
const isLatinUnit = (c: number) =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2d || (c >= 0xff10 && c <= 0xff19) || (c >= 0xff21 && c <= 0xff3a) || (c >= 0xff41 && c <= 0xff5a) || c === 0xff0d;
const isSchemeUnit = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2b || c === 0x2e || c === 0x2d;
const isAsciiAlnum = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isHex = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);

interface Label {
  start: number;
  end: number;
  latin: boolean;
}

/** The address spans in `text`, in order and not overlapping. */
export function findAddresses(text: string, steps: ScanSteps = { count: 0 }): AddressSpan[] {
  const n = text.length;
  const spans: AddressSpan[] = [];
  const step = () => void steps.count++;
  const unit = (i: number) => text.charCodeAt(i);
  const isSpaceAt = (i: number) => SPACE.test(text[i]);
  const width = (i: number) => (text.codePointAt(i)! > 0xffff ? 2 : 1);
  const isLabelAt = (i: number) => i < n && LABEL_CHAR.test(text.slice(i, i + width(i)));
  // Nothing before the end of the last span is looked at again
  const floor = () => (spans.length ? spans[spans.length - 1].end : 0);
  const add = (start: number, end: number) => {
    while (spans.length && spans[spans.length - 1].end >= start) {
      const last = spans.pop()!;
      start = Math.min(start, last.start);
      end = Math.max(end, last.end);
    }
    spans.push({ start, end });
  };
  /** Where the run of non-space characters that `i` is in ends */
  const runEnd = (i: number) => {
    while (i < n && !isSpaceAt(i)) {
      step();
      i++;
    }
    return i;
  };
  /** Where that run starts, but not before the last span */
  const runStart = (i: number) => {
    const low = floor();
    while (i > low && !isSpaceAt(i - 1)) {
      step();
      i--;
    }
    return i;
  };
  const readLabel = (i: number): Label => {
    const start = i;
    let latin = true;
    while (isLabelAt(i)) {
      step();
      if (!isLatinUnit(unit(i))) latin = false;
      i += width(i);
    }
    return { start, end: i, latin };
  };
  const spacesAt = (i: number) => {
    let k = 0;
    while (k < 3 && i + k < n && isSpaceAt(i + k)) k++;
    return k;
  };
  const isDot = (c: number) => ALWAYS_DOTS.has(c) || LATIN_ONLY_DOTS.has(c);
  const isWordDot = (i: number) => text.slice(i, i + 3).toLowerCase() === 'dot' && !isLabelAt(i + 3);
  /** A separator between labels at `i`: where it ends, and whether it joins only Latin labels */
  const readSeparator = (i: number): { end: number; latinOnly: boolean } | null => {
    if (i >= n) return null;
    const c = unit(i);
    if (ALWAYS_DOTS.has(c)) return { end: i + 1, latinOnly: false };
    if (LATIN_ONLY_DOTS.has(c)) return { end: i + 1, latinOnly: true };
    const before = spacesAt(i);
    const at = i + before;
    const close = CLOSING[unit(at)];
    if (close !== undefined) {
      const inner = at + 1;
      const innerEnd = inner < n && isDot(unit(inner)) ? inner + 1 : isWordDot(inner) ? inner + 3 : -1;
      if (innerEnd !== -1 && unit(innerEnd) === close) return { end: innerEnd + 1 + spacesAt(innerEnd + 1), latinOnly: false };
    }
    if (before > 0 && isWordDot(at)) {
      const after = spacesAt(at + 3);
      if (after > 0) return { end: at + 3 + after, latinOnly: false };
    }
    return null;
  };
  const normal = (label: Label) => (label.end - label.start <= 63 ? text.slice(label.start, label.end).normalize('NFKC').toLowerCase() : '');
  const listed = (label: Label) => TLDS.has(normal(label)) || /^xn--[a-z0-9-]{1,59}$/.test(normal(label));
  const tldLike = (label: Label) => /^[a-z]{2,63}$/.test(normal(label)) || listed(label);
  /** A capital and then small letters right after a label in another script: a sentence's first word */
  const sentenceWord = (previous: Label, label: Label) =>
    !previous.latin && label.latin && /^[A-Z][a-z]+$/.test(text.slice(label.start, label.end).normalize('NFKC'));
  /** A path, port, query or fragment starts at `i` */
  const pathAt = (i: number) => {
    if (i >= n) return false;
    const c = unit(i);
    const next = i + 1 < n ? unit(i + 1) : -1;
    if (c === 0x2f || c === 0xff0f) return true;
    if (c === 0x3a || c === 0xff1a) return next !== -1 && ((next >= 0x30 && next <= 0x39) || (next >= 0xff10 && next <= 0xff19));
    if (c === 0x3f || c === 0x23 || c === 0xff1f || c === 0xff03) return next !== -1 && !isSpaceAt(i + 1);
    return false;
  };
  /** `name@` or `//` right before `i` */
  const prefixedAt = (i: number) => i > 0 && (unit(i - 1) === 0x40 || (unit(i - 1) === 0x2f && i > 1 && unit(i - 2) === 0x2f));

  let i = 0;
  while (i < n) {
    step();
    const c = unit(i);

    // A scheme: `…://` or a listed one followed by `:`
    if (c === 0x3a && i + 1 < n && !isSpaceAt(i + 1)) {
      if (text.startsWith('//', i + 1)) {
        let start = i;
        const low = floor();
        while (start > low && isSchemeUnit(unit(start - 1))) {
          step();
          start--;
        }
        const end = runEnd(i);
        add(start, end);
        i = end;
        continue;
      }
      let start = i;
      while (start > Math.max(floor(), i - 10) && isAsciiAlnum(unit(start - 1))) start--;
      if (SCHEMES.has(text.slice(start, i).toLowerCase()) && (start === 0 || !isSchemeUnit(unit(start - 1)))) {
        const end = runEnd(i);
        add(start, end);
        i = end;
        continue;
      }
    }

    // A bracketed IPv6 address
    if (c === 0x5b) {
      let j = i + 1;
      let colons = 0;
      let hex = 0;
      while (j < n && j - i <= 46 && /[0-9A-Za-z:.%]/.test(text[j])) {
        step();
        if (unit(j) === 0x3a) colons++;
        else if (isHex(unit(j))) hex++;
        j++;
      }
      if (j < n && unit(j) === 0x5d && hex > 0 && (colons === 7 || text.slice(i, j).includes('::'))) {
        const start = prefixedAt(i) ? runStart(i) : i;
        const end = pathAt(j + 1) ? runEnd(j + 1) : j + 1;
        add(start, end);
        i = end;
        continue;
      }
    }

    // A wallet address
    if (c === 0x30 && (unit(i + 1) === 0x78 || unit(i + 1) === 0x58) && (i === 0 || !isAsciiAlnum(unit(i - 1)))) {
      let j = i + 2;
      while (j < n && j - i < 43 && isHex(unit(j))) {
        step();
        j++;
      }
      if (j - i === 42 && (j >= n || !isAsciiAlnum(unit(j)))) {
        add(i, j);
        i = j;
        continue;
      }
    }

    if (!isLabelAt(i)) {
      i++;
      continue;
    }

    // A chain of labels and separators: is it, or does it start with, a host name?
    const labels: Label[] = [readLabel(i)];
    let chainEnd = labels[0].end;
    for (;;) {
      const separator = readSeparator(chainEnd);
      if (!separator || !isLabelAt(separator.end)) break;
      const next = readLabel(separator.end);
      const previous = labels[labels.length - 1];
      // Read again as the start of the next chain
      if (separator.latinOnly && !(previous.latin && next.latin)) break;
      labels.push(next);
      chainEnd = next.end;
    }

    let end = -1;
    let toRunEnd = false;
    if (labels.length >= 2) {
      const last = labels[labels.length - 1];
      const followed = pathAt(chainEnd);
      if (/^www\d{0,3}$/.test(normal(labels[0])) || (labels.length === 4 && labels.every((label) => /^\d{1,3}$/.test(normal(label))))) {
        end = chainEnd;
        toRunEnd = followed;
      } else if ((followed || prefixedAt(i)) && tldLike(last)) {
        end = chainEnd;
        toRunEnd = followed;
      } else {
        for (let k = labels.length - 1; k >= 1; k--) {
          step();
          if (listed(labels[k]) && !sentenceWord(labels[k - 1], labels[k])) {
            end = labels[k].end;
            break;
          }
        }
      }
    }
    if (end === -1) {
      i = chainEnd;
      continue;
    }
    const start = prefixedAt(i) ? runStart(i) : i;
    if (toRunEnd) end = runEnd(end);
    add(start, end);
    i = end;
  }
  return spans;
}

/** `text` with every address span replaced by `replacement`. */
export function replaceAddresses(text: string, replacement: string, steps?: ScanSteps): string {
  const spans = findAddresses(text, steps);
  if (!spans.length) return text;
  let out = '';
  let at = 0;
  for (const { start, end } of spans) {
    out += text.slice(at, start) + replacement;
    at = end;
  }
  return out + text.slice(at);
}

/** The address spans of `text` as text. */
export function addressParts(text: string): string[] {
  return findAddresses(text).map(({ start, end }) => text.slice(start, end));
}
