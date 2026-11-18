#!/usr/bin/env python3
"""Local server for the tus upload page. Python 3.8+, standard library only.

It serves the page (index.html and assets/) and, on the same origin, either

  --target URL   forwards every other request to a real tus service
                 (so the browser never makes a cross-origin call and CORS
                 does not matter), or
  --mock         answers tus requests itself, so you can try the page and the
                 tools before the real environment is ready.

Examples:
  python3 serve.py --mock
  python3 serve.py --target https://dev-host.example.com --header "Authorization: Bearer <token>"
"""
import argparse
import base64
import hashlib
import http.client
import json
import os
import re
import socket
import ssl
import sys
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
       "te", "trailers", "transfer-encoding", "upgrade"}
# not forwarded: the service may reject a request that carries a foreign Origin
DROP_REQ = HOP | {"host", "origin", "referer", "content-length"}
UPLOAD_PATH = re.compile(r"^(?P<base>.*/uploads)(?:/(?P<id>[^/?]+))?/?(?:\?.*)?$")
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
FILE_PATH = re.compile(r"^(?P<parent>.*?)/(?P<id>%s)(?P<content>/content)?/?(?:\?.*)?$" % UUID)
STATIC_PATH = re.compile(r"^/assets/(?P<name>[A-Za-z0-9._-]+)$")
STATIC_TYPES = {".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
                ".html": "text/html; charset=utf-8", ".json": "application/json"}
EXTENSIONS = "creation,creation-defer-length,termination,expiration,checksum"
CHECKSUMS = {"sha1": hashlib.sha1, "sha256": hashlib.sha256, "md5": hashlib.md5}
CHUNK = 64 * 1024

FAULT_TYPES = ("none", "lose_response", "cut_request", "error")
DEFAULT_FAULTS = {"latency_ms": 0, "throttle_kbps": 0,
                  "rule": {"type": "none", "after": 0, "times": 1, "status": 503}}
faults = {**json.loads(json.dumps(DEFAULT_FAULTS)), "patches_seen": 0, "fired": 0}
fault_lock = threading.Lock()


class CutConnection(ConnectionError):
    """Raised on purpose to cut a request body in half (fault injection)."""


args = None
ssl_ctx = None
uploads = {}              # mock state: id -> upload record (see mock_create)
lock = threading.Lock()
tmpdir = None


