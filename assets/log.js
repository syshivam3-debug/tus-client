// The request log. Every request the page makes is recorded here, so a line can be
// opened to see its headers, copied as a curl command, or exported to share in a bug report.
import { $, state } from "./core.js";

const entries = [];
const SECRET = /^authorization$/i;

const mask = (headers) => {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) out[k] = SECRET.test(k) ? "<hidden>" : v;
  return out;
};

const shellQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

// A curl command for one request. The token is never written out: curl reads it from $TOKEN.
export function toCurl(e) {
  const origin = state.info.target || location.origin;
  const url = origin.replace(/\/+$/, "") + e.path;
  const parts = ["curl -i", "-X " + e.method, shellQuote(url)];
  for (const [k, v] of Object.entries(e.reqHeaders || {})) {
    if (SECRET.test(k)) parts.push('-H "Authorization: $TOKEN"');
    else if (!/^content-length$/i.test(k)) parts.push("-H " + shellQuote(k + ": " + v));
  }
  if (e.method === "PATCH") parts.push("--data-binary @chunk.bin");
  const head = e.reqHeaders && Object.keys(e.reqHeaders).some((k) => SECRET.test(k))
    ? "# first: export TOKEN='Bearer <your token>'\n" : "";
  return head + parts.join(" \\\n  ");
}

const headerBlock = (h) => Object.entries(h || {}).map(([k, v]) => k + ": " + v).join("\n") || "(none captured)";

function render(e) {
  const li = document.createElement("li");
  li.className = "entry";
  const head = document.createElement("div");
  const m = document.createElement("span");
  m.className = "m " + e.method;
  m.textContent = e.method;
  head.append(e.time + "  ", m, " " + e.text);
  li.append(head);

  let open = null;
  li.addEventListener("click", (ev) => {
    if (open && open.contains(ev.target)) return;
    if (open) { open.remove(); open = null; return; }
    open = document.createElement("div");
    open.className = "logdetail";
    const h1 = document.createElement("h3"); h1.textContent = "Request";
    const t1 = document.createTextNode(e.method + " " + e.path + "\n" + headerBlock(mask(e.reqHeaders)));
    const h2 = document.createElement("h3"); h2.textContent = "Response" + (e.status ? " " + e.status : "");
    const t2 = document.createTextNode(headerBlock(e.resHeaders) + (e.ms != null ? "\n(" + Math.round(e.ms) + " ms)" : ""));
    const row = document.createElement("div"); row.className = "controls";
    const copy = document.createElement("button");
    copy.type = "button"; copy.className = "secondary small"; copy.textContent = "Copy as curl";
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(toCurl(e)); copy.textContent = "Copied"; }
      catch { copy.textContent = "Copy failed"; }
      setTimeout(() => (copy.textContent = "Copy as curl"), 1500);
    });
    row.append(copy);
    open.append(h1, t1, h2, t2, row);
    li.append(open);
  });
  const ol = $("log");
  ol.append(li);
  ol.scrollTop = ol.scrollHeight;
}

// One request that went to the server.
export function addEntry({ method, url, status, reqHeaders, resHeaders, ms, extra = "" }) {
  const path = url.replace(/^https?:\/\/[^/]+/, "");
  const e = {
    time: new Date().toLocaleTimeString(), method, path, status,
    reqHeaders: reqHeaders || {}, resHeaders: resHeaders || {}, ms,
    text: (status || "failed") + "  " + path + extra,
  };
  entries.push(e);
  render(e);
}

// A plain note (for example an error) that is not a request.
export function logNote(kind, text) {
  const e = { time: new Date().toLocaleTimeString(), method: kind, path: "", status: null, text, reqHeaders: {}, resHeaders: {} };
  entries.push(e);
  const li = document.createElement("li");
  const m = document.createElement("span");
  m.className = "m " + kind;
  m.textContent = kind;
  li.append(e.time + "  ", m, " " + text);
  const ol = $("log");
  ol.append(li);
  ol.scrollTop = ol.scrollHeight;
}

export function exportJson() {
  const data = entries.map((e) => ({
    time: e.time, method: e.method, path: e.path, status: e.status, ms: e.ms == null ? undefined : Math.round(e.ms),
    requestHeaders: mask(e.reqHeaders), responseHeaders: e.resHeaders, note: e.status == null ? e.text : undefined,
  }));
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), requests: data }, null, 2)],
    { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "tus-request-log.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function clearLog() {
  entries.length = 0;
  $("log").replaceChildren();
}

export function initLog() {
  $("log-export").addEventListener("click", exportJson);
  $("log-clear").addEventListener("click", clearLog);
}
