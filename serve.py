#!/usr/bin/env python3
"""Zero-dependency local development server for PULSE/LAB.

For Android testing over USB:
  1. python serve.py
  2. adb reverse tcp:8787 tcp:8787
  3. Open http://127.0.0.1:8787 on the phone (Chrome)

Chrome treats localhost as a secure context, which Web Bluetooth requires.
For everyday phone use, deploy the folder to any HTTPS static host and install
the PWA to the home screen.
"""

from __future__ import annotations

import argparse
import functools
import http.server
import os
import socketserver
import sys
import threading
import webbrowser


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".webmanifest": "application/manifest+json",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
    }

    def end_headers(self) -> None:
        # Development convenience: always pick up edits.
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("[serve] " + fmt % args + "\n")


class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve PULSE/LAB locally")
    parser.add_argument("--host", default="127.0.0.1", help="interface (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8787, help="port (default: 8787)")
    parser.add_argument("--open", action="store_true", help="open the page in the desktop browser")
    args = parser.parse_args()

    root = os.path.dirname(os.path.abspath(__file__))
    os.chdir(root)
    handler = functools.partial(Handler, directory=root)

    with ThreadedServer((args.host, args.port), handler) as server:
        local_url = f"http://127.0.0.1:{args.port}/"
        print("PULSE/LAB dev server")
        print(f"  Desktop: {local_url}")
        print("  Android (USB): adb reverse tcp:%d tcp:%d" % (args.port, args.port))
        print(f"  Android URL:  http://127.0.0.1:{args.port}/")
        print("  Web Bluetooth requires HTTPS in production. Press Ctrl+C to stop.")
        sys.stdout.flush()
        if args.open:
            threading.Timer(0.4, lambda: webbrowser.open(local_url)).start()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
