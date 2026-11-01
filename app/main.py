from __future__ import annotations

import asyncio
import hashlib
import hmac
import io
import ipaddress
import json
import os
import subprocess
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator
from urllib.parse import quote, urlparse

import httpx
import qrcode
from fastapi import FastAPI, File, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .config import (
    APP_PASSWORD,
    CLOUD_MODE,
    COOKIES_FILE,
    DEFAULT_PORT,
    DOWNLOADS_DIR,
    MAX_FILE_AGE_HOURS,
    MAX_STORAGE_MB,
    STATIC_DIR,
    get_ffmpeg_location,
    get_local_lan_ips,
)
from .downloader import analyze_url, queue_manager
from .models import (
    AnalyzeRequest,
    AuthLoginRequest,
    BatchDownloadRequest,
    CookieSettingsUpdate,
    DownloadRequest,
    RawUrlsBatchRequest,
)
from .storage import (
    clear_all_history,
    delete_history_item,
    load_history,
    load_settings,
    save_settings,
)
from .tunnel import tunnel_manager

SESSION_COOKIE_NAME = "omni_session"


def _expected_session_token() -> str:
    if not APP_PASSWORD:
        return ""
    return hmac.new(
        APP_PASSWORD.encode("utf-8"),
        b"omni-indir-session-v1",
        hashlib.sha256,
    ).hexdigest()


def _is_authenticated(request: Request) -> bool:
    if not APP_PASSWORD:
        return True
    cookie_val = request.cookies.get(SESSION_COOKIE_NAME, "")
    expected = _expected_session_token()
    return bool(cookie_val) and hmac.compare_digest(cookie_val, expected)


def _prune_downloads_folder() -> None:
    if MAX_FILE_AGE_HOURS <= 0 and MAX_STORAGE_MB <= 0:
        return
    try:
        now = time.time()
        files = [p for p in DOWNLOADS_DIR.iterdir() if p.is_file()]
        if MAX_FILE_AGE_HOURS > 0:
            cutoff = now - (MAX_FILE_AGE_HOURS * 3600.0)
            for f in list(files):
                try:
                    if f.stat().st_mtime < cutoff:
                        f.unlink(missing_ok=True)
                        files.remove(f)
                except Exception:
                    pass

        if MAX_STORAGE_MB > 0:
            max_bytes = MAX_STORAGE_MB * 1024 * 1024
            files.sort(key=lambda p: p.stat().st_mtime)
            total = sum(p.stat().st_size for p in files if p.exists())
            while total > max_bytes and files:
                oldest = files.pop(0)
                try:
                    sz = oldest.stat().st_size
                    oldest.unlink(missing_ok=True)
                    total -= sz
                except Exception:
                    pass
    except Exception:
        pass


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None, None]:
    stop_ev = asyncio.Event()

    async def _cleanup_worker() -> None:
        while not stop_ev.is_set():
            await asyncio.to_thread(_prune_downloads_folder)
            try:
                await asyncio.wait_for(stop_ev.wait(), timeout=600.0)
            except asyncio.TimeoutError:
                pass

    task = asyncio.create_task(_cleanup_worker())
    yield
    stop_ev.set()
    task.cancel()
    tunnel_manager.stop()


app = FastAPI(
    title="Omniİndir — Evrensel Medya İndirici",
    version="1.1.0",
    lifespan=lifespan,
)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path
    if (
        APP_PASSWORD
        and path.startswith("/api/")
        and not path.startswith("/api/auth/")
        and not _is_authenticated(request)
    ):
        return JSONResponse(
            status_code=401,
            content={"detail": "Erişim için giriş şifresi gereklidir."},
        )
    return await call_next(request)


@app.get("/api/auth/status")
async def api_auth_status(request: Request) -> dict:
    return {
        "required": bool(APP_PASSWORD),
        "authenticated": _is_authenticated(request),
    }


@app.post("/api/auth/login")
async def api_auth_login(payload: AuthLoginRequest, request: Request, response: Response) -> dict:
    if not APP_PASSWORD:
        return {"ok": True}
    given = (payload.password or "").strip()
    if not hmac.compare_digest(given.encode("utf-8"), APP_PASSWORD.encode("utf-8")):
        raise HTTPException(status_code=401, detail="Hatalı şifre / PIN girdiniz.")

    is_https = (
        request.url.scheme == "https"
        or request.headers.get("x-forwarded-proto", "").lower() == "https"
    )
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=_expected_session_token(),
        max_age=90 * 24 * 3600,
        httponly=True,
        samesite="lax",
        secure=is_https,
    )
    return {"ok": True}


@app.post("/api/auth/logout")
async def api_auth_logout(response: Response) -> dict:
    response.delete_cookie(SESSION_COOKIE_NAME)
    return {"ok": True}


def _is_loopback_request(request: Request) -> bool:
    if CLOUD_MODE:
        return False
    host = (request.client.host if request.client else "") or ""
    if request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for"):
        return False
    return host in ("127.0.0.1", "::1", "localhost")


