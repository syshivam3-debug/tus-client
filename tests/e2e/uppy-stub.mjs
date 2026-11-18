// A small stand-in for Uppy, used only by the browser test (run.py) because the test machine cannot
// reach the CDN. It implements just the parts of the Uppy API that assets/uploader.js uses and talks tus
// the way tus-js-client does: POST, then PATCH per chunk, HEAD when resuming, DELETE when a file is removed.
export class Dashboard { static id = "Dashboard"; constructor(uppy, o) { this.uppy = uppy; this.o = o; } }

export class Tus {
  static id = "Tus";
  constructor(uppy, o) { this.uppy = uppy; this.opts = { ...o }; }
  setOptions(o) { Object.assign(this.opts, o); }
}

export class Uppy {
  constructor() { this.files = new Map(); this.h = {}; this.plugins = {}; this.paused = false; this.waiters = []; this.sessions = new Map(); }
  use(P, o) { const p = new P(this, o); this.plugins[P.id] = p; if (P.id === "Dashboard") this.#dash(o.target); return this; }
  getPlugin(id) { return this.plugins[id]; }
  on(ev, fn) { (this.h[ev] ||= []).push(fn); return this; }
  emit(ev, ...a) { (this.h[ev] || []).forEach((f) => f(...a)); }
  getFiles() { return [...this.files.values()]; }
  setFileMeta(id, m) { Object.assign(this.files.get(id).meta, m); }
  #dash(target) {
    this.box = document.querySelector(target);
    this.box.innerHTML = '<div id="stub-name"></div><button id="stub-upload" type="button">Upload</button>';
    this.box.querySelector("#stub-upload").addEventListener("click", () => this.upload());
  }
  addFile({ name, type, data }) {
    const file = { id: name + ":" + Math.random(), name, type, size: data.size, data, meta: { name, type } };
    this.files.set(file.id, file);
    this.box.querySelector("#stub-name").textContent = name;
    this.emit("file-added", file);
  }
  removeFile(id) {
    const f = this.files.get(id);
    this.files.delete(id);
    const s = this.sessions.get(id);
    this.box.querySelector("#stub-name").textContent = "";
    this.emit("file-removed", f);
    if (s) { s.cancelled = true; this.#send(s, "DELETE", s.url).catch(() => {}); this.sessions.delete(id); }
  }
  pauseAll() { this.paused = true; this.emit("upload-pause", null, true); }
  resumeAll() { this.paused = false; this.emit("upload-pause", null, false); const w = this.waiters; this.waiters = []; w.forEach((r) => r()); }
  #wait() { return this.paused ? new Promise((r) => this.waiters.push(r)) : null; }

  async #send(s, method, url, headers = {}, body) {
    const t = this.plugins.Tus.opts;
    const h = { "Tus-Resumable": "1.0.0", ...headers };
    const req = {
      getMethod: () => method, getURL: () => new URL(url, location.href).href,
      setHeader: (k, v) => { h[k] = v; },
      getHeader: (k) => Object.entries(h).find(([n]) => n.toLowerCase() === k.toLowerCase())?.[1],
    };
    if (t.onBeforeRequest) await t.onBeforeRequest(req);
    const r = await fetch(url, { method, headers: h, body });
    const res = { getStatus: () => r.status, getHeader: (k) => r.headers.get(k) };
    if (t.onAfterResponse) await t.onAfterResponse(req, res);
    return r;
  }

  async upload() {
    for (const file of this.getFiles()) {
      const t = this.plugins.Tus.opts;
      const s = { cancelled: false, url: null };
      this.sessions.set(file.id, s);
      this.emit("upload");
      try {
        const allowed = t.allowedMetaFields;
        const keys = Array.isArray(allowed) ? allowed : Object.keys(file.meta);
        const md = keys.filter((k) => file.meta[k] != null).map((k) => k + " " + btoa(file.meta[k])).join(",");
        const post = await this.#send(s, "POST", t.endpoint, { "Upload-Length": String(file.size), "Upload-Metadata": md });
        if (post.status !== 201) throw new Error("failed to create upload: " + post.status);
        s.url = post.headers.get("Location");
        localStorage.setItem("tus::stub::" + file.id, JSON.stringify({ size: file.size, metadata: file.meta, creationTime: new Date().toString(), uploadUrl: new URL(s.url, location.href).href }));
        let offset = 0, resumed = false;
        while (offset < file.size) {
          const w = this.#wait(); if (w) { await w; resumed = true; }
          if (s.cancelled) return;
          if (resumed) {
            const head = await this.#send(s, "HEAD", s.url);
            offset = Number(head.headers.get("Upload-Offset")); resumed = false;
            if (offset >= file.size) break;
          }
          const chunk = file.data.slice(offset, Math.min(file.size, offset + t.chunkSize));
          const r = await this.#send(s, "PATCH", s.url, { "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream" }, chunk);
          if (s.cancelled) return;
          if (r.status !== 204) throw new Error("unexpected status " + r.status);
          offset = Number(r.headers.get("Upload-Offset"));
          this.emit("upload-progress", file, { bytesUploaded: offset, bytesTotal: file.size });
        }
        for (const k of Object.keys(localStorage)) if (k.startsWith("tus::stub::" + file.id)) localStorage.removeItem(k);
        this.emit("upload-success", file, { uploadURL: s.url });
      } catch (e) { this.emit("upload-error", file, e); }
    }
  }
}
