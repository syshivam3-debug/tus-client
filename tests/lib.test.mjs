// Run: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { jwtSecondsLeft, humanDuration, makeTestFile, compareWithFile, TEST_FILE_TIME } from "../assets/lib.js";
import { fmt, b64, pathOf, lastSegment } from "../assets/core.js";

const jwt = (payload) => "x." + Buffer.from(JSON.stringify(payload)).toString("base64url") + ".y";
const stream = (bytes, step = 1000) => new ReadableStream({
  start(c) { for (let i = 0; i < bytes.length; i += step) c.enqueue(bytes.slice(i, i + step)); c.close(); },
});

test("jwtSecondsLeft reads exp from a JWT", () => {
  const now = 1_700_000_000_000;
  assert.equal(jwtSecondsLeft("Bearer " + jwt({ exp: 1_700_000_600 }), now), 600);
  assert.equal(jwtSecondsLeft(jwt({ exp: 1_699_999_900 }), now), -100);
  assert.equal(jwtSecondsLeft(jwt({ sub: "no exp" }), now), null);
  assert.equal(jwtSecondsLeft("not-a-jwt", now), null);
  assert.equal(jwtSecondsLeft("", now), null);
});

test("humanDuration", () => {
  assert.equal(humanDuration(45), "45 s");
  assert.equal(humanDuration(-600), "10 min");
  assert.equal(humanDuration(7200), "2.0 h");
});

test("core helpers", () => {
  assert.equal(fmt(1536), "1.5 KB");
  assert.equal(b64("hi"), "aGk=");
  assert.equal(lastSegment("/files/uploads/abc?x=1"), "abc");
  assert.equal(pathOf("https://h.example/files/uploads/abc?x=1"), "/files/uploads/abc?x=1");
});

test("test files: exact size, reproducible, different seeds differ, fixed lastModified", async () => {
  const a = await makeTestFile({ bytes: 1_000_003, seed: 7, name: "a.bin", yieldToUi: async () => {} });
  const b = await makeTestFile({ bytes: 1_000_003, seed: 7, name: "b.bin", yieldToUi: async () => {} });
  const c = await makeTestFile({ bytes: 1_000_003, seed: 8, name: "c.bin", yieldToUi: async () => {} });
  assert.equal(a.size, 1_000_003);
  assert.equal(a.lastModified, TEST_FILE_TIME);
  const ba = Buffer.from(await a.arrayBuffer());
  assert.ok(ba.equals(Buffer.from(await b.arrayBuffer())));
  assert.ok(!ba.equals(Buffer.from(await c.arrayBuffer())));
});

test("test files above one 16 MB part are built in parts", async () => {
  const f = await makeTestFile({ bytes: 17 * 1024 * 1024 + 5, seed: 1, name: "big.bin", yieldToUi: async () => {} });
  assert.equal(f.size, 17 * 1024 * 1024 + 5);
});

test("compareWithFile: identical, changed byte, short, long", async () => {
  const file = await makeTestFile({ bytes: 5000, seed: 3, name: "f.bin", yieldToUi: async () => {} });
  const bytes = new Uint8Array(await file.arrayBuffer());
  let r = await compareWithFile(stream(bytes, 777), file);
  assert.deepEqual([r.same, r.serverBytes, r.firstDifference], [true, 5000, null]);

  const changed = bytes.slice(); changed[3210] ^= 1;
  r = await compareWithFile(stream(changed, 1000), file);
  assert.deepEqual([r.same, r.firstDifference], [false, 3210]);

  r = await compareWithFile(stream(bytes.slice(0, 4000), 1000), file);
  assert.deepEqual([r.same, r.firstDifference], [false, 4000]);

  const longer = new Uint8Array(5100); longer.set(bytes);
  r = await compareWithFile(stream(longer, 1000), file);
  assert.deepEqual([r.same, r.firstDifference], [false, 5000]);
});
