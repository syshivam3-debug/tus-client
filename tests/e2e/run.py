#!/usr/bin/env python3
"""Browser test for the page: starts serve.py --mock, opens the page in Chrome (headless) with a stand-in
for Uppy, and clicks through every tool. Needs playwright for python and a Chrome/Chromium.
Run from the repo root:  python3 tests/e2e/run.py
"""
import os
import subprocess
import sys
import time
import glob
import base64
import json

from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
STUB = open(os.path.join(os.path.dirname(__file__), "uppy-stub.mjs")).read()
PORT = int(os.environ.get("PORT", "8765"))
URL = "http://localhost:%d/" % PORT
failures = []


def check(cond, what):
    print(("  ok    " if cond else "  FAIL  ") + what)
    if not cond:
        failures.append(what)


def chrome_path():
    for p in glob.glob("/opt/pw-browsers/chromium-*/chrome-linux64/chrome") + ["/usr/bin/google-chrome"]:
        if os.path.exists(p):
            return p


def detail(page, key):
    return page.evaluate("""(key) => { const k = [...document.querySelectorAll('#details .k')].find(e => e.textContent === key);
        return k ? k.nextElementSibling.textContent : null; }""", key)


def wait_detail(page, key, contains, timeout=20000):
    page.wait_for_function("""([key, contains]) => { const k = [...document.querySelectorAll('#details .k')].find(e => e.textContent === key);
        return k && k.nextElementSibling.textContent.includes(contains); }""", arg=[key, contains], timeout=timeout)


def add_test_file(page, mb, seed=1, slow=False, chunk_mb="0.25"):
    page.fill("#gen-size", str(mb))
    page.fill("#gen-seed", str(seed))
    page.fill("#gen-name", "")
    page.set_checked("#demo", slow)
    page.fill("#chunk", chunk_mb)
    page.click("#apply")
    page.click("#gen-go")
    wait_detail(page, "File name", "test-")


