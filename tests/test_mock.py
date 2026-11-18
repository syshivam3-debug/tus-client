"""Tests for the mock tus server in serve.py. Run: python3 -m unittest discover -s tests"""
import base64
import hashlib
import http.client
import json
import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import serve  # noqa: E402

TUS = {"Tus-Resumable": "1.0.0"}
PATCH = {**TUS, "Content-Type": "application/offset+octet-stream"}


class MockServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = serve.make_server(port=0, mock=True, expire_seconds=1)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def call(self, method, path, headers=None, body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request(method, path, body=body, headers=headers or {})
        r = c.getresponse()
        data = r.read()
        out = (r.status, {k.lower(): v for k, v in r.getheaders()}, data)
        c.close()
        return out

    def create(self, length, extra=None):
        s, h, _ = self.call("POST", "/files/uploads", {**TUS, "Upload-Length": str(length), **(extra or {})})
        self.assertEqual(s, 201)
        return h["location"]

    def test_pages_are_served(self):
        s, h, body = self.call("GET", "/")
        self.assertEqual(s, 200)
        self.assertIn(b"assets/app.js", body)
        s, h, _ = self.call("GET", "/assets/app.css")
        self.assertEqual((s, h["content-type"].split(";")[0]), (200, "text/css"))
        self.assertEqual(self.call("GET", "/assets/../serve.py")[0], 404)
        self.assertEqual(self.call("GET", "/assets/nope.js")[0], 404)

    def test_options_lists_extensions(self):
        s, h, _ = self.call("OPTIONS", "/files/uploads")
        self.assertEqual(s, 204)
        self.assertEqual(h["tus-version"], "1.0.0")
        for ext in ("creation", "creation-defer-length", "termination", "expiration", "checksum"):
            self.assertIn(ext, h["tus-extension"])

    def test_full_upload_and_download(self):
        meta = "filename %s,filetype %s" % (base64.b64encode(b"hello.txt").decode(), base64.b64encode(b"text/plain").decode())
        loc = self.create(20, {"Upload-Metadata": meta})
        s, h, _ = self.call("HEAD", loc, TUS)
        self.assertEqual((s, h["upload-offset"], h["upload-length"]), (200, "0", "20"))
        self.assertIn("upload-expires", h)
        s, h, _ = self.call("PATCH", loc, {**PATCH, "Upload-Offset": "0"}, b"0123456789")
        self.assertEqual((s, h["upload-offset"]), (204, "10"))
        self.assertNotIn("content-location", h)
        self.assertEqual(self.call("PATCH", loc, {**PATCH, "Upload-Offset": "3"}, b"x")[0], 409)
        s, h, _ = self.call("PATCH", loc, {**PATCH, "Upload-Offset": "10"}, b"abcdefghij")
        self.assertEqual((s, h["upload-offset"]), (204, "20"))
        file_path = h["content-location"]
        self.assertEqual(file_path, "/files/" + loc.rsplit("/", 1)[1])
        s, _, body = self.call("GET", file_path, {"Accept": "application/json"})
        rec = json.loads(body)
        self.assertEqual((s, rec["name"], rec["size"], rec["contentType"]), (200, "hello.txt", 20, "text/plain"))
        s, h, body = self.call("GET", file_path + "/content")
        self.assertEqual((s, body, h["content-type"]), (200, b"0123456789abcdefghij", "text/plain"))
        self.assertEqual(self.call("PATCH", loc, {**PATCH, "Upload-Offset": "20"}, b"z")[0], 403)

    def test_rejections(self):
        self.assertEqual(self.call("POST", "/files/uploads", {"Upload-Length": "5"})[0], 412)
        loc = self.create(5)
        self.assertEqual(self.call("PATCH", loc, {**TUS, "Upload-Offset": "0"}, b"12345")[0], 415)
        self.assertEqual(self.call("HEAD", "/files/uploads/00000000-0000-0000-0000-000000000000", TUS)[0], 404)
        s, _, _ = self.call("POST", "/files/uploads", {**TUS, "Upload-Length": str(10 ** 15)})
        self.assertEqual(s, 413)

    def test_deferred_length_append(self):
        s, h, _ = self.call("POST", "/files/uploads", {**TUS, "Upload-Defer-Length": "1"})
        self.assertEqual(s, 201)
        loc = h["location"]
        s, h, _ = self.call("HEAD", loc, TUS)
        self.assertEqual(h["upload-defer-length"], "1")
        self.assertNotIn("upload-length", h)
        self.assertEqual(self.call("PATCH", loc, {**PATCH, "Upload-Offset": "0"}, b"line1\n")[0], 204)
        self.assertEqual(self.call("PATCH", loc, {**PATCH, "Upload-Offset": "6"}, b"line2\n")[0], 204)
        s, h, _ = self.call("PATCH", loc, {**PATCH, "Upload-Offset": "12", "Upload-Length": "12"}, b"")
        self.assertEqual(s, 204)
        self.assertIn("content-location", h)
        s, _, body = self.call("GET", h["content-location"] + "/content")
        self.assertEqual(body, b"line1\nline2\n")

    def test_checksum(self):
        loc = self.create(4)
        wrong = "sha1 " + base64.b64encode(hashlib.sha1(b"nope").digest()).decode()
        self.assertEqual(self.call("PATCH", loc, {**PATCH, "Upload-Offset": "0", "Upload-Checksum": wrong}, b"data")[0], 460)
        self.assertEqual(self.call("HEAD", loc, TUS)[1]["upload-offset"], "0")
        good = "sha1 " + base64.b64encode(hashlib.sha1(b"data").digest()).decode()
        self.assertEqual(self.call("PATCH", loc, {**PATCH, "Upload-Offset": "0", "Upload-Checksum": good}, b"data")[0], 204)

    def test_termination(self):
        loc = self.create(5)
        self.assertEqual(self.call("DELETE", loc, TUS)[0], 204)
        self.assertEqual(self.call("HEAD", loc, TUS)[0], 404)

    def test_unfinished_uploads_expire(self):
        loc = self.create(5)
        time.sleep(1.2)
        self.assertEqual(self.call("HEAD", loc, TUS)[0], 404)


if __name__ == "__main__":
    unittest.main()
