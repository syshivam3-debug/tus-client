// Shared helpers and state. Everything here is small and has no dependencies,
// so the other modules (and the node tests) can import it freely.

export const $ = (id) => document.getElementById(id);
export const MB = 1024 * 1024;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const fmt = (n) => {
  if (n == null || Number.isNaN(Number(n))) return "-";
  n = Number(n);
  if (n < 1024) return n + " B";
  if (n < MB) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * MB) return (n / MB).toFixed(1) + " MB";
  return (n / (1024 * MB)).toFixed(2) + " GB";
};

export const pathOf = (u) => {
  const x = new URL(u, globalThis.location ? location.href : "http://localhost/");
  return x.pathname + x.search;
};
export const lastSegment = (p) => p.split("?")[0].split("/").filter(Boolean).pop() || "";

// base64 of UTF-8 text, as used by Upload-Metadata
export const b64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

// The page's shared state. Modules read it and publish changes through `bus`.
export const state = {
  uploadPath: null,     // path of the upload session (from the POST Location header)
  fileLocation: null,   // Content-Location from the final PATCH response
  file: null,           // the Blob/File currently loaded into the uploader
  info: { mode: null, target: null, faults: false },   // from /__tus/info when served by serve.py
};
export const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));

// ---- values from the Connection card ----
export const endpoint = () => $("endpoint").value.trim();

// the Authorization header value from the form; a bare token gets "Bearer " added
export const authHeader = () => {
  let token = $("auth").value.trim();
  if (token && !/^\w+\s/.test(token)) token = "Bearer " + token;
  return token;
};

// ---- banner and live details (used by several modules) ----
export const banner = (kind, text) => {
  const b = $("banner");
  b.className = "banner show " + kind;
  b.textContent = text;
};

export const details = new Map();
export const renderDetails = () => {
  const box = $("details");
  box.replaceChildren();
  if (!details.size) {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "Nothing yet. Add a file to begin.";
    box.append(d);
    return;
  }
  for (const [k, v] of details) {
    const a = document.createElement("span"); a.className = "k"; a.textContent = k;
    const b = document.createElement("span"); b.className = "v"; b.textContent = v;
    box.append(a, b);
  }
};
export const setDetail = (key, value) => { details.set(key, String(value)); renderDetails(); };
