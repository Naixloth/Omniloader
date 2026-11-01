from __future__ import annotations

import re
import subprocess
import threading
import time
from typing import Any

from .config import DEFAULT_PORT, get_cloudflared_binary

_TUNNEL_URL_RE = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")


class TunnelManager:
    """Manages an optional Cloudflare Quick Tunnel for 5G / outside-LAN iPhone access."""

    def __init__(self, port: int = DEFAULT_PORT) -> None:
        self.port = port
        self._lock = threading.RLock()
        self._proc: subprocess.Popen[str] | None = None
        self._public_url: str | None = None
        self._status: str = "stopped"  # stopped | starting | running | error
        self._error: str | None = None

    def get_state(self) -> dict[str, Any]:
        with self._lock:
            if self._proc is not None and self._proc.poll() is not None:
                self._status = "stopped"
                self._public_url = None
                self._proc = None
            return {
                "available": get_cloudflared_binary() is not None,
                "status": self._status,
                "public_url": self._public_url,
                "error": self._error,
            }

    def start(self) -> dict[str, Any]:
        with self._lock:
            if self._proc is not None and self._proc.poll() is None and self._public_url:
                return self.get_state()

            cf_bin = get_cloudflared_binary()
            if not cf_bin:
                self._status = "error"
                self._error = "cloudflared ikili dosyası bin/ klasöründe bulunamadı."
                return self.get_state()

            self.stop()
            self._status = "starting"
            self._error = None
            self._public_url = None

            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            try:
                self._proc = subprocess.Popen(
                    [
                        cf_bin,
                        "tunnel",
                        "--url",
                        f"http://127.0.0.1:{self.port}",
                        "--no-autoupdate",
                    ],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    creationflags=creationflags,
                )
            except Exception as exc:
                self._status = "error"
                self._error = f"Tünel başlatılamadı: {exc}"
                return self.get_state()

            proc = self._proc

        def _reader() -> None:
            assert proc.stdout is not None
            for line in proc.stdout:
                match = _TUNNEL_URL_RE.search(line)
                if match:
                    with self._lock:
                        self._public_url = match.group(0)
                        self._status = "running"
                        self._error = None
            with self._lock:
                if self._proc is proc:
                    if not self._public_url and self._status == "starting":
                        self._status = "error"
                        self._error = "Cloudflare tünel bağlantısı kesildi."
                    else:
                        self._status = "stopped"
                        self._public_url = None

        t = threading.Thread(target=_reader, daemon=True)
        t.start()

        # Wait up to 8 seconds for URL to appear so the caller gets it immediately
        deadline = time.time() + 8.0
        while time.time() < deadline:
            state = self.get_state()
            if state["status"] in ("running", "error"):
                return state
            time.sleep(0.25)

        return self.get_state()

    def stop(self) -> dict[str, Any]:
        with self._lock:
            if self._proc is not None:
                try:
                    self._proc.terminate()
                    self._proc.wait(timeout=2)
                except Exception:
                    try:
                        self._proc.kill()
                    except Exception:
                        pass
                self._proc = None
            self._public_url = None
            self._status = "stopped"
            self._error = None
            return self.get_state()


tunnel_manager = TunnelManager()
