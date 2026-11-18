// One place that makes requests on the tools' behalf, so each one shows up in the request log.
import { authHeader } from "./core.js";
import { addEntry } from "./log.js";

const SHOWN = ["Tus-Resumable", "Tus-Version", "Tus-Extension", "Tus-Max-Size", "Upload-Offset", "Upload-Length",
  "Upload-Defer-Length", "Upload-Expires", "Upload-Metadata", "Location", "Content-Location", "Content-Type",
  "Content-Length", "Cache-Control"];

const pick = (headers) => {
  const out = {};
  for (const name of SHOWN) { const v = headers.get(name); if (v != null) out[name] = v; }
  return out;
};

// request(method, url, { headers, body, tus = true, log = true })
// Returns { status, headers, res, ms }. Network failures throw.
export async function request(method, url, { headers = {}, body, tus = true, log = true, auth = authHeader } = {}) {
  const h = { ...headers };
  if (tus && method !== "OPTIONS") h["Tus-Resumable"] = "1.0.0";
  const token = auth ? auth() : "";
  if (token) h.Authorization = token;
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(url, { method, headers: h, body });
  } catch (e) {
    if (log) addEntry({ method, url, status: 0, reqHeaders: h, ms: performance.now() - t0, extra: "  " + e.message });
    throw e;
  }
  const ms = performance.now() - t0;
  if (log) addEntry({ method, url, status: res.status, reqHeaders: h, resHeaders: pick(res.headers), ms });
  return { status: res.status, headers: res.headers, res, ms };
}
