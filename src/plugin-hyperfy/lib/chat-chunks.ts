export const WORLD_CHAT_MAX_LENGTH = 500;

function findChunkEnd(text: string, limit: number, max: number, segmenter?: Intl.Segmenter): number {
  const boundaries = [0];
  const urls = [...text.matchAll(/https?:\/\/\S+/g)];
  let urlIndex = 0;
  let hardEnd = 0;
  let newlineEnd = 0;
  let sentenceEnd = 0;
  let whitespaceEnd = 0;

  // String iteration falls back to code points, so surrogate pairs stay together.
  for (const part of segmenter ? segmenter.segment(text) : text) {
    const grapheme = typeof part === 'string' ? part : part.segment;
    // Break before whitespace so a word ending exactly at the limit still fits.
    if (/[\r\n]/.test(grapheme)) newlineEnd = hardEnd;
    if (/\s/.test(grapheme)) whitespaceEnd = hardEnd;
    const end = hardEnd + grapheme.length;
    if (end > limit) break;
    const start = hardEnd;
    hardEnd = end;
    boundaries.push(end);
    while (urlIndex < urls.length && urls[urlIndex].index + urls[urlIndex][0].length <= start) urlIndex++;
    const inUrl = urls[urlIndex] && urls[urlIndex].index < end;
    if (!inUrl && (
      /[。！？]$/.test(grapheme) ||
      (/[.!?]$/.test(grapheme) && (end === text.length || /\s/.test(text[end]))) ||
      (sentenceEnd > 0 && sentenceEnd === start && /^[\p{Pe}\p{Pf}"']+$/u.test(grapheme))
    )) {
      sentenceEnd = end;
    }
  }

  // Early soft breaks waste the chunk budget. Try each kind before falling back to a hard cut.
  const end = [newlineEnd, sentenceEnd, whitespaceEnd].find((boundary) => boundary >= limit / 2) ?? hardEnd;
  for (const url of urls) {
    if (url.index >= end) break;
    const urlEnd = url.index + url[0].length;
    if (urlEnd <= end) continue;
    if (url.index > 0) return boundaries.findLast((boundary) => boundary <= url.index) ?? 0;
    if (urlEnd <= limit) return boundaries.findLast((boundary) => boundary <= urlEnd) ?? 0;
    // Only oversized URLs may be cut. A fitting URL must also survive the ellipsis budget.
    return urlEnd > max ? hardEnd : 0;
  }
  return end;
}

/** Split world chat using UTF-16 lengths, keeping URLs and graphemes intact where they fit. */
export function splitChatText(
  text: string,
  { max = WORLD_CHAT_MAX_LENGTH, maxChunks = 4 }: { max?: number; maxChunks?: number } = {}
): string[] {
  if (!Number.isSafeInteger(max) || max < 1 || !Number.isSafeInteger(maxChunks) || maxChunks < 1) {
    throw new RangeError('max and maxChunks must be positive safe integers');
  }

  let remaining = text.trim();
  const chunks: string[] = [];
  if (!remaining) return chunks;
  if (remaining.length <= max) return [remaining];

  const segmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : undefined;

  while (remaining) {
    if (remaining.length <= max) {
      chunks.push(remaining);
      break;
    }

    const lastChunk = chunks.length === maxChunks - 1;
    let end = findChunkEnd(remaining, lastChunk ? max - 1 : max, max, segmenter);
    let chunk = remaining.slice(0, end).trim();
    if (lastChunk && /https?:\/\/\S+$/.test(chunk)) {
      // Separate the ellipsis from a copied URL, accounting for both the space and the marker.
      end = findChunkEnd(remaining, max - 2, max, segmenter);
      chunk = remaining.slice(0, end).trim();
    }
    // A single grapheme can exceed max. Indicate truncation rather than break it or loop.
    if (!end) {
      chunks.push('…');
      break;
    }
    remaining = remaining.slice(end).trimStart();
    if (lastChunk) {
      chunks.push(`${chunk}${/https?:\/\/\S+$/.test(chunk) ? ' …' : '…'}`);
      break;
    }
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}
