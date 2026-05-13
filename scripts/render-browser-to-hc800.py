#!/usr/bin/env python3
"""Render any modern web app in host Chromium and push frames to the HC800.

This runs on a Mac/Linux workstation, not on the HC800. It uses Playwright to
render the target page at 1280x720, converts the screenshot to the HC800's BGRX
framebuffer format, and POSTs it to the kiosk API's /api/frame endpoint.

Use this path for React/Vue/Svelte dashboards. The HC800 remains the HDMI
framebuffer endpoint while the workstation supplies modern browser rendering.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

try:
    from PIL import Image
except ImportError as exc:  # pragma: no cover - dependency hint
    raise SystemExit("Missing Pillow. Run: python3 -m pip install -r requirements-renderer.txt") from exc

try:
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
    from playwright.sync_api import sync_playwright
except ImportError as exc:  # pragma: no cover - dependency hint
    raise SystemExit(
        "Missing Playwright. Run: python3 -m pip install -r requirements-renderer.txt "
        "&& python3 -m playwright install chromium"
    ) from exc


WIDTH = 1280
HEIGHT = 720
FRAME_SIZE = WIDTH * HEIGHT * 4


@dataclass
class KioskConfig:
    enabled: bool
    url: str
    fps: float


def http_json(method: str, url: str, body: dict[str, Any] | None = None, timeout: float = 30) -> dict[str, Any]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8"))


def get_config(api: str, fallback_url: str, fallback_fps: float) -> KioskConfig:
    try:
        payload = http_json("GET", api.rstrip("/") + "/api/config", timeout=10)
        cfg = payload.get("config", {})
        return KioskConfig(
            enabled=bool(cfg.get("enabled", True)),
            url=str(cfg.get("url") or fallback_url),
            fps=float(cfg.get("fps") or fallback_fps),
        )
    except Exception:
        return KioskConfig(enabled=True, url=fallback_url, fps=fallback_fps)


def png_to_bgrx(png_bytes: bytes) -> bytes:
    image = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    if image.size != (WIDTH, HEIGHT):
        image = image.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)

    rgb = image.tobytes()
    out = bytearray(FRAME_SIZE)
    j = 0
    for i in range(0, len(rgb), 3):
        r = rgb[i]
        g = rgb[i + 1]
        b = rgb[i + 2]
        out[j] = b
        out[j + 1] = g
        out[j + 2] = r
        out[j + 3] = 0
        j += 4
    return bytes(out)


def post_frame(api: str, frame: bytes, token: str = "") -> dict[str, Any]:
    if len(frame) != FRAME_SIZE:
        raise ValueError(f"frame is {len(frame)} bytes; expected {FRAME_SIZE}")
    headers = {"Content-Type": "application/octet-stream"}
    if token:
        headers["X-C4Kiosk-Token"] = token
    req = urllib.request.Request(
        api.rstrip("/") + "/api/frame",
        data=frame,
        method="POST",
        headers=headers,
    )
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read().decode("utf-8"))


def run(args: argparse.Namespace) -> None:
    api = args.api.rstrip("/")
    last_url = None
    page = None

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": WIDTH, "height": HEIGHT}, device_scale_factor=1)
        try:
            while True:
                cfg = get_config(api, args.url, args.fps) if args.poll else KioskConfig(True, args.url, args.fps)
                if not cfg.enabled:
                    print("renderer disabled by API config")
                    time.sleep(max(1, args.poll_interval))
                    continue

                if page is None:
                    page = context.new_page()

                if cfg.url != last_url or args.reload_each_frame:
                    print(f"loading {cfg.url}")
                    try:
                        page.goto(cfg.url, wait_until=args.wait_until, timeout=args.navigation_timeout_ms)
                    except PlaywrightTimeoutError:
                        if not args.ignore_navigation_timeout:
                            raise
                        print("navigation timed out; posting latest rendered frame anyway")
                    last_url = cfg.url
                    if args.settle_ms:
                        page.wait_for_timeout(args.settle_ms)

                png = page.screenshot(type="png", full_page=False)
                frame = png_to_bgrx(png)
                result = post_frame(api, frame, args.token)
                print(json.dumps({"posted": result, "url": cfg.url}, separators=(",", ":")))

                if args.once:
                    break
                delay = 1.0 / max(0.1, min(10.0, cfg.fps))
                time.sleep(delay)
        finally:
            context.close()
            browser.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", default="http://192.168.1.147:8099", help="HC800 kiosk API base URL")
    parser.add_argument("--url", default="http://192.168.1.147/c4kiosk/", help="URL to render if not polling API config")
    parser.add_argument("--fps", type=float, default=1.0, help="frames per second")
    parser.add_argument("--once", action="store_true", help="render and post one frame")
    parser.add_argument("--poll", action="store_true", help="poll /api/config for URL/fps/enabled")
    parser.add_argument("--token", default=os.environ.get("C4KIOSK_TOKEN", ""), help="API token, or set C4KIOSK_TOKEN")
    parser.add_argument("--poll-interval", type=float, default=2.0, help="seconds to wait when API disables renderer")
    parser.add_argument("--reload-each-frame", action="store_true", help="reload page before every screenshot")
    parser.add_argument("--wait-until", default="load", choices=("commit", "domcontentloaded", "load", "networkidle"))
    parser.add_argument("--settle-ms", type=int, default=1500, help="extra wait after navigation")
    parser.add_argument("--navigation-timeout-ms", type=int, default=30000)
    parser.add_argument("--ignore-navigation-timeout", action="store_true", help="post whatever rendered if navigation stalls")
    args = parser.parse_args()

    try:
        run(args)
    except urllib.error.HTTPError as err:
        raise SystemExit(f"HTTP {err.code}: {err.read().decode('utf-8', errors='replace')}") from err


if __name__ == "__main__":
    main()