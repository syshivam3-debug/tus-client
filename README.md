# tus-client

A small browser demo of resumable uploads using the [tus](https://tus.io) protocol, built with [Uppy](https://uppy.io). It is meant for showing a tus-enabled file service: pick a large file, pause or cut the connection, and watch the upload continue from where it stopped.

## Run it

Needs Python 3.8+ and a browser with internet access (Uppy loads from Transloadit's CDN). Nothing to install.

```bash
# Rehearse with a built-in fake tus server (no real service needed)
python3 serve.py --mock

# Use the real service. The page and the API share one origin, so CORS is not involved.
python3 serve.py --target https://your-dev-host:8443 --header "Authorization: Bearer <token>"
```

Open http://localhost:8000/. In **Connection**, set the upload endpoint to the same path you use in Postman (for example `/files/uploads`), then press **Apply**.

Options: `--port`, `--cafile` (CA bundle for an internal https certificate), `--max-size` (mock only).

## Demo script

1. Pick any file and press Upload. **Slow demo mode** (on by default) splits the file into about 8 chunks and waits 1 second before each one, so even a 160 KB file takes several seconds and there is time to pause. Turn it off to upload at full speed with the chunk size from the form.
2. Press **Pause** (or switch the browser's Network tab to Offline). The server keeps what it received.
3. Press **Resume** (or go back online). The log shows a `HEAD` request, then `PATCH` continuing from the reported offset.
4. Watch **Upload details**: it shows the file, the upload ID and URL once the session exists, progress and status while uploading, and the file location (`Content-Location`) plus the file record once the service finishes.
5. Optional: reload the page mid-upload and add the same file again. The client finds the unfinished upload and continues it.

## Using the page without serve.py

You can open `index.html` from any static host and point it at the service directly, but then the browser enforces CORS. The service must answer the preflight with:

- `Access-Control-Allow-Origin` for the page's origin
- `Access-Control-Allow-Methods` including `POST, HEAD, PATCH, OPTIONS, DELETE`
- `Access-Control-Allow-Headers` including `Tus-Resumable, Upload-Length, Upload-Offset, Upload-Metadata, Content-Type, Authorization`
- `Access-Control-Expose-Headers` including `Location, Upload-Offset, Upload-Length, Tus-Resumable`

## Notes

- Uppy is pinned to v5.2.1 in `index.html`. Change the version in both CDN URLs to upgrade.
- The authorization token is read from the form and kept in memory only. Do not commit tokens or internal host names to this repository.
- `serve.py` is a demo tool: it binds to localhost only and has no access control.