def parse_metadata(header):
    """'filename aGk=,filetype dGV4dA==' -> {'filename': 'hi', 'filetype': 'text'}"""
    out = {}
    for pair in (header or "").split(","):
        key, _, val = pair.strip().partition(" ")
        if not key:
            continue
        try:
            out[key] = base64.b64decode(val).decode("utf-8", "replace") if val else ""
        except ValueError:
            out[key] = ""
    return out


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):
        print("%s %s" % (self.command, self.path), "->", fmt % a if a else fmt)

    # ---- helpers ---------------------------------------------------------
    unread = 0     # request body bytes not read yet
    cut = False    # fault: cut this request's body in half
    lose = False   # fault: do the work but never answer

    def reply(self, status, headers=None, body=b""):
        if self.lose:                        # fault: the work is done, the answer is lost
            self.close_connection = True
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            return
        self.send_response(status)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        if self.unread > 0:                  # answered without reading the body: do not reuse the connection
            self.send_header("Connection", "close")
            self.close_connection = True
        if status != 204 and self.command != "HEAD":
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def reply_json(self, status, obj):
        self.reply(status, {"Content-Type": "application/json", "Cache-Control": "no-store"},
                   json.dumps(obj).encode())

    def tus_ok(self):
        if self.headers.get("Tus-Resumable") != "1.0.0":
            self.reply(412, {"Tus-Version": "1.0.0", "Tus-Resumable": "1.0.0"})
            return False
        return True

    def body_chunks(self, length):
        """The request body, one piece at a time (slowed down or cut short when a fault says so)."""
        left = length
        got = 0
        cut_at = length // 2 if self.cut else None
        kbps = faults["throttle_kbps"]
        while left > 0:
            data = self.rfile.read(min(CHUNK, left))
            if not data:
                raise ConnectionError("client disconnected mid-request")
            left -= len(data)
            got += len(data)
            self.unread -= len(data)
            if kbps:
                time.sleep(len(data) / (kbps * 1024.0))
            yield data
            if cut_at is not None and got >= cut_at and left > 0:
                raise CutConnection("fault injected: request cut in half")

    def serve_static(self, path):
        m = STATIC_PATH.match(path)
        name = "index.html" if path in ("/", "/index.html") else (m.group("name") if m else None)
        full = os.path.join(HERE, "assets", name) if m else os.path.join(HERE, "index.html")
        if name is None or not os.path.isfile(full):
            return self.reply(404, body=b"not found")
        with open(full, "rb") as f:
            data = f.read()
        ctype = STATIC_TYPES.get(os.path.splitext(name)[1], "application/octet-stream")
        self.reply(200, {"Content-Type": ctype, "Cache-Control": "no-store"}, data)

    # ---- routing ---------------------------------------------------------
    def route(self):
        self.unread = int(self.headers.get("Content-Length") or 0)
        path = self.path.split("?")[0]
        if self.command == "GET" and (path in ("/", "/index.html") or STATIC_PATH.match(path)):
            return self.serve_static(path)
        if self.command == "GET" and path == "/__tus/info":
            return self.reply_json(200, {"mode": "mock" if args.mock else "proxy", "target": args.target,
                                         "faults": True})
        if path == "/__tus/faults":
            return self.faults_endpoint()
        if self.apply_faults():
            return
        if args.mock:
            m = UPLOAD_PATH.match(self.path)
            if m:
                return self.mock(m.group("base"), m.group("id"))
            f = FILE_PATH.match(self.path)
            if f and self.command in ("GET", "HEAD"):
                return self.mock_file(f.group("id"), bool(f.group("content")))
            return self.reply(404, body=b"mock server only implements tus uploads")
        return self.proxy()

    do_GET = do_POST = do_HEAD = do_PATCH = do_DELETE = do_OPTIONS = route

    # ---- fault injection -------------------------------------------------
    def faults_endpoint(self):
        """GET shows the rules, POST sets them, DELETE clears them."""
        if self.command == "GET":
            return self.reply_json(200, fault_state())
        if self.command == "DELETE":
            set_faults({})
            return self.reply_json(200, fault_state())
        if self.command == "POST":
            raw = self.rfile.read(self.unread) if self.unread else b"{}"
            self.unread = 0
            try:
                set_faults(json.loads(raw or b"{}"))
            except (ValueError, TypeError) as e:
                return self.reply_json(400, {"error": str(e)})
            return self.reply_json(200, fault_state())
        return self.reply(405)

    def apply_faults(self):
        """Apply the current rules to this request. Returns True if the request was already answered."""
        with fault_lock:
            latency = faults["latency_ms"]
            rule = None
            if self.command == "PATCH":
                seen = faults["patches_seen"]
                faults["patches_seen"] += 1
                r = faults["rule"]
                if r["type"] != "none" and seen >= r["after"] and faults["fired"] < r["times"]:
                    faults["fired"] += 1
                    rule = dict(r)
        if latency:
            time.sleep(latency / 1000.0)
        if rule is None:
            return False
        print("  fault: %s (%d of %d)" % (rule["type"], faults["fired"], rule["times"]))
        if rule["type"] == "error":
            self.reply(rule["status"], {"Content-Type": "text/plain"}, b"injected fault")
            return True
        self.cut = rule["type"] == "cut_request"
        self.lose = rule["type"] == "lose_response"
        return False

    # ---- mock tus server -------------------------------------------------
    def mock_headers(self, extra=None):
        h = {"Tus-Resumable": "1.0.0"}
        h.update(extra or {})
        return h

    def mock_lookup(self, upload_id):
        """The upload record, or None. Unfinished uploads that outlived their expiry are removed."""
        with lock:
            up = uploads.get(upload_id or "")
            if up and not up["done"] and time.time() > up["expires"]:
                uploads.pop(upload_id, None)
                try:
                    os.remove(up["path"])
                except OSError:
                    pass
                return None
            return up

    def mock(self, base, upload_id):
        cmd = self.command
        parent = base[: -len("/uploads")]
        if cmd == "OPTIONS" and upload_id is None:
            return self.reply(204, self.mock_headers({
                "Tus-Version": "1.0.0", "Tus-Extension": EXTENSIONS,
                "Tus-Max-Size": str(args.max_size), "Tus-Checksum-Algorithm": ",".join(CHECKSUMS)}))
        if not self.tus_ok():
            return
        if cmd == "POST" and upload_id is None:
            return self.mock_create(base)
        up = self.mock_lookup(upload_id)
        if up is None:
            return self.reply(404, self.mock_headers())
        if cmd == "HEAD":
            h = {"Cache-Control": "no-store", "Upload-Offset": str(up["offset"])}
            if up["length"] is None:
                h["Upload-Defer-Length"] = "1"
            else:
                h["Upload-Length"] = str(up["length"])
            if up["meta"]:
                h["Upload-Metadata"] = up["meta"]
            if not up["done"]:
                h["Upload-Expires"] = formatdate(up["expires"], usegmt=True)
            return self.reply(200, self.mock_headers(h))
        if cmd == "DELETE":
            with lock:
                uploads.pop(upload_id, None)
            try:
                os.remove(up["path"])
            except OSError:
                pass
            return self.reply(204, self.mock_headers())
        if cmd == "PATCH":
            return self.mock_patch(parent, upload_id, up)
        return self.reply(405)

    def mock_create(self, base):
        defer = self.headers.get("Upload-Defer-Length") == "1"
        length = None
        if not defer:
            try:
                length = int(self.headers["Upload-Length"])
                if length < 0:
                    raise ValueError
            except (KeyError, ValueError):
                return self.reply(400, body=b"Upload-Length (or Upload-Defer-Length: 1) is required")
            if length > args.max_size:
                return self.reply(413, self.mock_headers(), b"Upload-Length exceeds the maximum size")
        uid = str(uuid.uuid4())
        path = os.path.join(tmpdir, uid)
        open(path, "wb").close()
        expires = time.time() + args.expire_seconds
        with lock:
            uploads[uid] = {"length": length, "offset": 0, "path": path, "done": False, "expires": expires,
                            "meta": self.headers.get("Upload-Metadata", ""),
                            "created": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        self.reply(201, self.mock_headers({"Location": "%s/%s" % (base, uid),
                                           "Upload-Expires": formatdate(expires, usegmt=True)}))

    def mock_patch(self, parent, uid, up):
        if self.headers.get("Content-Type") != "application/offset+octet-stream":
            return self.reply(415, self.mock_headers())
        try:
            offset = int(self.headers["Upload-Offset"])
            remaining = int(self.headers.get("Content-Length") or 0)
        except (KeyError, ValueError):
            return self.reply(400, body=b"Upload-Offset is required")
        if up["done"]:
            return self.reply(403, self.mock_headers(), b"The upload is already complete")
        if offset != up["offset"]:
            return self.reply(409, self.mock_headers(), b"Upload-Offset does not match")
        if self.headers.get("Upload-Length") is not None:      # fixes the length of a deferred upload
            try:
                new_length = int(self.headers["Upload-Length"])
            except ValueError:
                return self.reply(400, body=b"Upload-Length must be a number")
            if up["length"] is not None and up["length"] != new_length:
                return self.reply(400, body=b"Upload-Length cannot be changed")
            if new_length < offset + remaining:
                return self.reply(400, body=b"Upload-Length is smaller than the data")
            up["length"] = new_length
        if up["length"] is not None and offset + remaining > up["length"]:
            return self.reply(400, body=b"Chunk exceeds Upload-Length")
        checksum = self.headers.get("Upload-Checksum")
        try:
            if checksum:
                algo, _, given = checksum.partition(" ")
                if algo not in CHECKSUMS:
                    return self.reply(400, body=b"Unsupported checksum algorithm")
                data = b"".join(self.body_chunks(remaining))
                actual = base64.b64encode(CHECKSUMS[algo](data).digest()).decode()
                if actual != given.strip():
                    return self.reply(460, self.mock_headers(), b"Checksum mismatch")
                with open(up["path"], "ab") as f:
                    f.write(data)
                with lock:
                    up["offset"] += len(data)
            else:
                # Bytes are committed as they arrive, so an interrupted request keeps its progress.
                with open(up["path"], "ab") as f:
                    for data in self.body_chunks(remaining):
                        f.write(data)
                        f.flush()
                        with lock:
                            up["offset"] += len(data)
        except ConnectionError:
            self.close_connection = True
            return
        headers = {"Upload-Offset": str(up["offset"])}
        if up["length"] is not None and up["offset"] == up["length"]:
            up["done"] = True
            headers["Content-Location"] = "%s/%s" % (parent, uid)
        self.reply(204, self.mock_headers(headers))

    def mock_file(self, uid, content):
        """The finished file: its record (JSON) or, under /content, its bytes."""
        up = self.mock_lookup(uid)
        if up is None or not up["done"]:
            return self.reply(404, body=b"no such file")
        meta = parse_metadata(up["meta"])
        if content:
            ctype = meta.get("filetype") or meta.get("type") or "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(up["length"]))
            self.end_headers()
            if self.command == "GET":
                with open(up["path"], "rb") as f:
                    while True:
                        data = f.read(CHUNK)
                        if not data:
                            break
                        self.wfile.write(data)
            return
        self.reply_json(200, {"id": uid, "name": meta.get("filename") or meta.get("name") or uid,
                              "size": up["length"], "contentType": meta.get("filetype") or meta.get("type") or "application/octet-stream",
                              "createdBy": "mock", "creationTimeStamp": up["created"], "fileStatus": "available"})

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
        headers["User-Agent"] = "tus-upload-proxy"
        for h in args.header:
            name, _, value = h.partition(":")
            headers[name.strip()] = value.strip()
        length = int(self.headers.get("Content-Length") or 0)
        body = None
        if length:
            headers["Content-Length"] = str(length)
            body = self.body_chunks(length)
        elif self.command in ("POST", "PUT", "PATCH"):
            headers["Content-Length"] = "0"
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


def fault_state():
    with fault_lock:
        return {"latency_ms": faults["latency_ms"], "throttle_kbps": faults["throttle_kbps"],
                "rule": dict(faults["rule"]), "patches_seen": faults["patches_seen"], "fired": faults["fired"]}


def set_faults(cfg):
    """Replace the fault rules (an empty dict clears them) and restart the counters."""
    def num(v, name, low, high):
        v = int(v)
        if not low <= v <= high:
            raise ValueError("%s must be between %d and %d" % (name, low, high))
        return v
    rule_in = cfg.get("rule") or {}
    rtype = rule_in.get("type", "none")
    if rtype not in FAULT_TYPES:
        raise ValueError("rule.type must be one of " + ", ".join(FAULT_TYPES))
    new = {"latency_ms": num(cfg.get("latency_ms", 0), "latency_ms", 0, 60000),
           "throttle_kbps": num(cfg.get("throttle_kbps", 0), "throttle_kbps", 0, 10 ** 7),
           "rule": {"type": rtype, "after": num(rule_in.get("after", 0), "after", 0, 10 ** 6),
                    "times": num(rule_in.get("times", 1), "times", 1, 10 ** 6),
                    "status": num(rule_in.get("status", 503), "status", 400, 599)}}
    with fault_lock:
        faults.update(new)
        faults["patches_seen"] = 0
        faults["fired"] = 0


def make_server(port=8000, mock=True, target=None, headers=(), cafile=None, max_size=50 * 1024 ** 3,
                expire_seconds=3600):
    """Build the server (used by main() and by the tests)."""
    global args, ssl_ctx, tmpdir
    set_faults({})
    args = argparse.Namespace(mock=mock, target=target, header=list(headers), cafile=cafile, port=port,
                              max_size=max_size, expire_seconds=expire_seconds)
    if target:
        ssl_ctx = ssl.create_default_context(cafile=cafile)
    else:
        tmpdir = tempfile.mkdtemp(prefix="tus-mock-")
        uploads.clear()
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


def main():
    sys.stdout.reconfigure(line_buffering=True)   # show log lines immediately, even when piped
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--target", help="origin of the real service, e.g. https://dev-host:8443")
    mode.add_argument("--mock", action="store_true", help="run a built-in tus server instead")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--header", action="append", default=[],
                    help='extra header to send upstream, e.g. "Authorization: Bearer ..." (repeatable)')
    ap.add_argument("--cafile", help="CA bundle to trust for an https --target (internal CA)")
    ap.add_argument("--max-size", type=int, default=50 * 1024 ** 3, help="mock Tus-Max-Size in bytes")
    ap.add_argument("--expire-seconds", type=int, default=3600,
                    help="mock: unfinished uploads expire after this many seconds")
    a = ap.parse_args()
    if a.target:
        t = urlsplit(a.target)
        if t.scheme not in ("http", "https") or not t.netloc:
            ap.error("--target must look like https://host[:port]")
    srv = make_server(a.port, a.mock, a.target, a.header, a.cafile, a.max_size, a.expire_seconds)
    print("Upload page: http://localhost:%d/  (%s)" % (a.port, "mock tus server" if a.mock else "proxy to " + a.target))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
