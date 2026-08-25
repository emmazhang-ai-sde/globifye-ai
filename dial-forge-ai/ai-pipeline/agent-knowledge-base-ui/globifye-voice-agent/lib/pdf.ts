// lib/pdf.ts
// Extracts plain text from a PDF. Uses `unpdf`, which bundles a serverless
// build of pdf.js and works cleanly inside a Next.js Node route (no filesystem
// test-file quirks like pdf-parse). Runtime must be "nodejs", not "edge".
import { extractText, getDocumentProxy } from "unpdf";

export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return (Array.isArray(text) ? text.join("\n\n") : text).trim();
}
