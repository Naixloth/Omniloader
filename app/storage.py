from __future__ import annotations

import base64
import json
import os
import threading
from pathlib import Path
from typing import Any

from .config import COOKIES_FILE, DOWNLOADS_DIR, HISTORY_FILE, SETTINGS_FILE

_lock = threading.RLock()

DEFAULT_SETTINGS: dict[str, Any] = {
    "cookie_mode": "none",  # "none" | "browser" | "file"
    "cookie_browser": "chrome",
    "max_concurrent": 2,
}


def bootstrap_env_cookies() -> None:
    """Restore cookies.txt from COOKIES_BASE64 env var on ephemeral cloud containers."""
    b64 = os.environ.get("COOKIES_BASE64", "").strip()
    if not b64:
        return
    if COOKIES_FILE.exists() and COOKIES_FILE.stat().st_size > 10:
        return
    try:
        decoded = base64.b64decode(b64).decode("utf-8", errors="replace").strip()
        if decoded:
            if "# Netscape HTTP Cookie File" not in decoded and "\t" in decoded:
                decoded = "# Netscape HTTP Cookie File\n" + decoded
            COOKIES_FILE.write_text(decoded + "\n", encoding="utf-8")
            save_settings({"cookie_mode": "file"})
    except Exception:
        pass


def get_cookies_base64() -> str | None:
    if not COOKIES_FILE.exists() or COOKIES_FILE.stat().st_size <= 10:
        return None
    raw = COOKIES_FILE.read_bytes()
    return base64.b64encode(raw).decode("ascii")


def load_settings() -> dict[str, Any]:
    with _lock:
        data = dict(DEFAULT_SETTINGS)
        if SETTINGS_FILE.exists():
            try:
                loaded = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    data.update(loaded)
            except Exception:
                pass
        data["has_cookie_file"] = COOKIES_FILE.exists() and COOKIES_FILE.stat().st_size > 10
        return data


def save_settings(updates: dict[str, Any]) -> dict[str, Any]:
    with _lock:
        current = load_settings()
        current.update(updates)
        to_persist = {k: v for k, v in current.items() if k != "has_cookie_file"}
        SETTINGS_FILE.write_text(
            json.dumps(to_persist, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        current["has_cookie_file"] = COOKIES_FILE.exists() and COOKIES_FILE.stat().st_size > 10
        return current


def load_history() -> list[dict[str, Any]]:
    with _lock:
        if not HISTORY_FILE.exists():
            return []
        try:
            items = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
            if not isinstance(items, list):
                return []
        except Exception:
            return []

        enriched: list[dict[str, Any]] = []
        for item in items:
            filename = item.get("filename")
            file_exists = False
            if filename:
                fpath = DOWNLOADS_DIR / Path(filename).name
                file_exists = fpath.exists()
            item["file_exists"] = file_exists
            enriched.append(item)
        return enriched


def add_history_item(entry: dict[str, Any]) -> None:
    with _lock:
        items: list[dict[str, Any]] = []
        if HISTORY_FILE.exists():
            try:
                loaded = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
                if isinstance(loaded, list):
                    items = loaded
            except Exception:
                items = []
        items = [x for x in items if x.get("id") != entry.get("id")]
        items.insert(0, entry)
        items = items[:200]
        HISTORY_FILE.write_text(
            json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8"
        )


def delete_history_item(item_id: str, delete_disk_file: bool = False) -> bool:
    with _lock:
        if not HISTORY_FILE.exists():
            return False
        try:
            items = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
        except Exception:
            return False
        target = next((x for x in items if x.get("id") == item_id), None)
        if not target:
            return False
        if delete_disk_file and target.get("filename"):
            fpath = DOWNLOADS_DIR / Path(target["filename"]).name
            if fpath.exists():
                try:
                    fpath.unlink()
                except Exception:
                    pass
        new_items = [x for x in items if x.get("id") != item_id]
        HISTORY_FILE.write_text(
            json.dumps(new_items, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return True


def clear_all_history(delete_disk_files: bool = False) -> None:
    with _lock:
        if delete_disk_files and HISTORY_FILE.exists():
            try:
                items = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
                for target in items:
                    if target.get("filename"):
                        fpath = DOWNLOADS_DIR / Path(target["filename"]).name
                        if fpath.exists():
                            try:
                                fpath.unlink()
                            except Exception:
                                pass
            except Exception:
                pass
        HISTORY_FILE.write_text("[]", encoding="utf-8")