def main():
    env = dict(os.environ, PYTHONUNBUFFERED="1")
    srv = subprocess.Popen([sys.executable, os.path.join(ROOT, "serve.py"), "--mock", "--port", str(PORT)],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    time.sleep(1)
    errors = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=chrome_path(), args=["--no-sandbox"])
            ctx = browser.new_context()
            page = ctx.new_page()
            page.on("pageerror", lambda e: errors.append("pageerror: %s" % e))
            # a 404 is expected where a test asks about an upload that was terminated on purpose
            page.on("console", lambda m: m.type == "error" and "status of 404" not in m.text and errors.append("console: %s" % m.text))

            def cdn(route):
                if route.request.url.endswith(".mjs"):
                    route.fulfill(body=STUB, content_type="text/javascript")
                else:
                    route.fulfill(body="", content_type="text/css")
            page.route("https://releases.transloadit.com/**", cdn)
            page.goto(URL)
            page.wait_for_selector("#stub-upload")
            page.click("#gen-card > summary")                       # a card opens when its title is clicked
            check(page.evaluate("document.getElementById('gen-card').open"), "clicking a tool title opens the card")
            page.evaluate("document.querySelectorAll('details.card').forEach(d => d.open = true)")

            print("server check")
            page.click("#check")
            page.wait_for_function("document.querySelectorAll('#caps .k').length > 3")
            caps = page.inner_text("#caps")
            check(page.evaluate("document.getElementById('caps-card').open"), "server check card opens")
            check(all(e in caps for e in ("creation-defer-length", "termination", "expiration", "checksum")), "all five extensions are listed")
            check("not advertised yet" not in caps, "mock advertises every extension")

            print("token timer")
            exp = int(time.time()) + 600
            payload = base64.urlsafe_b64encode(json.dumps({"exp": exp}).encode()).decode().rstrip("=")
            page.fill("#auth", "Bearer a.%s.b" % payload)
            check("expires in" in page.inner_text("#token-hint"), "token hint shows the expiry")
            page.fill("#auth", "")

            print("metadata")
            page.click("#meta-add")
            page.fill("#meta-rows input >> nth=0", "folder")
            page.fill("#meta-rows input >> nth=1", "reports")
            check("folder" in page.inner_text("#meta-note"), "metadata note lists the new field")

            print("test file, upload, verify")
            add_test_file(page, 1)
            check(detail(page, "File size").startswith("1.0 MB"), "1 MB test file loaded")
            page.click("#stub-upload")
            wait_detail(page, "Status", "Complete")
            check(detail(page, "File ID") is not None, "file id shown after completion")
            check(detail(page, "Metadata sent") is not None, "metadata listed in details")
            page.wait_for_function("document.getElementById('verify-result').textContent.startsWith('Identical')", timeout=15000)
            check(detail(page, "Integrity check").startswith("Passed"), "auto verify passes")
            check(detail(page, "Name on server").startswith("test-1MB"), "file record is read")
            page.fill("#gen-size", "1")
            # the same seed gives the same file; a different seed must make verify fail only if bytes differ
            print("request log")
            n = page.locator("#log li.entry").count()
            check(n >= 6, "log has request lines (%d)" % n)
            page.locator("#log li.entry >> nth=0").click()
            check(page.locator(".logdetail").count() == 1, "clicking a line shows its headers")
            check("Tus-Resumable" in page.inner_text(".logdetail"), "headers include Tus-Resumable")
            curl_btn = page.locator(".logdetail button")
            check(curl_btn.count() == 1, "copy-as-curl button present")
            page.locator("#log li.entry >> nth=0").click(position={"x": 5, "y": 5})
            with page.expect_download() as dl:
                page.click("#log-export")
            data = json.load(open(dl.value.path()))
            check(len(data["requests"]) == n, "exported log holds every request")
            check("Bearer" not in json.dumps(data), "export never contains a token")

            print("pause, resume")
            add_test_file(page, 2, seed=2, slow=True)
            page.click("#stub-upload")
            wait_detail(page, "Chunks sent", "2")
            page.click("#pause")
            time.sleep(1.5)
            sent = detail(page, "Chunks sent")
            page.click("#resume")
            wait_detail(page, "Times resumed", "1")
            wait_detail(page, "Status", "Complete", timeout=30000)
            check(int(sent) < 8, "paused before the end (%s chunks)" % sent)

            print("interrupted uploads and reload")
            add_test_file(page, 2, seed=3, slow=True)
            page.click("#stub-upload")
            wait_detail(page, "Chunks sent", "2")
            page.click("#pause")
            page.wait_for_function("document.querySelectorAll('#saved-list .rowline').length === 1")
            check("test-2MB-seed3.bin" in page.inner_text("#saved-list"), "saved upload is listed")
            page.click("#saved-list button >> text=Ask server")
            page.wait_for_function("document.querySelector('#saved-list small').textContent.includes('server has')")
            page.reload()
            page.wait_for_selector("#stub-upload")
            page.evaluate("document.querySelectorAll('details.card').forEach(d => d.open = true)")
            check(page.locator("#saved-list .rowline").count() == 1, "saved upload survives a reload")
            page.click("#saved-list button >> text=Forget")
            check(page.locator("#saved-list .rowline").count() == 0, "forgetting removes it")

            print("terminate")
            add_test_file(page, 2, seed=4, slow=True)
            page.click("#stub-upload")
            wait_detail(page, "Chunks sent", "2")
            page.click("#pause")
            up = detail(page, "Upload URL")
            page.click("#terminate")
            page.wait_for_function("document.getElementById('banner').textContent.startsWith('Terminated')", timeout=10000)
            check(detail(page, "Status").startswith("Terminated"), "terminate confirmed by the server")
            check(page.locator("#saved-list .rowline").count() == 0, "terminated upload is forgotten")
            code = page.evaluate("(u) => fetch(u, {method: 'HEAD', headers: {'Tus-Resumable': '1.0.0'}}).then(r => r.status)", up)
            check(code == 404, "the server answers 404 for the terminated upload")

            print("append mode")
            page.click("#append-start")
            page.wait_for_function("document.getElementById('append-out').textContent.startsWith('Created')")
            page.fill("#append-line", "hello one")
            page.click("#append-add")
            page.wait_for_function("document.getElementById('append-out').textContent.includes('Appended')")
            page.fill("#append-line", "hello two")
            page.click("#append-add")
            page.wait_for_function("document.getElementById('append-out').textContent.includes('server now has 20')")
            page.click("#append-finish")
            page.wait_for_function("document.getElementById('append-out').textContent.startsWith('Finished')")
            page.click("#append-read")
            page.wait_for_function("document.getElementById('append-out').textContent.startsWith('Read back')")
            out = page.inner_text("#append-out")
            check("hello one" in out and "hello two" in out, "appended lines read back")

            shot = os.environ.get("SCREENSHOT")
            if shot:
                page.set_viewport_size({"width": 1000, "height": 900})
                page.screenshot(path=shot, full_page=True)
            browser.close()
    finally:
        srv.terminate()
        srv.wait(timeout=5)
    check(not errors, "no console or page errors" + ("" if not errors else ": " + "; ".join(errors[:3])))
    print("\n%s" % ("ALL PASSED" if not failures else "%d FAILED: %s" % (len(failures), "; ".join(failures))))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
