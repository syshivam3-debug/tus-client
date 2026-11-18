// Runs the suite against the mock server. Run: node --test tests/suite.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { runSuite, reportText } from "../assets/suite.js";

const PORT = 8791;
const nodeRequest = async (method, url, { headers = {}, body, tus = true } = {}) => {
  const h = { ...headers };
  if (tus && method !== "OPTIONS") h["Tus-Resumable"] = "1.0.0";
  const res = await fetch(url, { method, headers: h, body });
  return { status: res.status, headers: res.headers, res };
};

async function withServer(extraArgs, fn) {
  const srv = spawn("python3", ["serve.py", "--mock", "--port", String(PORT), ...extraArgs], { stdio: "ignore" });
  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(`http://127.0.0.1:${PORT}/__tus/info`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    await fn();
  } finally { srv.kill(); await new Promise((r) => setTimeout(r, 200)); }
}

test("every check passes against the mock server", async () => {
  await withServer([], async () => {
    const out = await runSuite({ endpoint: `http://127.0.0.1:${PORT}/files/uploads`, request: nodeRequest });
    const bad = out.results.filter((r) => r.status !== "pass");
    assert.deepEqual(bad, [], reportText(out, "mock"));
    assert.equal(out.results.length, 18);
  });
});

test("the suite reports failures and skips instead of throwing", async () => {
  // a server that answers 404 to everything: nothing passes, nothing crashes
  const http = await import("node:http");
  const dead = http.createServer((q, s) => { s.statusCode = 404; s.end(); });
  await new Promise((r) => dead.listen(PORT + 1, "127.0.0.1", r));
  try {
    const out = await runSuite({ endpoint: `http://127.0.0.1:${PORT + 1}/files/uploads`, request: nodeRequest });
    assert.equal(out.counts.pass + out.counts.fail + out.counts.warn + out.counts.skip, out.results.length);
    assert.ok(out.counts.fail > 0);
    assert.match(reportText(out, "x"), /FAIL/);
  } finally { dead.close(); }
});
