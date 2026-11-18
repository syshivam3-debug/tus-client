// The upload itself: Uppy with its tus plugin, plus the live panels around it.
import { Uppy, Dashboard, Tus } from "https://releases.transloadit.com/uppy/v5.2.1/uppy.min.mjs";
import { $, MB, sleep, fmt, pathOf, lastSegment, state, emit, endpoint, authHeader, banner, details, renderDetails, setDetail } from "./core.js";
import { addEntry, logNote } from "./log.js";
import { request } from "./api.js";

const MIN_CHUNK = 16 * 1024;     // smallest chunk we will use
const TARGET_CHUNKS = 8;         // slow mode aims for about this many chunks per file
const PACE_MS = 1000;            // slow mode waits this long before each chunk

let resumes = 0;
let chunksSent = 0;
let fileSize = 0;

const REQ_HEADERS = ["Tus-Resumable", "Upload-Offset", "Upload-Length", "Upload-Defer-Length", "Upload-Metadata",
  "Upload-Checksum", "Content-Type", "Authorization"];
const RES_HEADERS = ["Tus-Resumable", "Upload-Offset", "Upload-Length", "Upload-Expires", "Location",
  "Content-Location", "Content-Type", "Cache-Control"];
const grab = (names, get) => {
  const out = {};
  for (const n of names) { const v = get(n); if (v != null && v !== "") out[n] = v; }
  return out;
};

const manualChunk = () => Math.max(MIN_CHUNK, Math.round((Number($("chunk").value) || 2) * MB));
const started = new WeakMap();

export const uppy = new Uppy({ autoProceed: false, restrictions: { maxNumberOfFiles: 1 } })
  .use(Dashboard, {
    inline: true,
    target: "#dashboard",
    height: 320,
    width: "100%",
    showProgressDetails: true,
    proudlyDisplayPoweredByUppy: false,
    note: "One file at a time. Large files are sent in chunks.",
  })
  .use(Tus, {
    endpoint: endpoint(),
    chunkSize: manualChunk(),
    // keep retrying for a while so a short network drop heals by itself
    retryDelays: [0, 1000, 3000, 5000, 10000, 10000, 10000],
    limit: 1,
    // remember the upload URL in localStorage so a page reload can resume too
    storeFingerprintForResuming: true,
    removeFingerprintOnSuccess: true,
    async onBeforeRequest(req) {
      const token = authHeader();
      if (token) req.setHeader("Authorization", token);
      // slow mode: pause before every chunk so there is time to click Pause
      if (req.getMethod() === "PATCH" && $("demo").checked) await sleep(PACE_MS);
      started.set(req, performance.now());
    },
    async onAfterResponse(req, res) {
      const method = req.getMethod();
      const status = res.getStatus();
      const offset = res.getHeader("Upload-Offset");
      const url = req.getURL().replace(/^https?:\/\/[^/]+/, "");
      let extra = "";

      if (method === "POST" && status === 201) {
        const loc = res.getHeader("Location");
        if (loc) {
          state.uploadPath = pathOf(loc);
          setDetail("Upload ID", lastSegment(state.uploadPath));
          setDetail("Upload URL", state.uploadPath);
          const exp = res.getHeader("Upload-Expires");
          if (exp) setDetail("Upload expires", exp);
        }
        setDetail("Status", "Upload session created on the server");
        emit("session", state.uploadPath);
      }
      if (method === "PATCH" && status === 204 && offset != null) {
        chunksSent += 1;
        $("s-offset").textContent = fmt(offset);
        extra = " -> server has " + fmt(offset);
        setDetail("Chunks sent", chunksSent);
        setDetail("Received by server", fmt(offset) + (fileSize ? " of " + fmt(fileSize) : ""));
        if (!state.fileLocation) setDetail("Status", "Uploading");
      }
      if (method === "HEAD" && status === 200) {
        if (offset != null) {
          resumes += 1;
          $("s-resumes").textContent = String(resumes);
          $("s-offset").textContent = fmt(offset);
          extra = " -> server remembers " + fmt(offset);
          setDetail("Times resumed", resumes);
          setDetail("Status", "Resumed: server remembers " + fmt(offset));
          banner("warn", "Connection restored. Continuing from " + fmt(offset) + " instead of starting over.");
        } else {
          extra = " -> Upload-Offset not readable (CORS: expose it, or use serve.py)";
        }
      }
      // when the last chunk lands, the service reports where the finished file lives
      const contentLocation = res.getHeader("Content-Location");
      if (contentLocation && contentLocation !== state.fileLocation) {
        state.fileLocation = contentLocation;
        setDetail("File location", contentLocation);
        setDetail("File ID", lastSegment(pathOf(contentLocation)));
        setDetail("Status", "Finalized by the server");
        $("refresh").disabled = false;
        $("verify").disabled = false;
        extra += " -> file is at " + contentLocation;
        fetchRecord();
        emit("finalized", contentLocation);
      }
      const t0 = started.get(req);
      addEntry({
        method, url, status, extra,
        reqHeaders: grab(REQ_HEADERS, (n) => req.getHeader(n)),
        resHeaders: grab(RES_HEADERS, (n) => res.getHeader(n)),
        ms: t0 == null ? undefined : performance.now() - t0,
      });
    },
  });

