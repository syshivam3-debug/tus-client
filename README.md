# tus-client

A browser tool for trying and testing resumable uploads with the [tus](https://tus.io) protocol, built with [Uppy](https://uppy.io). It started as a demo for a tus-enabled file service and is now meant for everyday manual testing while the service is being developed: pick or generate a file, pause or cut the connection, check what the server says it supports, and see every request.

## Run it

Needs Python 3.8+ and a browser with internet access (Uppy loads from Transloadit's CDN). Nothing to install, no build step.

```bash
# Try the page with a built-in tus server (no real service needed)
python3 serve.py --mock

# Use the real service. The page and the API share one origin, so CORS is not involved.
python3 serve.py --target https://your-dev-host:8443 --header "Authorization: Bearer <token>"
```

Open http://localhost:8000/. In **Connection**, set the upload endpoint to the same path you use in Postman (for example `/files/uploads`), then press **Apply**.

Options: `--port`, `--cafile` (CA bundle for an internal https certificate), `--max-size` and `--expire-seconds` (mock only).

## What the page does

| Card | Use it to |
| --- | --- |
| **Connection** | Set the endpoint, token and chunk size. The token field shows how long a JWT still has to live. **Check server** sends OPTIONS. |
| **Server check** | See `Tus-Version`, `Tus-Max-Size` and which extensions are advertised, compared with the ones the architecture decision asks for (creation, creation-defer-length, termination, expiration, checksum). |
| **Test file** | Create a file of any size in the browser (1 MB to 4 GB). The same size and seed always give the same bytes, so you can add "the same file" again after a reload. |
| **Upload metadata** | Add your own `Upload-Metadata` fields (for example a target folder). |
| **Upload** | Pause, resume, or **Terminate** (DELETE, then a HEAD that must answer 404 or 410). **Slow mode** (on by default) splits any file into about 8 chunks, 1 second apart, so there is time to pause. |
| **Upload details** | Fills in as information arrives: file, upload ID and URL, expiry, progress, then the finished file's location and record. **Verify content** downloads the finished file and compares it with the original byte for byte (it reports the first byte that differs). It can run automatically after each upload. |
| **Request log** | Every request. Click a line to see its headers and **Copy as curl** (the token is never written; curl reads `$TOKEN`). **Export log** saves JSON for a bug report. |
| **Interrupted uploads** | Lists unfinished uploads the browser remembers. After **Reload the page**, add the same file again and the upload continues from the server's offset. |
| **Append mode** | Create an upload with no length (creation-defer-length), append lines, then fix the length to finish. This is the log-file case from the architecture decision. |

## Typical checks

1. **Resume:** add a test file, start the upload, press Pause, then Resume. The log shows a `HEAD`, then `PATCH` continuing from the reported offset.
2. **Crash:** start a slow upload, press **Reload the page**, add the same test file (same size and seed), start again. It continues.
3. **Large file:** generate 500 MB, turn slow mode off, upload, and let **Verify content** confirm it.
4. **Cleanup:** press Terminate mid-upload. The server must forget it.

## Tests

```bash
python3 -m unittest discover -s tests        # the mock tus server
node --test tests/lib.test.mjs               # the page's pure helpers (Node 20+)
python3 tests/e2e/run.py                     # drives the page in Chrome (needs playwright for python)
```

The browser test replaces Uppy with a small stand-in (`tests/e2e/uppy-stub.mjs`) because it must work offline. It checks the page and the tools, not Uppy itself.

## Layout

```
index.html        the page's markup
assets/app.css    all styling
assets/core.js    shared helpers and state
assets/api.js     one place that makes requests (so they appear in the log)
assets/log.js     request log, curl, export
assets/uploader.js  Uppy and the Upload cards
assets/tools.js   the other cards
assets/lib.js     pure helpers (test file, JWT expiry, byte compare)
serve.py          local server: page, mock tus server, reverse proxy
```

## Using the page without serve.py

You can serve the folder from any static host and point the page at the service directly, but then the browser enforces CORS. The service must answer the preflight with:

- `Access-Control-Allow-Origin` for the page's origin
- `Access-Control-Allow-Methods` including `GET, POST, HEAD, PATCH, OPTIONS, DELETE`
- `Access-Control-Allow-Headers` including `Tus-Resumable, Upload-Length, Upload-Defer-Length, Upload-Offset, Upload-Metadata, Upload-Checksum, Content-Type, Authorization`
- `Access-Control-Expose-Headers` including `Location, Content-Location, Upload-Offset, Upload-Length, Upload-Expires, Upload-Defer-Length, Tus-Resumable, Tus-Version, Tus-Extension, Tus-Max-Size`

## Notes

- Uppy is pinned to v5.2.1 in `assets/uploader.js` and `index.html`. Change the version in all three CDN URLs to upgrade.
- The authorization token is read from the form and kept in memory only. Do not commit tokens or internal host names to this repository.
- `serve.py` is a development tool: it binds to localhost only and has no access control.
