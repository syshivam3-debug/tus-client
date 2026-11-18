// Fault injection card. The rules live in serve.py (it sits between the page and the service), so they
// work with both the mock server and a real service behind --target.
import { $, state } from "./core.js";

const URL_ = "/__tus/faults";
const TYPES = {
  none: "No fault is active.",
  lose_response: "lose the answer",
  cut_request: "cut a chunk in half",
  error: "answer with an error",
};

const describe = (s) => {
  const parts = [];
  if (s.rule.type !== "none") {
    parts.push("Rule: " + TYPES[s.rule.type] + " (after " + s.rule.after + " chunk" + (s.rule.after === 1 ? "" : "s") +
      ", " + s.rule.times + " time" + (s.rule.times === 1 ? "" : "s") +
      (s.rule.type === "error" ? ", status " + s.rule.status : "") + "). Fired " + s.fired + " of " + s.rule.times +
      "; chunks seen so far: " + s.patches_seen + ".");
  }
  if (s.latency_ms) parts.push("Every request waits " + s.latency_ms + " ms.");
  if (s.throttle_kbps) parts.push("Uploads are limited to " + s.throttle_kbps + " KB/s.");
  return parts.join(" ") || TYPES.none;
};

export function initFaults() {
  const card = $("faults-card");
  card.hidden = !state.info.faults;       // only serve.py can inject faults
  if (card.hidden) return;

  const show = (text, bad) => { const el = $("f-state"); el.textContent = text; el.style.color = bad ? "var(--bad)" : ""; };
  const refresh = async () => {
    try { const r = await fetch(URL_); if (r.ok) show(describe(await r.json())); } catch { /* server stopped */ }
  };
  const syncStatusField = () => { $("f-status").disabled = $("f-type").value !== "error"; };
  $("f-type").addEventListener("change", syncStatusField);
  syncStatusField();

  $("f-apply").addEventListener("click", async () => {
    const n = (id) => Number($(id).value) || 0;
    const body = {
      latency_ms: n("f-latency"), throttle_kbps: n("f-kbps"),
      rule: { type: $("f-type").value, after: n("f-after"), times: Math.max(1, n("f-times")), status: n("f-status") || 503 },
    };
    try {
      const r = await fetch(URL_, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) return show("Not applied: " + (j.error || r.status), true);
      show(describe(j));
    } catch (e) { show("Not applied: " + e.message, true); }
  });
  $("f-clear").addEventListener("click", async () => {
    try { const r = await fetch(URL_, { method: "DELETE" }); show(describe(await r.json())); } catch (e) { show(e.message, true); }
  });

  setInterval(() => { if (card.open) refresh(); }, 1500);
  card.addEventListener("toggle", () => { if (card.open) refresh(); });
  refresh();
}
