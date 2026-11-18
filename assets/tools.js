// The small developer tools around the upload: token timer, server check, test file, metadata,
// verify, interrupted uploads and append mode. Each init* function wires one card.
import { $, MB, fmt, pathOf, b64, state, bus, endpoint, banner, setDetail } from "./core.js";
import { request } from "./api.js";
import { jwtSecondsLeft, humanDuration, makeTestFile, compareWithFile } from "./lib.js";
import { uppy, tus, loadFile } from "./uploader.js";

// ---------------------------------------------------------------- token timer
export function initTokenTimer() {
  const hint = $("token-hint");
  const show = () => {
    const left = jwtSecondsLeft($("auth").value);
    if (left == null) { hint.textContent = ""; hint.className = "sub"; return; }
    if (left <= 0) { hint.textContent = "This token expired " + humanDuration(left) + " ago. Paste a fresh one."; hint.className = "sub bad"; }
    else if (left < 300) { hint.textContent = "This token expires in " + humanDuration(left) + "."; hint.className = "sub warn"; }
    else { hint.textContent = "This token expires in " + humanDuration(left) + "."; hint.className = "sub"; }
  };
  $("auth").addEventListener("input", show);
  setInterval(show, 15000);
  show();
}

// ---------------------------------------------------------------- server check
// The extensions the architecture decision (ADR) asks for.
const EXPECTED = [
  ["creation", "needed to start an upload"],
  ["creation-defer-length", "start before the size is known (append)"],
  ["termination", "cancel and clean up an upload"],
  ["expiration", "incomplete uploads expire"],
  ["checksum", "each chunk can be verified"],
];

