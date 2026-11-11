/**
 * The one way a URL is written into a log line or an error message (which can reach chat): scheme,
 * host and path, with no user name or password, no query values (the names stay; a query part
 * without "=" counts as a name and is written), no fragment, and at most MAX_LOGGED_URL characters in all (a note of the full length included when it is cut). A
 * data: URL keeps its media type only. Text that does not parse but has a scheme, a user part or an
 * authority, a URL of any other scheme, and a blob: inside a blob:, keep only their length. Signed
 * URLs carry their signature in the query and credentials in the user part: the user part is never
 * written, a signature only when it stands in the query without a name.
 */

export const MAX_LOGGED_URL = 200;
const SHOWN_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:', 'asset:', 'file:']);

/** `text` within MAX_LOGGED_URL characters, its length noted inside that limit when it is cut */
function cap(text: string, length: number): string {
  if (text.length <= MAX_LOGGED_URL) return text;
  const note = `… (${length} characters)`;
  return `${text.slice(0, MAX_LOGGED_URL - note.length)}${note}`;
}

function queryNames(search: string): string {
  if (!search) return '';
  const names = search
    .slice(1)
    .split('&')
    .filter(Boolean)
    .map((pair) => `${pair.split('=')[0]}=…`);
  return names.length ? `?${names.join('&')}` : '';
}

/** The URL written for a log line or an error message: never more than MAX_LOGGED_URL characters. */
export function describeUrl(url: unknown): string {
  const text = typeof url === 'string' ? url : url instanceof URL ? url.href : String(url);
  return cap(describe(text, true), text.length);
}

function describe(text: string, outer: boolean): string {
  if (/^data:/i.test(text)) {
    const comma = text.indexOf(',');
    const type = (comma === -1 ? text.slice(5) : text.slice(5, comma)).split(';')[0];
    return `data:${type.slice(0, 100)}… (${text.length} characters)`;
  }
  let parsed: URL | null = null;
  try {
    parsed = new URL(text);
  } catch {
    // Not absolute, or broken
  }
  if (!parsed) {
    // Something that has a scheme, an authority or a user part but does not parse is written as
    // nothing of itself: whatever part of it is shown could be the secret
    if (/[:@\\]/.test(text) || text.startsWith('//')) return `<invalid URL, ${text.length} characters>`;
    // A relative path (a bundled file): everything from the first ? or # goes
    const cut = text.search(/[?#]/);
    return cut === -1 ? text : `${text.slice(0, cut)}${text[cut] === '?' ? '?…' : ''}`;
  }
  // blob: wraps another URL, written the same way; a blob: inside a blob: is not unwrapped again
  if (parsed.protocol === 'blob:' && outer) return `blob:${describe(parsed.pathname, false)}`;
  // Any other scheme could be anything (even a user name in the scheme's place, as in "name:password@host")
  if (!SHOWN_SCHEMES.has(parsed.protocol)) return `<URL of another kind, ${text.length} characters>`;
  const host = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? `//${parsed.host}` : '';
  return `${parsed.protocol}${host}${parsed.pathname}${queryNames(parsed.search)}`;
}
