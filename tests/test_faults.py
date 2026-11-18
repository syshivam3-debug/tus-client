"""Tests for fault injection in serve.py. Run: python3 -m unittest discover -s tests"""
import http.client
import json
import os
import sys
import threading
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import serve  # noqa: E402

TUS = {"Tus-Resumable": "1.0.0"}
PATCH = {**TUS, "Content-Type": "application/offset+octet-stream"}


class FaultTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = serve.make_server(port=0, mock=True)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def setUp(self):
        self.call("DELETE", "/__tus/faults")

    def call(self, method, path, headers=None, body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            c.request(method, path, body=body, headers=headers or {})
            r = c.getresponse()
            return r.status, {k.lower(): v for k, v in r.getheaders()}, r.read()
        finally:
            c.close()

    def set(self, **cfg):
        s, _, body = self.call("POST", "/__tus/faults", {"Content-Type": "application/json"}, json.dumps(cfg))
        self.assertEqual(s, 200, body)
        return json.loads(body)

    def create(self, length):
        s, h, _ = self.call("POST", "/files/uploads", {**TUS, "Upload-Length": str(length)})
        self.assertEqual(s, 201)
        return h["location"]

    def offset(self, loc):
        return int(self.call("HEAD", loc, TUS)[1]["upload-offset"])

    def test_info_says_faults_are_available(self):
        self.assertTrue(json.loads(self.call("GET", "/__tus/info")[2])["faults"])

    def test_settings_are_validated_and_reset(self):
        s, _, _ = self.call("POST", "/__tus/faults", {}, json.dumps({"rule": {"type": "explode"}}))
        self.assertEqual(s, 400)
        state = self.set(latency_ms=5, rule={"type": "error", "after": 1, "times": 2, "status": 500})
        self.assertEqual((state["latency_ms"], state["rule"]["status"], state["fired"]), (5, 500, 0))
        cleared = json.loads(self.call("DELETE", "/__tus/faults")[2])
        self.assertEqual((cleared["latency_ms"], cleared["rule"]["type"]), (0, "none"))

    def test_error_fires_after_n_chunks_for_m_times(self):
        loc = self.create(40)
        self.set(rule={"type": "error", "after": 1, "times": 2, "status": 503})
        self.assertEqual(self.call("PATCH", loc, {**PATCH, "Upload-Offset": "0"}, b"a" * 10)[0], 204)   # let through
        self.assertEqual(self.call("PATCH", loc, {**PATCH, "Upload-Offset": "10"}, b"b" * 10)[0], 503)
        self.assertEqual(self.call("PATCH", loc, {**PATCH, "Upload-Offset": "10"}, b"b" * 10)[0], 503)
        self.assertEqual(self.call("PATCH", loc, {**PATCH, "Upload-Offset": "10"}, b"b" * 10)[0], 204)  # recovered
        self.assertEqual(self.offset(loc), 20)
        self.assertEqual(json.loads(self.call("GET", "/__tus/faults")[2])["fired"], 2)

    def test_lost_response_keeps_the_data(self):
        loc = self.create(20)
        self.set(rule={"type": "lose_response", "after": 0, "times": 1})
        with self.assertRaises((ConnectionError, http.client.HTTPException)):
            self.call("PATCH", loc, {**PATCH, "Upload-Offset": "0"}, b"x" * 10)
        self.assertEqual(self.offset(loc), 10)            # the server got it; only the answer was lost

    def test_cut_request_keeps_half(self):
        loc = self.create(200000)
        self.set(rule={"type": "cut_request", "after": 0, "times": 1})
        with self.assertRaises((ConnectionError, http.client.HTTPException)):
            self.call("PATCH", loc, {**PATCH, "Upload-Offset": "0"}, b"y" * 200000)
        got = self.offset(loc)
        self.assertTrue(0 < got < 200000, got)           # partial progress is kept, the client resumes from it
        self.assertEqual(self.call("PATCH", loc, {**PATCH, "Upload-Offset": str(got)}, b"y" * (200000 - got))[0], 204)

    def test_latency_and_throttle_slow_requests_down(self):
        import time
        self.set(latency_ms=300)
        t = time.time()
        self.call("OPTIONS", "/files/uploads")
        self.assertGreater(time.time() - t, 0.25)
        loc = self.create(64 * 1024)
        self.set(throttle_kbps=128)                       # 64 KB at 128 KB/s is about half a second
        t = time.time()
        self.assertEqual(self.call("PATCH", loc, {**PATCH, "Upload-Offset": "0"}, b"z" * 64 * 1024)[0], 204)
        self.assertGreater(time.time() - t, 0.4)


if __name__ == "__main__":
    unittest.main()
