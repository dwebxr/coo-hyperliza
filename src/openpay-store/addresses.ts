/**
 * What in a piece of text reads as an address to pay at or write to: what a browser would open,
 * what a person would type in again as one, and wallet addresses. Seller text has these removed
 * (catalog.ts sanitizeText), and the agent's link message must hold none but the purchase URL
 * (catalog.ts linkMessage); both use findAddresses. What it does not recognise stays in the text:
 * this removes the recognised forms, not every way to describe an address.
 *
 * Recognised, each with whatever follows it up to a space where that is part of an address:
 * - schemes (schemePass): `scheme://…` for any scheme (misspelt ones too, `hxxps://`); and a
 *   scheme that a browser or the system acts on, then `:` and anything but a space: the web ones
 *   (`http` `https` `ws` `wss` `ftp` `file`) with any number of slashes or backslashes, none
 *   included (`https:evil%2ecom`), and `mailto` `javascript` `vbscript` `data` `tel` `sms` `intent`
 *   `blob` `about` `view-source` `chrome` `bitcoin` `ethereum` `lightning` `upi` `geo` `magnet`,
 *   also right after other text (`pay-https:…`, `送金先https:…`);
 * - wallet addresses (walletPass): `0x` and exactly 40 hex digits, wherever they stand;
 * - IPv4 addresses (ipv4Pass): four numbers up to 255, wherever they stand, except right after
 *   a Latin letter with no path or port after them (`v1.2.3.4`); and, with a path, port, query or
 *   fragment after them, the other numeric forms a browser reads as one that do not occur in
 *   ordinary text (numericHostPass: a `0x` part, or 2 or 3 parts with the last above 255);
 * - bracketed IPv6 addresses (ipv6Pass), `[…]` with `::` or seven colons;
 * - host names (hostPass): labels of letters, digits and marks in any script (IDN), punycode, or
 *   percent-encoded (`%61`, and UTF-8 `%E3%82%B3…` for IDN), joined by the separators below, when
 *   - its last label is a listed top-level domain (TLDS), or
 *   - its last label could be one (2 to 63 Latin letters, punycode, or a listed one) and a `/`,
 *     `:port`, `?…` or `#…` follows (also percent-encoded), or it comes after `@` (`name@host`,
 *     an e-mail address) or after `//`, or
 *   - its first label is `www`;
 *   together with a `name@` or `//` right before it (back to the space).
 *
 * Separators between labels, by character:
 * - `.` `．` `․` `%2e` always: browsers read them as the dot of a host name (IDNA, NFKC, decoding);
 * - `‧` `·` `•` always: not to a browser, but a person reads them as a dot and types one;
 * - `。` `｡` (browsers read them as a dot) and `・` `･` (a person does) only between two labels in
 *   Latin letters and digits: they are also the full stop and the middle dot of ordinary Japanese
 *   text, after which the next word may be English (`おいしいです。It is good`, `コーヒー・カップ`);
 * - de-fangs: `[.]` `(.)` `{.}` with any of the dots above inside, `[dot]` `(dot)` `{dot}`, and the
 *   word `dot` between spaces (`evil dot com`), each with up to three spaces around it.
 *
 * Not addresses: a host whose last label is not listed and has nothing after it (`Node.js`,
 * `photo.jpg`, `Mt.Fuji`; also `evil.test`), a last label with a digit (`v1.2`, `1.5kg`) or of one
 * letter (`e.g.`), and a word, a colon and a space (`Note: see below`).
 *
 * Each pass is linear in the length of the text, with bounded look-ahead and look-back: every
 * character is looked at a bounded number of times (the optional ScanSteps counts them).
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
const IPV4_DOTS = new Set([0x2e, 0xff0e, 0x3002, 0xff61]);
const CLOSING: Record<number, number> = { 0x5b: 0x5d, 0x28: 0x29, 0x7b: 0x7d };
// Schemes a browser opens with any number of slashes or backslashes, none included (WHATWG special schemes)
const WEB_SCHEMES = ['http', 'https', 'ws', 'wss', 'ftp', 'file'];
// Schemes a browser or the system acts on right after the colon
const ACTING_SCHEMES = ['mailto', 'javascript', 'vbscript', 'data', 'tel', 'sms', 'intent', 'blob', 'about', 'view-source', 'chrome', 'bitcoin', 'ethereum', 'lightning', 'upi', 'geo', 'magnet'];
const LISTED_SCHEMES = [...WEB_SCHEMES, ...ACTING_SCHEMES];
const SCHEME_MAX = 32;
const LABEL_CHAR = /^[\p{L}\p{N}\p{M}-]$/u;
const SPACE = /\s/;
// A label in Latin letters, digits and hyphens, also in their full-width forms
const isLatinUnit = (c: number) =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2d || (c >= 0xff10 && c <= 0xff19) || (c >= 0xff21 && c <= 0xff3a) || (c >= 0xff41 && c <= 0xff5a) || c === 0xff0d;
const isSchemeUnit = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2b || c === 0x2e || c === 0x2d;
const isAsciiAlnum = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isAsciiLetter = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xff21 && c <= 0xff3a) || (c >= 0xff41 && c <= 0xff5a);
const isHex = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
const digitValue = (c: number) => (c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0xff10 && c <= 0xff19 ? c - 0xff10 : -1);

interface Label {
  start: number;
  end: number;
  latin: boolean;
}

/** The text being scanned, and what every pass needs to look at it. */
class Scan {
  readonly n: number;
  constructor(
    readonly text: string,
    readonly steps: ScanSteps
  ) {
    this.n = text.length;
  }
  step(): void {
    this.steps.count++;
  }
  unit(i: number): number {
    return this.text.charCodeAt(i);
  }
  isSpaceAt(i: number): boolean {
    return SPACE.test(this.text[i]);
  }
  /** The byte a `%XX` at `i` stands for, or -1 */
  percentAt(i: number): number {
    return i + 2 < this.n && this.unit(i) === 0x25 && isHex(this.unit(i + 1)) && isHex(this.unit(i + 2)) ? parseInt(this.text.slice(i + 1, i + 3), 16) : -1;
  }
  /** How many units of a label character start at `i` (a `%XX` of a label byte counts as one), 0 when none */
  labelWidthAt(i: number): number {
    if (i >= this.n) return 0;
    const byte = this.percentAt(i);
    if (byte !== -1) return byte >= 0x80 || (byte < 0x80 && /^[A-Za-z0-9-]$/.test(String.fromCharCode(byte))) ? 3 : 0;
    const width = this.text.codePointAt(i)! > 0xffff ? 2 : 1;
    return LABEL_CHAR.test(this.text.slice(i, i + width)) ? width : 0;
  }
  /** Where the run of non-space characters that `i` is in ends */
  runEnd(i: number): number {
    while (i < this.n && !this.isSpaceAt(i)) {
      this.step();
      i++;
    }
    return i;
  }
  /** Where that run starts, but not before `low` */
  runStart(i: number, low: number): number {
    while (i > low && !this.isSpaceAt(i - 1)) {
      this.step();
      i--;
    }
    return i;
  }
  /** A path, port, query or fragment starts at `i` (also percent-encoded) */
  pathAt(i: number): boolean {
    if (i >= this.n) return false;
    const c = this.unit(i);
    const next = i + 1 < this.n ? this.unit(i + 1) : -1;
    const byte = this.percentAt(i);
    if (c === 0x2f || c === 0xff0f || c === 0x5c || byte === 0x2f || byte === 0x5c) return true;
    if (c === 0x3a || c === 0xff1a) return next !== -1 && digitValue(next) !== -1;
    if (c === 0x3f || c === 0x23 || c === 0xff1f || c === 0xff03) return next !== -1 && !this.isSpaceAt(i + 1);
    return byte === 0x3f || byte === 0x23;
  }
}

