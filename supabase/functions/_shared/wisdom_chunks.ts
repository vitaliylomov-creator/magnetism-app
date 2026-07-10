// Chunker for OS documents. Splits on H2 (## header) boundaries per
// Technical Brief §5: "модуль Cabane залишається цілим чанком, не
// розрізаний навпіл." Mechanical char-count chunking would slice
// modules in half and destroy their semantic self-containedness.

export interface WisdomChunk {
  document: string;
  module: string;
  domain: string;
  content: string;
}

/**
 * Split an OS doc into chunks at H2 (`## `) boundaries. The preamble
 * before the first H2 (title, quote, philosophy) becomes a chunk labeled
 * "Preamble". Each subsequent chunk keeps its own header line so the
 * downstream prompt shows the module title inside the content.
 */
export function chunkOsDoc(
  document: string,
  text: string,
  domain: string = "universal",
): WisdomChunk[] {
  const lines = text.split("\n");
  const chunks: WisdomChunk[] = [];

  let currentModule = "Preamble";
  let currentContent: string[] = [];

  // Drop chunks under this many chars. Both OS docs open with a bare H1
  // title before the first H2, which would otherwise produce a nearly
  // empty "Preamble" chunk with just the title line. Anything genuinely
  // meaningful (even a short module) is well over this bound.
  const MIN_CHUNK_CHARS = 100;

  const flush = () => {
    const content = currentContent.join("\n").trim();
    if (content.length >= MIN_CHUNK_CHARS) {
      chunks.push({ document, module: currentModule, domain, content });
    }
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      currentModule = normalizeHeader(line.substring(3));
      currentContent = [line];
    } else {
      currentContent.push(line);
    }
  }
  flush();

  return chunks;
}

/**
 * Strip decorative emoji/symbols from a header line to produce a clean
 * module label. Keeps letters, digits, spaces, dashes, and common
 * separators. Result stays in whatever language the header used.
 */
function normalizeHeader(header: string): string {
  return header
    // Strip leading non-letter/non-digit characters (emoji, spaces).
    .replace(/^[^\p{L}\p{N}]+/u, "")
    // Collapse multiple spaces.
    .replace(/\s+/g, " ")
    .trim();
}