export const tus = () => uppy.getPlugin("Tus");
const pausedAt = () => { const o = $("s-offset").textContent; return o === "-" ? "" : " at " + o; };

// slow mode picks a chunk size from the file size; otherwise the field decides
export const applyChunkSize = () => {
  const size = $("demo").checked && fileSize
    ? Math.max(MIN_CHUNK, Math.ceil(fileSize / TARGET_CHUNKS))
    : manualChunk();
  tus().setOptions({ chunkSize: size });
  return size;
};

// read the finished file's record from the file service
export async function fetchRecord() {
  if (!state.fileLocation) return;
  const path = pathOf(state.fileLocation);   // path only, so it goes through this page's own server
  setDetail("File record", "reading " + path + " ...");
  try {
    const r = await request("GET", path, { headers: { Accept: "application/json" }, tus: false });
    if (r.status < 200 || r.status > 299) { setDetail("File record", "the service answered " + r.status + " for " + path); return; }
    const f = await r.res.json();
    details.delete("File record");
    const fields = [["name", "Name on server"], ["size", "Size on server"], ["contentType", "Content type"],
                    ["createdBy", "Created by"], ["creationTimeStamp", "Created at"], ["fileStatus", "File status"]];
    for (const [k, label] of fields) {
      if (f[k] !== undefined) details.set(label, k === "size" ? fmt(f.size) + " (" + f.size + " bytes)" : f[k]);
    }
    renderDetails();
  } catch (e) {
    setDetail("File record", "could not read it: " + e.message);
  }
}

// Replace whatever is loaded with this file (used by the test-file tool).
export function loadFile(file) {
  for (const f of uppy.getFiles()) uppy.removeFile(f.id);
  uppy.addFile({ name: file.name, type: file.type || "application/octet-stream", data: file, source: "Local" });
}

// Terminate: ask the service to delete the unfinished upload, then confirm that it is gone.
async function terminate() {
  const files = uppy.getFiles();
  if (!state.uploadPath) {
    banner("warn", "There is no upload session yet. Start an upload first, then terminate it.");
    return;
  }
  if (state.fileLocation && !confirm("This upload is already complete, so terminating it may delete the finished file. Continue?")) return;
  const url = state.uploadPath;
  uppy.pauseAll();
  setDetail("Status", "Terminating...");
  // Removing the file makes the uploader send DELETE itself. We then check, and send it ourselves if needed.
  for (const f of files) uppy.removeFile(f.id);
  await sleep(500);
  try {
    let head = await request("HEAD", url);
    if (head.status === 200) {
      const del = await request("DELETE", url);
      if (del.status < 200 || del.status > 299) {
        setDetail("Status", "Terminate failed: DELETE answered " + del.status);
        banner("bad", "The service answered " + del.status + " to DELETE. The upload still exists.");
        return;
      }
      head = await request("HEAD", url);
    }
    const gone = head.status === 404 || head.status === 410;
    setDetail("Status", gone ? "Terminated: the server no longer has this upload" : "Terminate sent, but HEAD still answers " + head.status);
    banner(gone ? "ok" : "bad", gone
      ? "Terminated. The server answers " + head.status + " for the upload, so it is gone. Add the file again to start a new upload."
      : "The service still answers " + head.status + " for " + url + " after DELETE.");
  } catch (e) {
    setDetail("Status", "Terminate failed: " + e.message);
    banner("bad", "Could not reach the service: " + e.message);
  }
  forgetSaved(url);
  state.uploadPath = null;
  emit("saved-changed");
}