/** Adds [start, end) to sorted, non-overlapping `spans`, merging what it touches. */
function addSpan(spans: AddressSpan[], start: number, end: number): void {
  while (spans.length && spans[spans.length - 1].end >= start) {
    const last = spans.pop()!;
    start = Math.min(start, last.start);
    end = Math.max(end, last.end);
  }
  spans.push({ start, end });
}

/** `scheme://…` for any scheme, and a listed scheme (also at the end of other text) followed by `:` and no space */
function schemePass(scan: Scan): AddressSpan[] {
  const spans: AddressSpan[] = [];
  for (let i = 0; i < scan.n; i++) {
    scan.step();
    const c = scan.unit(i);
    if ((c !== 0x3a && c !== 0xff1a) || i + 1 >= scan.n || scan.isSpaceAt(i + 1)) continue;
    const low = Math.max(spans.length ? spans[spans.length - 1].end : 0, i - SCHEME_MAX);
    let start = i;
    while (start > low && isSchemeUnit(scan.unit(start - 1))) {
      scan.step();
      start--;
    }
    const word = scan.text.slice(start, i).toLowerCase();
    let schemeStart = -1;
    if (scan.text.startsWith('//', i + 1)) schemeStart = start;
    else {
      for (const scheme of LISTED_SCHEMES) {
        // The whole word, or its end after something that is not a letter or digit (`pay-https`)
        if (word === scheme || (word.endsWith(scheme) && !isAsciiAlnum(word.charCodeAt(word.length - scheme.length - 1)))) {
          schemeStart = i - scheme.length;
          break;
        }
      }
    }
    if (schemeStart === -1) continue;
    const end = scan.runEnd(i);
    addSpan(spans, schemeStart, end);
    i = end;
  }
  return spans;
}

