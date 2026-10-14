const ASCII_ONLY = /^[\x00-\x7F]+$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parses a comma-separated alias list (e.g. HYPERFY_AGENT_ALIASES="クー,くー").
 */
export function parseAliases(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((alias) => alias.trim())
    .filter(Boolean);
}

/**
 * True when the text mentions any of the names.
 * ASCII names must stand alone ("Coo!" matches, "cool" does not);
 * non-ASCII names (e.g. Japanese) match as substrings, since those scripts have no word boundaries.
 */
export function isDirectlyAddressed(text: string | undefined | null, names: string[]): boolean {
  if (!text) return false;
  const haystack = text.toLowerCase();
  return names.some((rawName) => {
    const name = rawName?.trim().toLowerCase();
    if (!name) return false;
    if (!ASCII_ONLY.test(name)) return haystack.includes(name);
    return new RegExp(`(^|[^a-z0-9_])${escapeRegExp(name)}($|[^a-z0-9_])`).test(haystack);
  });
}