// drop the "resume after reload" bookmark that points at this upload
function forgetSaved(path) {
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith("tus::")) continue;
    try {
      const v = JSON.parse(localStorage.getItem(key));
      if (v && v.uploadUrl && pathOf(v.uploadUrl) === path) localStorage.removeItem(key);
    } catch { /* not ours */ }
  }
}

export function initUploader() {
  uppy.on("file-added", (file) => {
    details.clear();
    resumes = 0; chunksSent = 0;
    state.fileLocation = null; state.uploadPath = null;
    state.file = file.data;
    fileSize = file.size || 0;
    $("s-resumes").textContent = "0";
    $("s-offset").textContent = "-";
    $("s-bytes").textContent = "0 B of " + fmt(fileSize);
    $("refresh").disabled = true;
    $("verify").disabled = true;
    $("verify-result").hidden = true;
    $("banner").className = "banner";
    setDetail("Status", "Ready to upload");
    setDetail("File name", file.name);
    setDetail("File size", fmt(fileSize) + " (" + fileSize + " bytes)");
    setDetail("File type", file.type || "unknown");
    const c = applyChunkSize();
    setDetail("Chunk size", fmt(c) + ($("demo").checked ? " (about " + Math.ceil(fileSize / c) + " chunks, 1 s apart)" : ""));
    emit("file-added", file);
  });
  uppy.on("upload", () => setDetail("Status", "Connecting to the server"));
  uppy.on("upload-progress", (file, p) => {
    $("s-bytes").textContent = fmt(p.bytesUploaded) + " of " + fmt(p.bytesTotal);
    if (p.bytesTotal) setDetail("Progress", Math.floor((p.bytesUploaded / p.bytesTotal) * 100) + "%");
  });
  uppy.on("upload-pause", (fileID, isPaused) => {
    setDetail("Status", isPaused ? "Paused" + pausedAt() : "Resuming...");
  });
  uppy.on("upload-success", (file, resp) => {
    setDetail("Status", "Complete");
    banner("ok", state.fileLocation
      ? "Upload complete. The file is at " + state.fileLocation
      : "Upload complete" + (resp && resp.uploadURL ? ": " + resp.uploadURL : "."));
    emit("complete");
  });
  uppy.on("upload-error", (file, err) => {
    const msg = String((err && err.message) || err);
    logNote("ERROR", msg.split("\n")[0]);
    setDetail("Status", "Stopped: " + msg.split("\n")[0]);
    const unreachable = /failed to create upload|network|status 0|Failed to fetch/i.test(msg);
    banner("bad", unreachable
      ? "The browser could not talk to the service. Check the endpoint, and see the CORS note in the README (or run serve.py)."
      : "Upload stopped: " + msg.split("\n")[0] + ". Press Retry in the upload panel to continue.");
  });

  $("apply").addEventListener("click", () => {
    tus().setOptions({ endpoint: endpoint() });
    const c = applyChunkSize();
    banner("ok", "Settings applied: " + endpoint() + ", chunk size " + fmt(c) + ".");
  });
  $("demo").addEventListener("change", applyChunkSize);
  $("refresh").addEventListener("click", fetchRecord);
  $("pause").addEventListener("click", () => {
    uppy.pauseAll();
    setDetail("Status", "Paused" + pausedAt());
    banner("warn", "Paused. The server keeps what it already received.");
  });
  $("resume").addEventListener("click", () => {
    uppy.resumeAll();
    setDetail("Status", "Resuming...");
    banner("ok", "Resuming...");
  });
  $("terminate").addEventListener("click", terminate);
}