@app.get("/api/system")
async def get_system_info(request: Request) -> dict:
    lan_ips = get_local_lan_ips()
    port = DEFAULT_PORT
    lan_urls = [f"http://{ip}:{port}" for ip in lan_ips]
    return {
        "port": port,
        "cloud_mode": CLOUD_MODE,
        "auth_enabled": bool(APP_PASSWORD),
        "lan_ips": lan_ips,
        "primary_lan_url": lan_urls[0] if lan_urls else f"http://127.0.0.1:{port}",
        "lan_urls": lan_urls,
        "ffmpeg_ready": get_ffmpeg_location() is not None,
        "downloads_dir": str(DOWNLOADS_DIR),
        "is_local_pc": _is_loopback_request(request),
        "settings": load_settings(),
        "tunnel": tunnel_manager.get_state() if not CLOUD_MODE else {"available": False, "status": "stopped"},
    }


@app.get("/api/qr")
async def generate_qr_code(text: str = Query(..., min_length=4, max_length=512)) -> Response:
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=8,
        border=2,
    )
    qr.add_data(text)
    qr.make(fit=True)
    img = qr.make_image(fill_color="#0f172a", back_color="#ffffff")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png")


def _is_safe_public_url(raw_url: str) -> bool:
    try:
        parsed = urlparse(raw_url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            return False
        host = parsed.hostname.lower()
        if host in ("localhost", "127.0.0.1", "::1"):
            return False
        try:
            ip = ipaddress.ip_address(host)
            if ip.is_private or ip.is_loopback or ip.is_link_local:
                return False
        except ValueError:
            pass
        return True
    except Exception:
        return False


@app.get("/api/thumbnail")
async def proxy_thumbnail(url: str = Query(..., min_length=8, max_length=2048)) -> Response:
    if not _is_safe_public_url(url):
        raise HTTPException(status_code=400, detail="Geçersiz küçük resim bağlantısı.")
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        ),
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    }
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=10.0) as client:
            resp = await client.get(url, headers=headers)
            if resp.status_code >= 400:
                raise HTTPException(status_code=404, detail="Küçük resim yüklenemedi.")
            ctype = resp.headers.get("content-type", "image/jpeg")
            if not ctype.startswith("image/"):
                ctype = "image/jpeg"
            return Response(
                content=resp.content,
                media_type=ctype,
                headers={"Cache-Control": "public, max-age=3600"},
            )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Küçük resim alınamadı.") from exc


@app.post("/api/analyze")
async def api_analyze(payload: AnalyzeRequest) -> dict:
    try:
        res = await asyncio.to_thread(analyze_url, payload.url, payload.include_playlist)
        return res.model_dump()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Analiz hatası: {exc}") from exc


@app.post("/api/download")
async def api_start_download(payload: DownloadRequest) -> dict:
    try:
        job = queue_manager.enqueue(payload)
        return {"job": job}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/download/batch")
async def api_batch_download(payload: BatchDownloadRequest) -> dict:
    if not payload.items:
        raise HTTPException(status_code=400, detail="İndirilecek öğe seçilmedi.")
    jobs = []
    errors = []
    for item in payload.items[:200]:
        try:
            jobs.append(queue_manager.enqueue(item))
        except Exception as exc:
            errors.append(str(exc))
    return {"jobs": jobs, "errors": errors}


@app.post("/api/download/urls")
async def api_raw_urls_download(payload: RawUrlsBatchRequest) -> dict:
    cleaned = [u.strip() for u in payload.urls if u and u.strip()]
    if not cleaned:
        raise HTTPException(status_code=400, detail="Lütfen en az bir bağlantı girin.")
    jobs = []
    errors = []
    for u in cleaned[:100]:
        req = DownloadRequest(
            url=u,
            mode=payload.mode,
            quality=payload.quality,
            audio_format=payload.audio_format,
            audio_bitrate=payload.audio_bitrate,
            iphone_compatible=payload.iphone_compatible,
        )
        try:
            jobs.append(queue_manager.enqueue(req))
        except Exception as exc:
            errors.append(f"{u[:50]}: {exc}")
    return {"jobs": jobs, "errors": errors}


@app.get("/api/jobs")
async def api_list_jobs() -> dict:
    return {"jobs": queue_manager.list_jobs()}


@app.post("/api/jobs/{job_id}/cancel")
async def api_cancel_job(job_id: str) -> dict:
    ok = queue_manager.cancel_job(job_id)
    if not ok:
        raise HTTPException(status_code=404, detail="İndirme görevi bulunamadı.")
    return {"ok": True}


@app.post("/api/jobs/clear")
async def api_clear_finished_jobs() -> dict:
    queue_manager.clear_finished_jobs()
    return {"ok": True}


