#!/usr/bin/env python3
"""Local server for the tus demo page. Python 3.8+, standard library only.

It serves index.html and, on the same origin, either

  --target URL   forwards every other request to a real tus service
                 (so the browser never makes a cross-origin call and CORS
                 does not matter), or
  --mock         answers tus requests itself, so you can rehearse the demo
                 before the real environment is ready.

Examples:
  python3 serve.py --mock
  python3 serve.py --target https://dev-host.example.com --header "Authorization: Bearer <token>"
"""
import argparse
import http.client
import os
import re
import ssl
import sys
import tempfile
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
       "te", "trailers", "transfer-encoding", "upgrade"}
# not forwarded: the service may reject a request that carries a foreign Origin
DROP_REQ = HOP | {"host", "origin", "referer", "content-length"}
UPLOAD_PATH = re.compile(r"^(?P<base>.*/uploads)(?:/(?P<id>[^/?]+))?/?(?:\?.*)?$")
CHUNK = 64 * 1024

args = None
ssl_ctx = None
uploads = {}              # mock state: id -> {"length", "offset", "path", "meta"}
lock = threading.Lock()
tmpdir = None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):
        print("%s %s" % (self.command, self.path), "->", fmt % a if a else fmt)

    # ---- helpers ---------------------------------------------------------
    def reply(self, status, headers=None, body=b""):
        self.send_response(status)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        if status != 204 and self.command != "HEAD":
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def tus_ok(self):
        if self.headers.get("Tus-Resumable") != "1.0.0":
            self.reply(412, {"Tus-Version": "1.0.0", "Tus-Resumable": "1.0.0"})
            return False
        return True

    # ---- routing ---------------------------------------------------------
    def route(self):
        if self.command == "GET" and self.path.split("?")[0] in ("/", "/index.html"):
            with open(os.path.join(HERE, "index.html"), "rb") as f:
                return self.reply(200, {"Content-Type": "text/html; charset=utf-8"}, f.read())
        if args.mock:
            m = UPLOAD_PATH.match(self.path)
            if m:
                return self.mock(m.group("base"), m.group("id"))
            return self.reply(404, body=b"mock server only implements tus uploads")
        return self.proxy()

    do_GET = do_POST = do_HEAD = do_PATCH = do_DELETE = do_OPTIONS = route

    # ---- mock tus server -------------------------------------------------
    def mock(self, base, upload_id):
        cmd = self.command
        if cmd == "OPTIONS" and upload_id is None:
            return self.reply(204, {"Tus-Resumable": "1.0.0", "Tus-Version": "1.0.0",
                                    "Tus-Extension": "creation,termination",
                                    "Tus-Max-Size": str(args.max_size)})
        if not self.tus_ok():
            return
        if cmd == "POST" and upload_id is None:
            try:
                length = int(self.headers["Upload-Length"])
            except (KeyError, ValueError):
                return self.reply(400, body=b"Upload-Length is required")
            if length > args.max_size:
                return self.reply(413, body=b"Upload-Length exceeds the maximum size")
            uid = str(uuid.uuid4())
            path = os.path.join(tmpdir, uid)
            open(path, "wb").close()
            with lock:
                uploads[uid] = {"length": length, "offset": 0, "path": path,
                                "meta": self.headers.get("Upload-Metadata", "")}
            return self.reply(201, {"Tus-Resumable": "1.0.0", "Location": "%s/%s" % (base, uid)})
        up = uploads.get(upload_id or "")
        if up is None:
            return self.reply(404, {"Tus-Resumable": "1.0.0"})
        if cmd == "HEAD":
            return self.reply(200, {"Tus-Resumable": "1.0.0", "Cache-Control": "no-store",
                                    "Upload-Offset": str(up["offset"]),
                                    "Upload-Length": str(up["length"])})
        if cmd == "DELETE":
            with lock:
                uploads.pop(upload_id, None)
            try:
                os.remove(up["path"])
            except OSError:
                pass
            return self.reply(204, {"Tus-Resumable": "1.0.0"})
        if cmd == "PATCH":
            if self.headers.get("Content-Type") != "application/offset+octet-stream":
                return self.reply(415)
            try:
                offset = int(self.headers["Upload-Offset"])
                remaining = int(self.headers["Content-Length"])
            except (KeyError, ValueError):
                return self.reply(400, body=b"Upload-Offset and Content-Length are required")
            if offset != up["offset"]:
                return self.reply(409, {"Tus-Resumable": "1.0.0"}, b"Upload-Offset does not match")
            if offset + remaining > up["length"]:
                return self.reply(400, body=b"Chunk exceeds Upload-Length")
            # Bytes are committed as they arrive, so an interrupted request keeps its progress.
            with open(up["path"], "ab") as f:
                while remaining > 0:
                    data = self.rfile.read(min(CHUNK, remaining))
                    if not data:
                        self.close_connection = True
                        return
                    f.write(data)
                    f.flush()
                    remaining -= len(data)
                    with lock:
                        up["offset"] += len(data)
            return self.reply(204, {"Tus-Resumable": "1.0.0", "Upload-Offset": str(up["offset"])})
        return self.reply(405)

    # ---- reverse proxy ---------------------------------------------------
    def proxy(self):
        t = urlsplit(args.target)
        if t.scheme == "https":
            conn = http.client.HTTPSConnection(t.netloc, timeout=300, context=ssl_ctx)
        else:
            conn = http.client.HTTPConnection(t.netloc, timeout=300)
        # Forward like a plain API client (e.g. Postman): drop browser-only headers that some
        # gateways use to decide a request is an interactive browser session.
        headers = {k: v for k, v in self.headers.items()
                   if k.lower() not in DROP_REQ and not k.lower().startswith("sec-")
                   and k.lower() not in ("accept-language", "user-agent", "cookie", "accept-encoding")}
        headers["User-Agent"] = "tus-demo-proxy"
        for h in args.header:
            name, _, value = h.partition(":")
            headers[name.strip()] = value.strip()
        length = int(self.headers.get("Content-Length") or 0)
        body = None
        if length:
            headers["Content-Length"] = str(length)

            def stream():
                left = length
                while left > 0:
                    data = self.rfile.read(min(CHUNK, left))
                    if not data:
                        raise ConnectionError("client disconnected mid-request")
                    left -= len(data)
                    yield data
            body = stream()
        try:
            conn.request(self.command, self.path, body=body, headers=headers)
            resp = conn.getresponse()
            data = resp.read()
        except Exception as e:  # upstream down, TLS problem, or client dropped
            conn.close()
            self.close_connection = True
            if isinstance(e, ConnectionError):
                return
            return self.reply(502, {"Content-Type": "text/plain"},
                              ("Could not reach %s: %s" % (args.target, e)).encode())
        loc = resp.getheader("Location") or ""
        ctype = (resp.getheader("Content-Type") or "").split(";")[0].strip()
        sent_auth = any(k.lower() == "authorization" for k in headers)
        print("  upstream: %s %s  type=%s%s  authorization_sent=%s"
              % (resp.status, resp.reason, ctype or "-", "  location=" + loc if loc else "", sent_auth))
        # A browser follows redirects silently, which hides the real problem (usually "not logged in").
        if 300 <= resp.status < 400 and resp.status != 304:
            conn.close()
            return self.reply(401, {"Content-Type": "text/plain"},
                              ("The service redirected to %r instead of answering. The request was probably not "
                               "authenticated (authorization_sent=%s). Check the token." % (loc, sent_auth)).encode())
        if ctype == "text/html" and self.command != "GET":
            conn.close()
            return self.reply(502, {"Content-Type": "text/plain"},
                              ("The service answered %s with a web page, not a tus response. Check the path and "
                               "the token (authorization_sent=%s)." % (resp.status, sent_auth)).encode())
        out = {}
        for k, v in resp.getheaders():
            kl = k.lower()
            if kl in HOP or kl == "content-length":
                continue
            if kl in ("location", "content-location"):
                p = urlsplit(v)
                if p.netloc == t.netloc:   # keep follow-up requests on this origin
                    v = p.path + ("?" + p.query if p.query else "")
            out[k] = v
        conn.close()
        self.reply(resp.status, out, data)


def main():
    global args, ssl_ctx, tmpdir
    sys.stdout.reconfigure(line_buffering=True)   # show log lines immediately, even when piped
    ap =argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--target", help="origin of the real service, e.g. https://dev-host:8443")
    mode.add_argument("--mock", action="store_true", help="run a built-in tus server instead")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--header", action="append", default=[],
                    help='extra header to send upstream, e.g. "Authorization: Bearer ..." (repeatable)')
    ap.add_argument("--cafile", help="CA bundle to trust for an https --target (internal CA)")
    ap.add_argument("--max-size", type=int, default=50 * 1024 ** 3, help="mock Tus-Max-Size in bytes")
    args = ap.parse_args()
    if args.target:
        t = urlsplit(args.target)
        if t.scheme not in ("http", "https") or not t.netloc:
            ap.error("--target must look like https://host[:port]")
        ssl_ctx = ssl.create_default_context(cafile=args.cafile)
    else:
        tmpdir = tempfile.mkdtemp(prefix="tus-mock-")
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("Demo page: http://localhost:%d/  (%s)" % (args.port, "mock tus server" if args.mock else "proxy to " + args.target))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