/** `0x` and exactly 40 hex digits, wherever they stand */
function walletPass(scan: Scan): AddressSpan[] {
  const spans: AddressSpan[] = [];
  for (let i = 0; i + 42 <= scan.n; i++) {
    scan.step();
    if (scan.unit(i) !== 0x30 || (scan.unit(i + 1) !== 0x78 && scan.unit(i + 1) !== 0x58)) continue;
    let j = i + 2;
    while (j < scan.n && j - i <= 42 && isHex(scan.unit(j))) {
      scan.step();
      j++;
    }
    if (j - i === 42) {
      addSpan(spans, i, j);
      i = j - 1;
    }
  }
  return spans;
}

/** Four numbers up to 255 joined by dots, not part of a longer dotted number */
function ipv4Pass(scan: Scan): AddressSpan[] {
  const spans: AddressSpan[] = [];
  const digitAt = (i: number) => i >= 0 && i < scan.n && digitValue(scan.unit(i)) !== -1;
  const dotAt = (i: number) => i >= 0 && i < scan.n && IPV4_DOTS.has(scan.unit(i));
  for (let i = 0; i < scan.n; i++) {
    scan.step();
    if (!digitAt(i) || digitAt(i - 1) || (dotAt(i - 1) && digitAt(i - 2))) continue;
    let j = i;
    let groups = 0;
    for (; groups < 4; groups++) {
      if (groups > 0) {
        if (!dotAt(j)) break;
        j++;
      }
      let value = 0;
      let digits = 0;
      while (digits < 4 && digitAt(j)) {
        scan.step();
        value = value * 10 + digitValue(scan.unit(j));
        digits++;
        j++;
      }
      if (digits === 0 || digits > 3 || value > 255) break;
    }
    if (groups < 4 || digitAt(j) || (dotAt(j) && digitAt(j + 1))) continue;
    const followed = scan.pathAt(j);
    // `v1.2.3.4` is a version, not an address
    if (i > 0 && isAsciiLetter(scan.unit(i - 1)) && !followed) continue;
    const end = followed ? scan.runEnd(j) : j;
    addSpan(spans, i, end);
    // On from the end of the span: what it covers is not read again
    i = end - 1;
  }
  return spans;
}

/**
 * The other numeric host forms a browser reads as an IPv4 address, when a path, port, query or
 * fragment follows (a bare number stays): a dotted number with a `0x` part (`0xcb007107/pay`), or
 * two or three decimal parts whose last is above 255 (`203.0.28935/pay`). Fractions, scores and
 * times such as `1/2`, `24/7`, `3.5/5` or `1920/1080` are none of these.
 */