export async function checkServer() {
  const box = $("caps");
  box.replaceChildren();
  $("caps-card").open = true;
  let r;
  try {
    r = await request("OPTIONS", endpoint());
  } catch (e) {
    banner("bad", "The browser could not reach " + endpoint() + ": " + e.message);
    return null;
  }
  const version = r.headers.get("Tus-Version");
  const exts = (r.headers.get("Tus-Extension") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const max = r.headers.get("Tus-Max-Size");
  const row = (k, v, cls) => {
    const a = document.createElement("span"); a.className = "k"; a.textContent = k;
    const b = document.createElement("span"); b.className = "v " + (cls || ""); b.textContent = v;
    box.append(a, b);
  };
  row("Answer", r.status + (r.status >= 200 && r.status < 300 ? "" : " (a tus server answers 200 or 204 to OPTIONS)"), r.status >= 200 && r.status < 300 ? "ok" : "bad");
  row("Tus-Version", version || "not advertised", version && version.split(",").map((s) => s.trim()).includes("1.0.0") ? "ok" : "bad");
  row("Tus-Max-Size", max ? fmt(max) + " (" + max + " bytes)" : "not advertised", max ? "" : "muted");
  for (const [name, why] of EXPECTED) {
    const have = exts.includes(name);
    row(name, have ? "supported" : "not advertised yet (" + why + ")", have ? "ok" : "warn");
  }
  const others = exts.filter((e) => !EXPECTED.some(([n]) => n === e));
  if (others.length) row("Also advertised", others.join(", "));
  state.caps = { status: r.status, version, extensions: exts, maxSize: max ? Number(max) : null };
  return state.caps;
}

// ---------------------------------------------------------------- test file
export function initTestFile() {
  const status = $("gen-status");
  const sizeInput = $("gen-size");
  for (const b of document.querySelectorAll("[data-gen-mb]")) {
    b.addEventListener("click", () => { sizeInput.value = b.dataset.genMb; });
  }
  $("gen-go").addEventListener("click", async () => {
    const mb = Number(sizeInput.value);
    if (!(mb > 0) || mb > 4096) { status.textContent = "Enter a size between 0.001 and 4096 MB."; return; }
    const bytes = Math.max(1, Math.round(mb * MB));
    const seed = Math.max(0, Math.floor(Number($("gen-seed").value) || 0));
    const name = ($("gen-name").value.trim()) || "test-" + (mb >= 1 ? mb + "MB" : bytes + "B") + "-seed" + seed + ".bin";
    $("gen-go").disabled = true;
    try {
      const file = await makeTestFile({
        bytes, seed, name,
        onProgress: (n) => { status.textContent = "Creating " + fmt(bytes) + " ... " + Math.floor((n / bytes) * 100) + "%"; },
      });
      loadFile(file);
      status.textContent = "Added " + name + " (" + fmt(bytes) + "). The same size and seed always give the same bytes.";
    } catch (e) {
      status.textContent = "Could not create the file: " + e.message;
    } finally {
      $("gen-go").disabled = false;
    }
  });
}

// ---------------------------------------------------------------- upload metadata
const meta = [];                                   // [{ key, value }]
const BASE_META = ["name", "type", "filename", "filetype"];

export function initMetadata() {
  const list = $("meta-rows");
  const apply = () => {
    const custom = meta.filter((m) => m.key.trim());
    tus().setOptions({ allowedMetaFields: [...BASE_META, ...custom.map((m) => m.key.trim())] });
    const values = Object.fromEntries(custom.map((m) => [m.key.trim(), m.value]));
    for (const f of uppy.getFiles()) uppy.setFileMeta(f.id, values);
    $("meta-note").textContent = custom.length
      ? "Sent with the next upload: filename, filetype, " + custom.map((m) => m.key.trim()).join(", ") + "."
      : "Only the file name and type are sent.";
  };
  const render = () => {
    list.replaceChildren();
    meta.forEach((m, i) => {
      const line = document.createElement("div"); line.className = "rowline";
      const k = document.createElement("input"); k.placeholder = "key"; k.value = m.key; k.spellcheck = false;
      const v = document.createElement("input"); v.placeholder = "value"; v.value = m.value; v.spellcheck = false;
      const x = document.createElement("button"); x.type = "button"; x.className = "secondary small"; x.textContent = "Remove";
      k.addEventListener("input", () => { m.key = k.value; apply(); });
      v.addEventListener("input", () => { m.value = v.value; apply(); });
      x.addEventListener("click", () => { meta.splice(i, 1); render(); apply(); });
      line.append(k, v, x);
      list.append(line);
    });
  };
  $("meta-add").addEventListener("click", () => { meta.push({ key: "", value: "" }); render(); });
  bus.addEventListener("file-added", () => {
    apply();
    const custom = meta.filter((m) => m.key.trim());
    if (custom.length) setDetail("Metadata sent", custom.map((m) => m.key.trim() + "=" + m.value).join(", "));
  });
  render();
  apply();
}

// ---------------------------------------------------------------- verify the finished file
export function initVerify() {
  const out = $("verify-result");
  let running = false;
  const run = async () => {
    if (running) return;
    if (!state.file || !state.fileLocation) { banner("warn", "Finish an upload first, then verify it."); return; }
    running = true;
    $("verify").disabled = true;
    out.hidden = false;
    const url = pathOf(state.fileLocation).replace(/\/+$/, "") + "/content";
    out.textContent = "Downloading " + url + " and comparing it with the original ...";
    try {
      const r = await request("GET", url, { tus: false });
      if (r.status < 200 || r.status > 299) {
        out.textContent = "The service answered " + r.status + " for " + url + ".";
        setDetail("Integrity check", "Could not download: " + r.status);
        return;
      }
      const total = state.file.size;
      const res = await compareWithFile(r.res.body, state.file, (n) => {
        out.textContent = "Comparing ... " + fmt(n) + " of " + fmt(total);
      });
      if (res.same) {
        out.textContent = "Identical. The downloaded file matches the original, byte for byte (" + fmt(res.serverBytes) + ", " + res.serverBytes + " bytes).";
        setDetail("Integrity check", "Passed: identical to the original (" + res.serverBytes + " bytes)");
      } else {
        out.textContent = "Different. First difference at byte " + res.firstDifference + ". Server sent " + res.serverBytes +
          " bytes, original has " + res.localBytes + ".";
        setDetail("Integrity check", "FAILED at byte " + res.firstDifference);
      }
    } catch (e) {
      out.textContent = "Could not verify: " + e.message;
    } finally {
      running = false;
      $("verify").disabled = false;
    }
  };
  $("verify").addEventListener("click", run);
  bus.addEventListener("complete", () => { if ($("verify-auto").checked) setTimeout(run, 300); });
}

// ---------------------------------------------------------------- interrupted uploads
export function initSaved() {
  const list = $("saved-list");
  const read = () => {
    const found = [];
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith("tus::")) continue;
      try {
        const v = JSON.parse(localStorage.getItem(key));
        if (v && v.uploadUrl) found.push({ key, v });
      } catch { /* not ours */ }
    }
    return found;
  };
  const render = () => {
    list.replaceChildren();
    const found = read();
    if (!found.length) {
      const d = document.createElement("div");
      d.className = "kv"; d.innerHTML = '<div class="empty">No saved uploads. Start one and reload the page to see it here.</div>';
      list.append(d);
      return;
    }
    for (const { key, v } of found) {
      const line = document.createElement("div"); line.className = "rowline";
      const name = document.createElement("div"); name.className = "name";
      const m = v.metadata || {};
      name.textContent = (m.name || m.filename || "(unnamed file)") + " - " + fmt(v.size);
      const small = document.createElement("small"); small.textContent = pathOf(v.uploadUrl);
      name.append(small);
      const ask = document.createElement("button"); ask.type = "button"; ask.className = "secondary small"; ask.textContent = "Ask server";
      const forget = document.createElement("button"); forget.type = "button"; forget.className = "secondary small"; forget.textContent = "Forget";
      ask.addEventListener("click", async () => {
        try {
          const r = await request("HEAD", pathOf(v.uploadUrl));
          if (r.status === 200) {
            small.textContent = pathOf(v.uploadUrl) + "  ->  server has " + fmt(r.headers.get("Upload-Offset")) + " of " + fmt(r.headers.get("Upload-Length") || v.size);
          } else {
            small.textContent = pathOf(v.uploadUrl) + "  ->  the server answers " + r.status + " (gone or expired)";
          }
        } catch (e) { small.textContent = "could not ask: " + e.message; }
      });
      forget.addEventListener("click", () => { localStorage.removeItem(key); render(); });
      line.append(name, ask, forget);
      list.append(line);
    }
  };
  $("saved-reload").addEventListener("click", () => location.reload());
  bus.addEventListener("session", render);
  bus.addEventListener("saved-changed", render);
  bus.addEventListener("complete", () => setTimeout(render, 200));
  render();
}

