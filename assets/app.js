// Starts everything. Each module wires its own card; nothing here knows how they work.
import { renderDetails, state } from "./core.js";
import { initLog } from "./log.js";
import { initUploader } from "./uploader.js";
import { initTokenTimer, checkServer, initTestFile, initMetadata, initVerify, initSaved, initAppend } from "./tools.js";

renderDetails();
initLog();
initUploader();
initTokenTimer();
initTestFile();
initMetadata();
initVerify();
initSaved();
initAppend();
document.getElementById("check").addEventListener("click", checkServer);

// serve.py tells the page which mode it runs in (the page also works on a plain static host)
fetch("/__tus/info").then((r) => (r.ok ? r.json() : null)).then((info) => {
  if (info) state.info = { ...state.info, ...info };
}).catch(() => {});