function numericHostPass(scan: Scan): AddressSpan[] {
  const spans: AddressSpan[] = [];
  const digitAt = (i: number) => i >= 0 && i < scan.n && digitValue(scan.unit(i)) !== -1;
  for (let i = 0; i < scan.n; i++) {
    scan.step();
    if (!digitAt(i)) continue;
    const before = i > 0 ? scan.unit(i - 1) : -1;
    if (before !== -1 && (digitValue(before) !== -1 || IPV4_DOTS.has(before) || isAsciiLetter(before))) continue;
    let j = i;
    let parts = 0;
    let hexPart = false;
    let last = 0;
    let decimalOnly = true;
    for (; parts < 4; parts++) {
      if (parts > 0) {
        if (!IPV4_DOTS.has(scan.unit(j)) || !digitAt(j + 1)) break;
        j++;
      }
      if (scan.unit(j) === 0x30 && (scan.unit(j + 1) === 0x78 || scan.unit(j + 1) === 0x58) && isHex(scan.unit(j + 2))) {
        j += 2;
        let digits = 0;
        while (j < scan.n && digits < 9 && isHex(scan.unit(j))) {
          scan.step();
          digits++;
          j++;
        }
        hexPart = true;
        decimalOnly = false;
        continue;
      }
      let value = 0;
      let digits = 0;
      while (digits < 11 && digitAt(j)) {
        scan.step();
        value = value * 10 + digitValue(scan.unit(j));
        digits++;
        j++;
      }
      last = value;
    }
    if (j < scan.n && (isAsciiAlnum(scan.unit(j)) || digitAt(j)) || !scan.pathAt(j)) {
      i = j - 1;
      continue;
    }
    if (hexPart || (decimalOnly && (parts === 2 || parts === 3) && last > 255)) {
      const end = scan.runEnd(j);
      addSpan(spans, i, end);
      i = end - 1;
      continue;
    }
    i = j - 1;
  }
  return spans;
}

