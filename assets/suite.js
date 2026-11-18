// The test suite: a scripted conformance check of a tus server (protocol 1.0.0 plus the extensions the
// architecture decision asks for). It has no page access, so node can run it too (tests/suite.test.mjs).
//
//   runSuite({ endpoint, request, cleanup }, onResult) -> { results, counts }
//
// `endpoint` is an absolute URL. `request(method, url, { headers, body, tus })` must return
// { status, headers (a Headers), res } like api.js does. Statuses: pass, fail, warn (the protocol says
// SHOULD, or the service differs in a harmless way), skip (an extension the server does not advertise).

class Skip extends Error {}
class Fail extends Error {}
const must = (cond, msg) => { if (!cond) throw new Fail(msg); };

const b64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const bytes = (text) => new TextEncoder().encode(text);
const uuid = () => "00000000-0000-4000-8000-" + Math.random().toString(16).slice(2, 14).padEnd(12, "0");

export async function runSuite({ endpoint, request, cleanup = true }, onResult = () => {}) {
  const created = [];            // every upload we start, so it can be removed afterwards
  const st = { caps: null, main: null, contentLocation: null };

  const req = (method, url, o) => request(method, url, { ...o });
  const resolve = (loc) => new URL(loc, endpoint).href;
  const head = (loc) => req("HEAD", loc);
  const patch = (loc, offset, body, headers = {}) => req("PATCH", loc, {
    headers: { "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream", ...headers }, body,
  });
  const create = async (length, headers = {}) => {
    const r = await req("POST", endpoint, { headers: { "Upload-Length": String(length), ...headers } });
    const loc = r.headers.get("Location");
    if (loc) created.push(resolve(loc));
    return { r, loc: loc ? resolve(loc) : null };
  };
  const has = (ext) => st.caps && st.caps.extensions.includes(ext);
  const needExt = (ext) => { if (!has(ext)) throw new Skip("the server does not advertise " + ext); };
  const offsetOf = async (loc) => Number((await head(loc)).headers.get("Upload-Offset"));
  const need = (what) => { if (!st.main) throw new Skip("needs the create test (" + what + ") to pass first"); return st.main; };

  const tests = [
    ["OPTIONS advertises tus 1.0.0", async () => {
      const r = await req("OPTIONS", endpoint, { tus: false });
      const version = (r.headers.get("Tus-Version") || "").split(",").map((s) => s.trim());
      const exts = (r.headers.get("Tus-Extension") || "").split(",").map((s) => s.trim()).filter(Boolean);
      const max = r.headers.get("Tus-Max-Size");
      st.caps = { extensions: exts, maxSize: max ? Number(max) : null };
      must(r.status === 200 || r.status === 204, "OPTIONS answered " + r.status + " (expected 200 or 204)");
      must(version.includes("1.0.0"), "Tus-Version is " + JSON.stringify(r.headers.get("Tus-Version")) + ", expected 1.0.0");
      return "extensions: " + (exts.join(", ") || "none") + (max ? "; max size " + max : "");
    }],

    ["A request without Tus-Resumable is refused", async () => {
      const r = await req("POST", endpoint, { tus: false, headers: { "Upload-Length": "5" } });
      const loc = r.headers.get("Location");
      if (loc) created.push(resolve(loc));
      if (r.status === 412) return "412, as the protocol says";
      if (r.status === 400) return { warn: "answered 400; the protocol says 412 Precondition Failed" };
      throw new Fail("answered " + r.status + ", expected 412");
    }],

    ["POST creates an upload (201 and a Location)", async () => {
      const { r, loc } = await create(20);
      must(r.status === 201, "answered " + r.status + ", expected 201");
      must(loc, "the response has no Location header");
      st.main = loc;
      return new URL(loc).pathname;
    }],

    ["HEAD on a new upload: offset 0 and the length", async () => {
      const loc = need("HEAD");
      const r = await head(loc);
      must(r.status === 200, "answered " + r.status + ", expected 200");
      must(r.headers.get("Upload-Offset") === "0", "Upload-Offset is " + r.headers.get("Upload-Offset") + ", expected 0");
      must(r.headers.get("Upload-Length") === "20", "Upload-Length is " + r.headers.get("Upload-Length") + ", expected 20");
      const cc = r.headers.get("Cache-Control") || "";
      if (!/no-store/i.test(cc)) return { warn: "Cache-Control is not no-store (the protocol says it SHOULD be)" };
    }],

    ["PATCH sends the first chunk (204, new offset)", async () => {
      const loc = need("PATCH");
      const r = await patch(loc, 0, bytes("0123456789"));
      must(r.status === 204, "answered " + r.status + ", expected 204");
      must(r.headers.get("Upload-Offset") === "10", "Upload-Offset is " + r.headers.get("Upload-Offset") + ", expected 10");
    }],

    ["HEAD reports the progress (what resume relies on)", async () => {
      const loc = need("HEAD");
      const o = await offsetOf(loc);
      must(o === 10, "Upload-Offset is " + o + ", expected 10");
    }],

    ["PATCH with a wrong offset is refused (409)", async () => {
      const loc = need("PATCH");
      const r = await patch(loc, 3, bytes("x"));
      must(r.status === 409, "answered " + r.status + ", expected 409");
      const o = await offsetOf(loc);
      must(o === 10, "the offset moved to " + o + " after a refused request");
    }],

    ["PATCH with the wrong Content-Type is refused (415)", async () => {
      const loc = need("PATCH");
      const r = await req("PATCH", loc, { headers: { "Upload-Offset": "10", "Content-Type": "text/plain" }, body: bytes("x") });
      if (r.status === 415) return "415, as the protocol says";
      if (r.status >= 400 && r.status < 500) return { warn: "answered " + r.status + "; the protocol says 415" };
      throw new Fail("answered " + r.status + ", expected 415");
    }],

    ["PATCH finishes the upload and the service reports the file", async () => {
      const loc = need("PATCH");
      const r = await patch(loc, 10, bytes("abcdefghij"));
      must(r.status === 204, "answered " + r.status + ", expected 204");
      must(r.headers.get("Upload-Offset") === "20", "Upload-Offset is " + r.headers.get("Upload-Offset") + ", expected 20");
      const cl = r.headers.get("Content-Location");
      if (!cl) return { warn: "no Content-Location header (this service is expected to return the file's location)" };
      st.contentLocation = resolve(cl);
      return new URL(st.contentLocation).pathname;
    }],

    ["A finished upload refuses more data", async () => {
      const loc = need("PATCH");
      const r = await patch(loc, 20, bytes("z"));
      must(r.status >= 400 && r.status < 500, "answered " + r.status + ", expected an error (400, 403 or 409)");
    }],

    ["The downloaded file matches what was sent", async () => {
      if (!st.contentLocation) throw new Skip("no Content-Location from the finishing PATCH");
      const r = await req("GET", st.contentLocation.replace(/\/+$/, "") + "/content", { tus: false });
      must(r.status === 200, "GET .../content answered " + r.status);
      const text = await r.res.text();
      must(text === "0123456789abcdefghij", "content is " + JSON.stringify(text.slice(0, 40)) + ", expected the 20 bytes that were sent");
    }],

    ["HEAD on an unknown upload answers 404 or 410", async () => {
      const r = await head(new URL(uuid(), endpoint.replace(/\/+$/, "") + "/").href);
      must(r.status === 404 || r.status === 410, "answered " + r.status + ", expected 404 or 410");
    }],

    ["An upload above Tus-Max-Size is refused (413)", async () => {
      if (!st.caps || !st.caps.maxSize) throw new Skip("the server does not advertise Tus-Max-Size");
      const { r } = await create(st.caps.maxSize + 1);
      must(r.status === 413, "answered " + r.status + ", expected 413");
    }],

    ["Upload-Metadata is accepted and returned", async () => {
      const { r, loc } = await create(5, { "Upload-Metadata": "folder " + b64("reports") + ",filename " + b64("a.txt") });
      must(r.status === 201, "answered " + r.status + " when creating with metadata");
      const h = await head(loc);
      const md = h.headers.get("Upload-Metadata");
      if (!md || !md.includes("folder")) return { warn: "HEAD does not return Upload-Metadata (optional in the protocol)" };
    }],

    ["expiration: Upload-Expires is returned", async () => {
      needExt("expiration");
      const { r } = await create(5);
      must(r.status === 201, "answered " + r.status);
      const exp = r.headers.get("Upload-Expires");
      must(exp, "no Upload-Expires header on an unfinished upload");
      must(!Number.isNaN(Date.parse(exp)), "Upload-Expires is not a date: " + exp);
      return exp;
    }],

    ["creation-defer-length: create without a length, then set it", async () => {
      needExt("creation-defer-length");
      const r = await req("POST", endpoint, { headers: { "Upload-Defer-Length": "1" } });
      const loc0 = r.headers.get("Location");
      if (loc0) created.push(resolve(loc0));
      must(r.status === 201 && loc0, "creating with Upload-Defer-Length: 1 answered " + r.status);
      const loc = resolve(loc0);
      const h = await head(loc);
      must(!h.headers.get("Upload-Length"), "HEAD returned Upload-Length " + h.headers.get("Upload-Length") + " before the length was known");
      const p1 = await patch(loc, 0, bytes("hello"));
      must(p1.status === 204, "first PATCH answered " + p1.status);
      const p2 = await req("PATCH", loc, { headers: { "Upload-Offset": "5", "Upload-Length": "5", "Content-Type": "application/offset+octet-stream" }, body: new Uint8Array(0) });
      must(p2.status === 204, "setting the length with a final PATCH answered " + p2.status);
      const h2 = await head(loc);
      must(h2.headers.get("Upload-Length") === "5", "Upload-Length is " + h2.headers.get("Upload-Length") + " after it was set, expected 5");
    }],

    ["checksum: a wrong checksum is refused (460), a right one accepted", async () => {
      needExt("checksum");
      if (!globalThis.crypto || !crypto.subtle) throw new Skip("this browser context has no crypto.subtle (use http://localhost)");
      const { r, loc } = await create(4);
      must(r.status === 201 && loc, "create answered " + r.status);
      const sha1 = async (text) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes(text)))));
      const bad = await patch(loc, 0, bytes("data"), { "Upload-Checksum": "sha1 " + await sha1("something else") });
      must(bad.status === 460, "a wrong checksum answered " + bad.status + ", expected 460");
      const o = await offsetOf(loc);
      must(o === 0, "the offset moved to " + o + " after a chunk with a wrong checksum");
      const good = await patch(loc, 0, bytes("data"), { "Upload-Checksum": "sha1 " + await sha1("data") });
      must(good.status === 204, "a right checksum answered " + good.status + ", expected 204");
    }],

    ["termination: DELETE removes an upload", async () => {
      needExt("termination");
      const { r, loc } = await create(5);
      must(r.status === 201 && loc, "create answered " + r.status);
      const d = await req("DELETE", loc);
      must(d.status === 204 || d.status === 200, "DELETE answered " + d.status + ", expected 204");
      const h = await head(loc);
      must(h.status === 404 || h.status === 410, "HEAD after DELETE answered " + h.status + ", expected 404 or 410");
    }],
  ];

  const results = [];
  for (const [name, fn] of tests) {
    const t0 = Date.now();
    let res;
    try {
      const out = await fn();
      res = out && out.warn ? { status: "warn", detail: out.warn } : { status: "pass", detail: typeof out === "string" ? out : "" };
    } catch (e) {
      if (e instanceof Skip) res = { status: "skip", detail: e.message };
      else if (e instanceof Fail) res = { status: "fail", detail: e.message };
      else res = { status: "fail", detail: "the request failed: " + (e && e.message ? e.message : e) };
    }
    res = { name, ms: Date.now() - t0, ...res };
    results.push(res);
    onResult(res, results.length, tests.length);
  }

  if (cleanup) {
    for (const loc of new Set(created)) { try { await req("DELETE", loc); } catch { /* best effort */ } }
  }
  const counts = { pass: 0, fail: 0, warn: 0, skip: 0 };
  for (const r of results) counts[r.status] += 1;
  return { results, counts };
}

export const reportText = ({ results, counts }, endpoint) =>
  "tus test suite for " + endpoint + "\n" +
  results.map((r) => r.status.toUpperCase().padEnd(5) + " " + r.name + (r.detail ? "  [" + r.detail + "]" : "")).join("\n") +
  "\n\n" + counts.pass + " passed, " + counts.fail + " failed, " + counts.warn + " warnings, " + counts.skip + " skipped\n";
