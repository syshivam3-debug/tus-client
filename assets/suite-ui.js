// Test suite card: runs assets/suite.js against the endpoint and shows each result as it arrives.
import { $, endpoint } from "./core.js";
import { request } from "./api.js";
import { runSuite, reportText } from "./suite.js";

export function initSuite() {
  let last = null;
  const list = $("suite-list");
  const summary = $("suite-summary");

  const row = (r) => {
    const li = document.createElement("li");
    const chip = document.createElement("span"); chip.className = "chip " + r.status; chip.textContent = r.status.toUpperCase();
    const what = document.createElement("span"); what.className = "what"; what.textContent = r.name;
    if (r.detail) { const why = document.createElement("span"); why.className = "why"; why.textContent = r.detail; what.append(why); }
    li.append(chip, what);
    list.append(li);
  };

  $("suite-run").addEventListener("click", async () => {
    const abs = new URL(endpoint(), location.href).href;
    list.replaceChildren();
    $("suite-run").disabled = true;
    $("suite-copy").disabled = true;
    summary.textContent = "Running ...";
    try {
      last = await runSuite(
        { endpoint: abs, cleanup: $("suite-clean").checked, request: (m, u, o) => request(m, u, { ...o, log: false }) },
        (r, i, total) => { row(r); summary.textContent = "Running ... " + i + " of " + total; },
      );
      const c = last.counts;
      summary.textContent = c.pass + " passed, " + c.fail + " failed, " + c.warn + " warnings, " + c.skip + " skipped.";
      summary.className = "summary " + (c.fail ? "bad" : c.warn ? "warn" : "ok");
      $("suite-copy").disabled = false;
    } catch (e) {
      summary.textContent = "The suite could not run: " + e.message;
      summary.className = "summary bad";
    } finally {
      $("suite-run").disabled = false;
    }
  });

  $("suite-copy").addEventListener("click", async () => {
    if (!last) return;
    try { await navigator.clipboard.writeText(reportText(last, new URL(endpoint(), location.href).href)); $("suite-copy").textContent = "Copied"; }
    catch { $("suite-copy").textContent = "Copy failed"; }
    setTimeout(() => ($("suite-copy").textContent = "Copy report"), 1500);
  });
}