/** `[…]` holding an IPv6 address (`::` or seven colons) */
function ipv6Pass(scan: Scan): AddressSpan[] {
  const spans: AddressSpan[] = [];
  for (let i = 0; i < scan.n; i++) {
    scan.step();
    if (scan.unit(i) !== 0x5b) continue;
    let j = i + 1;
    let colons = 0;
    let hex = 0;
    while (j < scan.n && j - i <= 46 && /[0-9A-Za-z:.%]/.test(scan.text[j])) {
      scan.step();
      if (scan.unit(j) === 0x3a) colons++;
      else if (isHex(scan.unit(j))) hex++;
      j++;
    }
    // `::` alone (`[::]`) or with groups, or all eight groups (seven colons)
    if (j >= scan.n || scan.unit(j) !== 0x5d || !(scan.text.slice(i, j).includes('::') || (colons === 7 && hex > 0))) continue;
    const prefixed = i > 0 && (scan.unit(i - 1) === 0x40 || (scan.unit(i - 1) === 0x2f && i > 1 && scan.unit(i - 2) === 0x2f));
    const start = prefixed ? scan.runStart(i, spans.length ? spans[spans.length - 1].end : 0) : i;
    const end = scan.pathAt(j + 1) ? scan.runEnd(j + 1) : j + 1;
    addSpan(spans, start, end);
    i = end - 1;
  }
  return spans;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

/** `label` with its percent-escapes decoded as UTF-8, or '' when they are not UTF-8 */
function decodeLabel(label: string): string {
  if (!label.includes('%')) return label;
  const bytes: number[] = [];
  for (let i = 0; i < label.length; ) {
    if (label.charCodeAt(i) === 0x25 && /^[0-9a-f]{2}$/i.test(label.slice(i + 1, i + 3))) {
      bytes.push(parseInt(label.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      const width = label.codePointAt(i)! > 0xffff ? 2 : 1;
      bytes.push(...encoder.encode(label.slice(i, i + width)));
      i += width;
    }
  }
  try {
    return utf8.decode(new Uint8Array(bytes));
  } catch {
    return '';
  }
}

/** Host names: chains of labels and separators (see the top of this file) */
function hostPass(scan: Scan): AddressSpan[] {
  const { text, n } = scan;
  const spans: AddressSpan[] = [];
  const floor = () => (spans.length ? spans[spans.length - 1].end : 0);
  const readLabel = (i: number): Label => {
    const start = i;
    let latin = true;
    for (let width = scan.labelWidthAt(i); width; width = scan.labelWidthAt(i)) {
      scan.step();
      const byte = width === 3 ? scan.percentAt(i) : -1;
      if (byte !== -1 ? byte >= 0x80 : !isLatinUnit(scan.unit(i))) latin = false;
      i += width;
    }
    return { start, end: i, latin };
  };
  const spacesAt = (i: number) => {
    let k = 0;
    while (k < 3 && i + k < n && scan.isSpaceAt(i + k)) k++;
    return k;
  };
  const isDot = (c: number) => ALWAYS_DOTS.has(c) || LATIN_ONLY_DOTS.has(c);
  const isWordDot = (i: number) => text.slice(i, i + 3).toLowerCase() === 'dot' && !scan.labelWidthAt(i + 3);
  /** A separator between labels at `i`: where it ends, and whether it joins only Latin labels */
  const readSeparator = (i: number): { end: number; latinOnly: boolean } | null => {
    if (i >= n) return null;
    const c = scan.unit(i);
    if (ALWAYS_DOTS.has(c)) return { end: i + 1, latinOnly: false };
    if (LATIN_ONLY_DOTS.has(c)) return { end: i + 1, latinOnly: true };
    if (scan.percentAt(i) === 0x2e) return { end: i + 3, latinOnly: false };
    const before = spacesAt(i);
    const at = i + before;
    const close = CLOSING[scan.unit(at)];
    if (close !== undefined) {
      const inner = at + 1;
      const innerEnd = inner < n && isDot(scan.unit(inner)) ? inner + 1 : isWordDot(inner) ? inner + 3 : -1;
      if (innerEnd !== -1 && scan.unit(innerEnd) === close) return { end: innerEnd + 1 + spacesAt(innerEnd + 1), latinOnly: false };
    }
    if (before > 0 && isWordDot(at)) {
      const after = spacesAt(at + 3);
      if (after > 0) return { end: at + 3 + after, latinOnly: false };
    }
    return null;
  };
  // A label as a top-level domain is compared decoded (its percent-escapes as UTF-8), normalized
  // and in small letters; one that does not decode is no top-level domain ('')
  const normal = (label: Label) => (label.end - label.start <= 9 * 63 ? decodeLabel(text.slice(label.start, label.end)).normalize('NFKC').toLowerCase() : '');
  const listed = (label: Label) => TLDS.has(normal(label)) || /^xn--[a-z0-9-]{1,59}$/.test(normal(label));
  const tldLike = (label: Label) => /^[a-z]{2,63}$/.test(normal(label)) || listed(label);
  /** `name@` or `//` right before `i` */
  const prefixedAt = (i: number) => i > 0 && (scan.unit(i - 1) === 0x40 || (scan.unit(i - 1) === 0x2f && i > 1 && scan.unit(i - 2) === 0x2f));

  let i = 0;
  while (i < n) {
    scan.step();
    if (!scan.labelWidthAt(i)) {
      i++;
      continue;
    }
    // A chain of labels and separators: is it, or does it start with, a host name?
    const labels: Label[] = [readLabel(i)];
    let chainEnd = labels[0].end;
    for (;;) {
      const separator = readSeparator(chainEnd);
      if (!separator || !scan.labelWidthAt(separator.end)) break;
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
      const followed = scan.pathAt(chainEnd);
      if (/^www\d{0,3}$/.test(normal(labels[0])) || ((followed || prefixedAt(i)) && tldLike(labels[labels.length - 1]))) {
        end = chainEnd;
        toRunEnd = followed;
      } else {
        for (let k = labels.length - 1; k >= 1; k--) {
          scan.step();
          if (listed(labels[k])) {
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
    const start = prefixedAt(i) ? scan.runStart(i, floor()) : i;
    if (toRunEnd) end = scan.runEnd(end);
    addSpan(spans, start, end);
    i = end;
  }
  return spans;
}

/** The address spans in `text`: those of every pass, in order, merged where they meet. */
export function findAddresses(text: string, steps: ScanSteps = { count: 0 }): AddressSpan[] {
  const scan = new Scan(text, steps);
  const all = [schemePass(scan), walletPass(scan), ipv4Pass(scan), numericHostPass(scan), ipv6Pass(scan), hostPass(scan)].flat().sort((a, b) => a.start - b.start);
  const spans: AddressSpan[] = [];
  for (const { start, end } of all) addSpan(spans, start, end);
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