@app.get("/api/events")
async def api_sse_events(request: Request) -> StreamingResponse:
    async def _event_generator() -> AsyncGenerator[str, None]:
        last_ver = -1
        idle_ticks = 0
        while True:
            if await request.is_disconnected():
                break
            cur_ver = queue_manager.version
            if cur_ver != last_ver:
                last_ver = cur_ver
                idle_ticks = 0
                data = json.dumps({"jobs": queue_manager.list_jobs()}, ensure_ascii=False)
                yield f"data: {data}\n\n"
            else:
                idle_ticks += 1
                if idle_ticks >= 50:
                    idle_ticks = 0
                    yield ": keepalive\n\n"
            await asyncio.sleep(0.25)

    return StreamingResponse(
        _event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/files/{filename}")
async def api_serve_file(filename: str, download: int = Query(1)) -> FileResponse:
    safe_name = Path(filename).name
    filepath = DOWNLOADS_DIR / safe_name
    if not filepath.exists() or not filepath.is_file():
        raise HTTPException(status_code=404, detail="Dosya diskte bulunamadı.")

    ext = filepath.suffix.lower()
    mime_map = {
        ".mp4": "video/mp4",
        ".m4a": "audio/mp4",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".opus": "audio/ogg",
        ".webm": "video/webm",
        ".mkv": "video/x-matroska",
    }
    media_type = mime_map.get(ext, "application/octet-stream")

    headers = {}
    if download:
        ascii_fallback = safe_name.encode("ascii", "ignore").decode("ascii") or f"medya{ext}"
        ascii_fallback = ascii_fallback.replace('"', "")
        utf8_quoted = quote(safe_name)
        headers["Content-Disposition"] = (
            f'attachment; filename="{ascii_fallback}"; filename*=UTF-8\'\'{utf8_quoted}'
        )

    return FileResponse(
        path=filepath,
        media_type=media_type,
        headers=headers,
    )


@app.post("/api/open-folder")
async def api_open_folder(request: Request, filename: str | None = Query(None)) -> dict:
    if not _is_loopback_request(request):
        raise HTTPException(
            status_code=403,
            detail="Klasör açma işlemi yalnızca yerel Windows bilgisayar üzerinden yapılabilir.",
        )
    if os.name == "nt":
        if filename:
            safe_name = Path(filename).name
            target = DOWNLOADS_DIR / safe_name
            if target.exists():
                subprocess.Popen(["explorer", f"/select,{target}"])
                return {"ok": True}
        os.startfile(str(DOWNLOADS_DIR))
    return {"ok": True}


@app.get("/api/history")
async def api_get_history() -> dict:
    return {"items": load_history()}


@app.delete("/api/history/{item_id}")
async def api_delete_history_item(item_id: str, delete_file: bool = Query(False)) -> dict:
    ok = delete_history_item(item_id, delete_disk_file=delete_file)
    if not ok:
        raise HTTPException(status_code=404, detail="Kayıt bulunamadı.")
    return {"ok": True}


@app.delete("/api/history")
async def api_clear_history(delete_files: bool = Query(False)) -> dict:
    clear_all_history(delete_disk_files=delete_files)
    return {"ok": True}


@app.get("/api/cookies")
async def api_get_cookies() -> dict:
    return load_settings()


@app.post("/api/cookies")
async def api_update_cookies(payload: CookieSettingsUpdate) -> dict:
    if payload.cookies_text is not None and payload.cookies_text.strip():
        text = payload.cookies_text.strip()
        if "# Netscape HTTP Cookie File" not in text and "\t" in text:
            text = "# Netscape HTTP Cookie File\n" + text
        COOKIES_FILE.write_text(text + "\n", encoding="utf-8")

    updated = save_settings(
        {
            "cookie_mode": payload.mode,
            "cookie_browser": payload.browser,
        }
    )
    return updated


@app.post("/api/cookies/upload")
async def api_upload_cookie_file(file: UploadFile = File(...)) -> dict:
    raw = await file.read()
    if len(raw) > 5 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Çerez dosyası çok büyük (Maks 5MB).")
    text = raw.decode("utf-8", errors="replace").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Yüklenen dosya boş.")
    if "# Netscape HTTP Cookie File" not in text and "\t" in text:
        text = "# Netscape HTTP Cookie File\n" + text
    COOKIES_FILE.write_text(text + "\n", encoding="utf-8")
    updated = save_settings({"cookie_mode": "file"})
    return updated


@app.delete("/api/cookies/file")
async def api_delete_cookie_file() -> dict:
    if COOKIES_FILE.exists():
        COOKIES_FILE.unlink(missing_ok=True)
    cur = load_settings()
    if cur.get("cookie_mode") == "file":
        cur = save_settings({"cookie_mode": "none"})
    return cur


@app.post("/api/tunnel/start")
async def api_start_tunnel() -> dict:
    if CLOUD_MODE:
        raise HTTPException(status_code=400, detail="Uygulama zaten bulut sunucuda çalışıyor.")
    state = await asyncio.to_thread(tunnel_manager.start)
    return state


@app.post("/api/tunnel/stop")
async def api_stop_tunnel() -> dict:
    state = await asyncio.to_thread(tunnel_manager.stop)
    return state


app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
