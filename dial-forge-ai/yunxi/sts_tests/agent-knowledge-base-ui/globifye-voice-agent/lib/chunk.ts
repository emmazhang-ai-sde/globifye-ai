// lib/chunk.ts
// Splits raw document text into overlapping chunks for embedding.
// Paragraph-aware: keeps whole paragraphs together where possible, falls back
// to sentence- then character-splitting for anything longer than chunkSize.

export interface ChunkOptions {
  /** Max characters per chunk (roughly ~250 tokens at 1000). */
  chunkSize?: number;
  /** Characters of trailing context copied from the previous chunk. */
  overlap?: number;
}

export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const chunkSize = opts.chunkSize ?? 1000;
  const overlap = opts.overlap ?? 150;

  const norm = text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!norm) return [];

  // 1) Break into units that are each <= chunkSize.
  const units: string[] = [];
  for (const para of norm.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= chunkSize) {
      units.push(p);
      continue;
    }
    // Long paragraph: split on sentence boundaries.
    const sentences = p.match(/[^.!?]+[.!?]*\s*/g) ?? [p];
    for (const raw of sentences) {
      const s = raw.trim();
      if (!s) continue;
      if (s.length <= chunkSize) {
        units.push(s);
      } else {
        // Still too long: hard character split.
        for (let i = 0; i < s.length; i += chunkSize) {
          units.push(s.slice(i, i + chunkSize).trim());
        }
      }
    }
  }

  // 2) Greedily pack units into chunks up to chunkSize.
  const packed: string[] = [];
  let buf = "";
  for (const u of units) {
    if (buf && buf.length + 2 + u.length > chunkSize) {
      packed.push(buf);
      buf = u;
    } else {
      buf = buf ? `${buf}\n\n${u}` : u;
    }
  }
  if (buf) packed.push(buf);

  // 3) Prepend overlap (word-aligned tail of the previous chunk).
  if (overlap <= 0 || packed.length <= 1) return packed;
  const out: string[] = [packed[0]];
  for (let i = 1; i < packed.length; i++) {
    const prev = packed[i - 1];
    let tail = prev.slice(Math.max(0, prev.length - overlap));
    const sp = tail.indexOf(" ");
    if (sp > 0) tail = tail.slice(sp + 1); // start at a word boundary
    out.push(`${tail.trim()}\n\n${packed[i]}`);
  }
  return out;
}
