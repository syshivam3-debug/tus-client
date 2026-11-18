// Pure helpers with no page access, so they can be tested in node (see tests/lib.test.mjs).
import { MB } from "./core.js";

// Seconds until a JWT expires (negative if it already has), or null if this is not a JWT with an "exp".
export function jwtSecondsLeft(token, now = Date.now()) {
  const t = String(token || "").replace(/^\w+\s+/, "").trim();
  const parts = t.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[1].length / 4) * 4, "="));
    const exp = JSON.parse(json).exp;
    return typeof exp === "number" ? Math.round(exp - now / 1000) : null;
  } catch {
    return null;
  }
}

export function humanDuration(sec) {
  const s = Math.abs(sec);
  if (s < 90) return Math.round(s) + " s";
  if (s < 5400) return Math.round(s / 60) + " min";
  return (s / 3600).toFixed(1) + " h";
}

// A file of any size filled with reproducible pseudo-random bytes: the same size and seed always
// give the same bytes, and the same lastModified, so the uploader recognises it as "the same file".
// Built in 16 MB parts so even 1 GB never sits in memory at once.
export const TEST_FILE_TIME = Date.UTC(2024, 0, 1);
export async function makeTestFile({ bytes, seed = 1, name, onProgress, yieldToUi = () => new Promise((r) => setTimeout(r, 0)) }) {
  const PART = 16 * MB;
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  const parts = [];
  for (let done = 0; done < bytes; done += PART) {
    const len = Math.min(PART, bytes - done);
    const buf = new ArrayBuffer(Math.ceil(len / 4) * 4);
    const words = new Uint32Array(buf);
    for (let i = 0; i < words.length; i++) words[i] = next();
    parts.push(new Blob([len === buf.byteLength ? buf : buf.slice(0, len)]));
    if (onProgress) onProgress(done + len);
    await yieldToUi();
  }
  return new File(parts, name, { type: "application/octet-stream", lastModified: TEST_FILE_TIME });
}

// Compare a downloaded stream with the original file, byte for byte.
// Returns { same, serverBytes, localBytes, firstDifference } where firstDifference is a byte offset or null.
export async function compareWithFile(body, file, onProgress) {
  const reader = body.getReader();
  let pos = 0;
  let diff = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (diff === null) {
      const local = new Uint8Array(await file.slice(pos, pos + value.length).arrayBuffer());
      const n = Math.min(local.length, value.length);
      for (let i = 0; i < n; i++) {
        if (local[i] !== value[i]) { diff = pos + i; break; }
      }
      if (diff === null && local.length < value.length) diff = pos + local.length;   // the server has extra bytes
    }
    pos += value.length;
    if (onProgress) onProgress(pos);
    if (diff !== null) { await reader.cancel(); break; }
  }
  if (diff === null && pos < file.size) diff = pos;                                // the server stopped early
  return { same: diff === null, serverBytes: pos, localBytes: file.size, firstDifference: diff };
}