// ---------------------------------------------------------------- append mode (deferred length)
export function initAppend() {
  const st = { url: null, offset: 0, location: null };
  const out = $("append-out");
  const show = (text) => { out.hidden = false; out.textContent = text; };
  const need = (what) => { show(what); return false; };
  const sync = () => {
    $("append-add").disabled = !st.url || !!st.location;
    $("append-finish").disabled = !st.url || !!st.location;
    $("append-read").disabled = !st.location;
  };
  sync();

  $("append-start").addEventListener("click", async () => {
    try {
      const r = await request("POST", endpoint(), {
        headers: {
          "Upload-Defer-Length": "1",
          "Upload-Metadata": "filename " + b64("append-test.log") + ",filetype " + b64("text/plain"),
        },
      });
      const loc = r.headers.get("Location");
      if (r.status !== 201 || !loc) {
        show("The service answered " + r.status + " (a deferred-length upload needs 201 and a Location header). " +
          "Is the creation-defer-length extension implemented?");
        return;
      }
      st.url = pathOf(loc); st.offset = 0; st.location = null;
      show("Created " + st.url + " without a length. Now append lines, then press Finish.");
    } catch (e) { show("Could not start: " + e.message); }
    sync();
  });

  $("append-add").addEventListener("click", async () => {
    if (!st.url) return need("Start a log upload first.");
    const line = ($("append-line").value || "line") + "\n";
    const body = new TextEncoder().encode(line);
    try {
      const r = await request("PATCH", st.url, {
        headers: { "Upload-Offset": String(st.offset), "Content-Type": "application/offset+octet-stream" }, body,
      });
      if (r.status !== 204) { show("PATCH answered " + r.status + "."); return; }
      st.offset = Number(r.headers.get("Upload-Offset"));
      show("Appended " + body.length + " bytes. The server now has " + st.offset + " bytes of an upload whose length is still open.");
    } catch (e) { show("Could not append: " + e.message); }
  });

  $("append-finish").addEventListener("click", async () => {
    if (!st.url) return need("Start a log upload first.");
    try {
      const r = await request("PATCH", st.url, {
        headers: { "Upload-Offset": String(st.offset), "Upload-Length": String(st.offset), "Content-Type": "application/offset+octet-stream" },
        body: new Uint8Array(0),
      });
      if (r.status !== 204) { show("Finishing answered " + r.status + "."); return; }
      st.location = r.headers.get("Content-Location");
      show("Finished at " + st.offset + " bytes." + (st.location ? " The file is at " + st.location + "." : " The response had no Content-Location header."));
    } catch (e) { show("Could not finish: " + e.message); }
    sync();
  });

  $("append-read").addEventListener("click", async () => {
    if (!st.location) return;
    try {
      const r = await request("GET", pathOf(st.location).replace(/\/+$/, "") + "/content", { tus: false });
      const text = await r.res.text();
      show("Read back (" + r.status + "):\n" + text);
    } catch (e) { show("Could not read it back: " + e.message); }
  });
}
