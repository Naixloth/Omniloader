from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

import httpx
import yt_dlp
from yt_dlp.networking.impersonate import ImpersonateTarget
from yt_dlp.utils import DownloadCancelled, download_range_func

from .config import (
    CLOUD_MODE,
    COOKIES_FILE,
    DOWNLOADS_DIR,
    TEMP_DIR,
    get_ffmpeg_binary,
    get_ffmpeg_location,
    get_ffprobe_binary,
)
from .models import (
    AnalyzeResponse,
    DownloadRequest,
    FormatOption,
    PlaylistEntryItem,
)
from .storage import add_history_item, load_settings

_URL_EXTRACT_RE = re.compile(r"https?://[^\s<>\"']+")
_SAFE_FILENAME_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def extract_clean_url(raw: str) -> str:
    text = (raw or "").strip()
    if not text:
        raise ValueError("Lütfen geçerli bir bağlantı (URL) girin.")
    if text.startswith(("http://", "https://")) and " " not in text:
        return text
    match = _URL_EXTRACT_RE.search(text)
    if match:
        return match.group(0).rstrip(".,;)")
    if "." in text and " " not in text:
        return "https://" + text
    raise ValueError("Metin içerisinde geçerli bir web bağlantısı bulunamadı.")


def detect_platform(url: str, extractor: str | None = None) -> str:
    ext = (extractor or "").lower()
    host = urlparse(url).netloc.lower()
    combined = f"{ext} {host}"
    if "youtube" in combined or "youtu.be" in combined:
        return "YouTube"
    if "instagram" in combined:
        return "Instagram"
    if "twitter" in combined or "x.com" in combined or "t.co" in combined:
        return "X (Twitter)"
    if "tiktok" in combined:
        return "TikTok"
    if "reddit" in combined or "redd.it" in combined:
        return "Reddit"
    if "facebook" in combined or "fb.watch" in combined:
        return "Facebook"
    if "twitch" in combined:
        return "Twitch"
    if "kick.com" in combined or ext == "kick":
        return "Kick"
    if "vimeo" in combined:
        return "Vimeo"
    if "pinterest" in combined or "pin.it" in combined:
        return "Pinterest"
    if "soundcloud" in combined:
        return "SoundCloud"
    if "dailymotion" in combined:
        return "Dailymotion"
    if extractor:
        return extractor.split(":")[0].capitalize()
    return "Web Medya"


def parse_timestamp_seconds(val: str | None) -> float | None:
    if val is None:
        return None
    s = val.strip()
    if not s:
        return None
    parts = s.split(":")
    try:
        if len(parts) == 1:
            sec = float(parts[0].replace(",", "."))
        elif len(parts) == 2:
            sec = int(parts[0]) * 60 + float(parts[1].replace(",", "."))
        elif len(parts) == 3:
            sec = int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2].replace(",", "."))
        else:
            raise ValueError
    except ValueError as exc:
        raise ValueError(
            f"Geçersiz zaman formatı: '{val}'. Örnek: 01:15 veya 00:02:30"
        ) from exc
    if sec < 0:
        raise ValueError("Zaman değeri negatif olamaz.")
    return sec


def sanitize_filename(name: str, max_len: int = 110) -> str:
    cleaned = _SAFE_FILENAME_RE.sub("_", name or "medya")
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ._")
    if not cleaned:
        cleaned = "medya"
    return cleaned[:max_len].strip(" ._")


def _base_ydl_opts(apply_cookies: bool = True, target_url: str | None = None) -> dict[str, Any]:
    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "nocheckcertificate": False,
        "geo_bypass": True,
        "socket_timeout": 25,
        "retries": 3,
        "fragment_retries": 5,
        "concurrent_fragment_downloads": 2 if CLOUD_MODE else 4,
    }
    ffmpeg_loc = get_ffmpeg_location()
    if ffmpeg_loc:
        opts["ffmpeg_location"] = ffmpeg_loc

    if shutil.which("node"):
        opts["js_runtimes"] = {"node": {}}

    host = urlparse(target_url or "").netloc.lower()
    is_yt = "youtube" in host or "youtu.be" in host

    if not is_yt:
        try:
            opts["impersonate"] = ImpersonateTarget("chrome")
        except Exception:
            pass
    elif CLOUD_MODE:
        opts["extractor_args"] = {
            "youtube": {
                "player_client": ["mweb", "tv_embedded", "ios", "web"],
            }
        }

    if apply_cookies:
        settings = load_settings()
        mode = settings.get("cookie_mode", "none")
        if mode == "file" and COOKIES_FILE.exists() and COOKIES_FILE.stat().st_size > 10:
            opts["cookiefile"] = str(COOKIES_FILE)
        elif mode == "browser" and not CLOUD_MODE:
            browser = settings.get("cookie_browser", "chrome")
            opts["cookiesfrombrowser"] = (browser,)

    return opts


def _is_cookie_lock_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    lock_phrases = (
        "dpapi",
        "could not copy chrome",
        "could not copy edge",
        "could not copy brave",
        "failed to decrypt",
        "app-bound",
        "database is locked",
    )
    return any(p in msg for p in lock_phrases)


def _friendly_error_message(exc: Exception) -> str:
    raw = str(exc)
    clean = re.sub(r"\x1b\[[0-9;]*m", "", raw)
    clean = clean.replace("ERROR: ", "").strip()
    lower = clean.lower()

    if _is_cookie_lock_error(exc):
        return (
            "Tarayıcı çerez veritabanı kilitli (Windows üzerinde Chrome/Edge açıkken "
            "şifrelenir). Lütfen üst menüdeki '🍪 Çerezler' bölümünden cookies.txt yükleyin."
        )
    if (
        "not a bot" in lower
        or "sign in to confirm" in lower
        or "--cookies" in lower
        or "login required" in lower
        or "rate-limit reached" in lower
        or "granting access" in lower
    ):
        return (
            "Platform doğrulama istedi (Bulut sunucu IP koruması veya giriş gerektiren içerik). "
            "Sağ üstteki '🍪 Çerezler' butonuna tıklayıp cookies.txt dosyanızı bir kez yükleyerek "
            "YouTube ve Instagram videolarını sorunsuz indirebilirsiniz."
        )
    if "private video" in lower or "private account" in lower:
        return "Bu video gizli bir hesaba ait. Erişim izniniz olan hesap çerezini ekleyin."
    if "unsupported url" in lower:
        return "Bu bağlantı desteklenmiyor veya sayfa içerisinde indirilebilir medya bulunamadı."
    if "video unavailable" in lower:
        return "Video kullanılamıyor, silinmiş veya bölgenizde kısıtlanmış."
    return clean[:320] if len(clean) > 320 else clean


def _check_youtube_playlist_hint(url: str) -> tuple[bool, str | None]:
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    if "youtube.com" not in host and "youtu.be" not in host:
        return False, None
    qs = parse_qs(parsed.query)
    list_ids = qs.get("list")
    v_ids = qs.get("v")
    if list_ids and v_ids:
        lid = list_ids[0]
        # Skip YouTube automatic Radio/Mix lists starting with RD unless explicitly requested
        if not lid.startswith("RD"):
            return True, f"https://www.youtube.com/playlist?list={lid}"
    return False, None


def _is_explicit_playlist_url(url: str) -> bool:
    parsed = urlparse(url)
    qs = parse_qs(parsed.query)
    if "/playlist" in parsed.path.lower() and "list" in qs:
        return True
    if "soundcloud.com" in parsed.netloc.lower() and "/sets/" in parsed.path.lower():
        return True
    return False


def _pick_best_thumbnail(info: dict[str, Any]) -> str | None:
    thumb = info.get("thumbnail")
    if thumb and isinstance(thumb, str) and thumb.startswith("http"):
        return thumb
    thumbs = info.get("thumbnails")
    if isinstance(thumbs, list):
        valid = [t for t in thumbs if isinstance(t, dict) and str(t.get("url", "")).startswith("http")]
        if valid:
            return valid[-1]["url"]
    return None


def _build_format_options(info: dict[str, Any]) -> list[FormatOption]:
    formats = info.get("formats") or []
    best_audio_size = 0
    for f in formats:
        if f.get("acodec") not in (None, "none") and f.get("vcodec") in (None, "none"):
            sz = f.get("filesize") or f.get("filesize_approx") or 0
            if sz > best_audio_size:
                best_audio_size = sz

    buckets: dict[int, dict[str, Any]] = {}
    standard_tiers = [2160, 1440, 1080, 720, 480, 360, 240]

    for f in formats:
        vcodec = f.get("vcodec")
        if not vcodec or vcodec == "none":
            continue
        w = f.get("width") or 0
        h = f.get("height") or 0
        if w <= 0 and h <= 0:
            continue
        # Handle both landscape (1920x1080 -> 1080) and vertical Reels/Shorts/TikTok (1080x1920 -> 1080)
        short_side = min(w, h) if (w > 0 and h > 0) else max(w, h)
        # Snap close dimensions to standard tiers (e.g., 1072 -> 1080, 540 -> 480/540)
        matched_res = short_side
        for tier in standard_tiers:
            if abs(short_side - tier) <= 36:
                matched_res = tier
                break

        sz = f.get("filesize") or f.get("filesize_approx") or 0
        has_audio = f.get("acodec") not in (None, "none")
        total_est = sz if (sz and has_audio) else (sz + best_audio_size if sz else 0)
        is_h264 = vcodec.startswith(("avc", "h264"))
        fps = f.get("fps") or 0

        existing = buckets.get(matched_res)
        if not existing:
            buckets[matched_res] = {
                "resolution": matched_res,
                "filesize_approx": total_est or None,
                "fps": fps or None,
                "has_h264": is_h264,
            }
        else:
            if total_est and (not existing["filesize_approx"] or total_est > existing["filesize_approx"]):
                existing["filesize_approx"] = total_est
            if fps and (not existing["fps"] or fps > existing["fps"]):
                existing["fps"] = fps
            if is_h264:
                existing["has_h264"] = True

    tier_labels = {
        2160: ("4K Ultra HD (2160p)", "4K"),
        1440: ("2K QHD (1440p)", "2K"),
        1080: ("Full HD (1080p)", "FHD"),
        720: ("HD (720p)", "HD"),
        540: ("qHD (540p)", None),
        480: ("SD (480p)", None),
        360: ("Düşük (360p)", None),
        240: ("Veri Tasarrufu (240p)", None),
    }

    result: list[FormatOption] = []
    for res in sorted(buckets.keys(), reverse=True):
        b = buckets[res]
        label, badge = tier_labels.get(res, (f"{res}p Video", "HD" if res >= 720 else None))
        result.append(
            FormatOption(
                id=str(res),
                label=label,
                resolution=res,
                ext="mp4",
                filesize_approx=b["filesize_approx"],
                fps=b["fps"],
                has_h264=b["has_h264"],
                badge=badge,
            )
        )

    if not result:
        result.append(
            FormatOption(
                id="best",
                label="En Yüksek Kalite (Otomatik MP4)",
                resolution=None,
                ext="mp4",
                has_h264=True,
                badge="OTO",
            )
        )
    return result


def _try_social_api_fallback(url: str) -> dict[str, Any] | None:
    """Zero-cookie fallback for X/Twitter (fxtwitter) and TikTok (tikwm) on cloud IPs."""
    parsed = urlparse(url)
    host = parsed.netloc.lower()

    # 1) X / Twitter public video fallback via api.fxtwitter.com
    if "x.com" in host or "twitter.com" in host:
        m = re.search(r"/([^/?#]+)/status/(\d+)", parsed.path)
        if m:
            user, tid = m.group(1), m.group(2)
            try:
                with httpx.Client(timeout=12.0, headers={"User-Agent": "OmniIndir/1.1"}) as c:
                    r = c.get(f"https://api.fxtwitter.com/{user}/status/{tid}")
                    if r.status_code == 200:
                        tweet = (r.json() or {}).get("tweet") or {}
                        videos = ((tweet.get("media") or {}).get("videos")) or []
                        if videos:
                            v0 = videos[0]
                            return {
                                "id": tid,
                                "title": (tweet.get("text") or f"X Video @{user}")[:110],
                                "uploader": (tweet.get("author") or {}).get("name") or user,
                                "duration": v0.get("duration"),
                                "thumbnail": v0.get("thumbnail_url"),
                                "direct_url": v0["url"],
                                "webpage_url": url,
                                "platform": "X (Twitter)",
                            }
            except Exception:
                pass

    # 2) TikTok watermark-free HD fallback via tikwm.com
    if "tiktok.com" in host:
        try:
            with httpx.Client(timeout=12.0, headers={"User-Agent": "Mozilla/5.0"}) as c:
                r = c.post("https://www.tikwm.com/api/", data={"url": url, "hd": "1"})
                if r.status_code == 200:
                    payload = r.json() or {}
                    data = payload.get("data") or {}
                    play_url = data.get("hdplay") or data.get("play")
                    if payload.get("code") == 0 and play_url:
                        return {
                            "id": str(data.get("id") or uuid.uuid4().hex[:8]),
                            "title": (data.get("title") or "TikTok Video")[:110],
                            "uploader": (data.get("author") or {}).get("nickname"),
                            "duration": data.get("duration"),
                            "thumbnail": data.get("cover"),
                            "direct_url": play_url,
                            "webpage_url": url,
                            "platform": "TikTok",
                        }
        except Exception:
            pass

    return None


def analyze_url(raw_url: str, include_playlist: bool = False) -> AnalyzeResponse:
    url = extract_clean_url(raw_url)
    has_playlist_param, playlist_url = _check_youtube_playlist_hint(url)
    want_playlist = include_playlist or _is_explicit_playlist_url(url)

    def _extract(use_cookies: bool) -> dict[str, Any]:
        opts = _base_ydl_opts(apply_cookies=use_cookies, target_url=url)
        if want_playlist:
            opts["extract_flat"] = "in_playlist"
            opts["noplaylist"] = False
        else:
            opts["extract_flat"] = "in_playlist"
            opts["noplaylist"] = True
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if not info:
                raise ValueError("Medya bilgisi alınamadı.")
            return info

    try:
        info = _extract(use_cookies=True)
    except Exception as exc:
        if _is_cookie_lock_error(exc):
            try:
                info = _extract(use_cookies=False)
            except Exception as inner_exc:
                fb = _try_social_api_fallback(url)
                if fb:
                    return AnalyzeResponse(
                        is_playlist=False,
                        id=fb["id"],
                        url=fb["direct_url"],
                        webpage_url=fb["webpage_url"],
                        title=fb["title"],
                        uploader=fb["uploader"],
                        duration=fb["duration"],
                        thumbnail=fb["thumbnail"],
                        platform=fb["platform"],
                        formats=[
                            FormatOption(
                                id="best",
                                label="En Yüksek Kalite (MP4)",
                                ext="mp4",
                                has_h264=True,
                                badge="HD",
                            )
                        ],
                    )
                raise ValueError(_friendly_error_message(inner_exc)) from inner_exc
        else:
            fb = _try_social_api_fallback(url)
            if fb:
                return AnalyzeResponse(
                    is_playlist=False,
                    id=fb["id"],
                    url=fb["direct_url"],
                    webpage_url=fb["webpage_url"],
                    title=fb["title"],
                    uploader=fb["uploader"],
                    duration=fb["duration"],
                    thumbnail=fb["thumbnail"],
                    platform=fb["platform"],
                    formats=[
                        FormatOption(
                            id="best",
                            label="En Yüksek Kalite (MP4)",
                            ext="mp4",
                            has_h264=True,
                            badge="HD",
                        )
                    ],
                )
            raise ValueError(_friendly_error_message(exc)) from exc

    platform = detect_platform(url, info.get("extractor_key") or info.get("extractor"))

    if info.get("_type") == "playlist" or "entries" in info:
        raw_entries = [e for e in (info.get("entries") or []) if e]
        if len(raw_entries) == 1 and not want_playlist:
            # Single-item wrapper (common on X / Instagram single video posts) — re-extract full formats if needed
            single = raw_entries[0]
            if not single.get("formats"):
                target_u = single.get("webpage_url") or single.get("url") or url
                opts2 = _base_ydl_opts(apply_cookies=True, target_url=target_u)
                opts2["noplaylist"] = True
                try:
                    with yt_dlp.YoutubeDL(opts2) as ydl:
                        info = ydl.extract_info(target_u, download=False) or single
                except Exception:
                    info = single
            else:
                info = single
        elif raw_entries:
            entries_out: list[PlaylistEntryItem] = []
            for idx, entry in enumerate(raw_entries[:250], start=1):
                entry_url = entry.get("url") or entry.get("webpage_url") or ""
                if entry_url and not entry_url.startswith("http"):
                    if platform == "YouTube":
                        entry_url = f"https://www.youtube.com/watch?v={entry.get('id') or entry_url}"
                use_idx = False
                if not entry_url or entry_url == url:
                    entry_url = url
                    use_idx = True
                entries_out.append(
                    PlaylistEntryItem(
                        index=idx,
                        id=str(entry.get("id") or idx),
                        url=entry_url,
                        use_playlist_index=use_idx,
                        title=entry.get("title") or f"Bölüm #{idx}",
                        duration=entry.get("duration"),
                        thumbnail=_pick_best_thumbnail(entry),
                        uploader=entry.get("uploader") or entry.get("channel") or info.get("uploader"),
                    )
                )
            return AnalyzeResponse(
                is_playlist=True,
                has_playlist_param=False,
                id=str(info.get("id") or uuid.uuid4().hex[:8]),
                url=url,
                webpage_url=info.get("webpage_url") or url,
                title=info.get("title") or f"{platform} Listesi ({len(entries_out)} medya)",
                uploader=info.get("uploader") or info.get("channel"),
                duration=None,
                thumbnail=_pick_best_thumbnail(info) or (entries_out[0].thumbnail if entries_out else None),
                platform=platform,
                formats=[],
                entries=entries_out,
            )

    formats_out = _build_format_options(info)
    return AnalyzeResponse(
        is_playlist=False,
        has_playlist_param=has_playlist_param,
        playlist_url=playlist_url,
        id=str(info.get("id") or uuid.uuid4().hex[:8]),
        url=url,
        webpage_url=info.get("webpage_url") or url,
        title=info.get("title") or f"{platform} Medya",
        uploader=info.get("uploader") or info.get("channel") or info.get("Creator"),
        duration=info.get("duration"),
        thumbnail=_pick_best_thumbnail(info),
        platform=platform,
        view_count=info.get("view_count"),
        formats=formats_out,
        entries=[],
    )


def _probe_streams(filepath: Path) -> list[dict[str, Any]]:
    ffprobe = get_ffprobe_binary()
    if not ffprobe or not filepath.exists():
        return []
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        res = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type,codec_name,codec_tag_string",
                "-of",
                "json",
                str(filepath),
            ],
            capture_output=True,
            text=True,
            timeout=15,
            creationflags=creationflags,
        )
        data = json.loads(res.stdout or "{}")
        return data.get("streams") or []
    except Exception:
        return []


def _ensure_compatible_mp4(
    filepath: Path,
    iphone_compatible: bool,
    on_status: Callable[[str], None],
    is_cancelled: Callable[[], bool],
) -> Path:
    """Ensure MP4 audio/video streams play smoothly on Windows & iPhone 15 Photos."""
    ffmpeg = get_ffmpeg_binary()
    if not ffmpeg or not filepath.exists() or filepath.suffix.lower() != ".mp4":
        return filepath

    streams = _probe_streams(filepath)
    if not streams:
        return filepath

    v_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    a_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if not v_stream:
        return filepath

    vcodec = (v_stream.get("codec_name") or "").lower()
    vtag = (v_stream.get("codec_tag_string") or "").lower()
    acodec = (a_stream.get("codec_name") or "").lower() if a_stream else None

    need_video_reencode = iphone_compatible and vcodec not in ("h264", "hevc")
    need_hvc1_tag = iphone_compatible and vcodec == "hevc" and vtag != "hvc1"
    need_audio_aac = acodec is not None and acodec not in ("aac", "mp3", "alac")

    if not (need_video_reencode or need_hvc1_tag or need_audio_aac):
        return filepath

    if is_cancelled():
        raise DownloadCancelled("İndirme kullanıcı tarafından iptal edildi.")

    temp_out = filepath.with_name(f"{filepath.stem}.compat_tmp.mp4")
    cmd = [ffmpeg, "-y", "-i", str(filepath)]

    if need_video_reencode:
        on_status("iPhone 15 Galeri uyumlu (H.264) formata dönüştürülüyor...")
        preset = "ultrafast" if CLOUD_MODE else "veryfast"
        extra_threads = ["-threads", "2"] if CLOUD_MODE else []
        cmd.extend(["-c:v", "libx264", "-preset", preset, "-crf", "21", "-pix_fmt", "yuv420p", *extra_threads])
    else:
        on_status("MP4 ses/etiket uyumluluğu optimize ediliyor...")
        cmd.extend(["-c:v", "copy"])
        if need_hvc1_tag:
            cmd.extend(["-tag:v", "hvc1"])

    if a_stream:
        if need_audio_aac:
            cmd.extend(["-c:a", "aac", "-b:a", "192k"])
        else:
            cmd.extend(["-c:a", "copy"])

    cmd.extend(["-movflags", "+faststart", str(temp_out)])

    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        creationflags=creationflags,
    )
    while proc.poll() is None:
        if is_cancelled():
            proc.kill()
            if temp_out.exists():
                temp_out.unlink(missing_ok=True)
            raise DownloadCancelled("İndirme kullanıcı tarafından iptal edildi.")
        time.sleep(0.25)

    if proc.returncode == 0 and temp_out.exists() and temp_out.stat().st_size > 0:
        filepath.unlink(missing_ok=True)
        temp_out.replace(filepath)
    else:
        temp_out.unlink(missing_ok=True)

    return filepath


class DownloadJob:
    def __init__(self, req: DownloadRequest) -> None:
        self.id: str = uuid.uuid4().hex[:12]
        self.req: DownloadRequest = req
        self.url: str = req.url
        self.title: str = req.title_hint or "Bağlantı hazırlanıyor..."
        self.thumbnail: str | None = req.thumbnail_hint
        self.platform: str = req.platform_hint or detect_platform(req.url)
        self.status: str = "queued"  # queued | downloading | processing | completed | error | cancelled
        self.status_text: str = "Sırada bekliyor..."
        self.progress: float = 0.0
        self.speed_text: str = ""
        self.eta_text: str = ""
        self.downloaded_bytes: int = 0
        self.total_bytes: int | None = None
        self.filename: str | None = None
        self.filesize: int | None = None
        self.quality_label: str = self._compute_quality_label()
        self.error: str | None = None
        self.created_at: float = time.time()
        self.completed_at: float | None = None
        self.cancel_requested: bool = False

    def _compute_quality_label(self) -> str:
        clip_suffix = ""
        if self.req.start_time or self.req.end_time:
            s = self.req.start_time or "00:00"
            e = self.req.end_time or "Son"
            clip_suffix = f" ✂️ {s}-{e}"
        if self.req.mode == "audio":
            return f"{self.req.audio_format.upper()} ({self.req.audio_bitrate}k){clip_suffix}"
        q = self.req.quality
        q_str = "En İyi MP4" if q == "best" else f"{q}p MP4"
        return f"{q_str}{clip_suffix}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "url": self.url,
            "title": self.title,
            "thumbnail": self.thumbnail,
            "platform": self.platform,
            "mode": self.req.mode,
            "quality_label": self.quality_label,
            "iphone_compatible": self.req.iphone_compatible,
            "status": self.status,
            "status_text": self.status_text,
            "progress": round(self.progress, 1),
            "speed_text": self.speed_text,
            "eta_text": self.eta_text,
            "downloaded_bytes": self.downloaded_bytes,
            "total_bytes": self.total_bytes,
            "filename": self.filename,
            "filesize": self.filesize,
            "error": self.error,
            "created_at": self.created_at,
            "completed_at": self.completed_at,
        }


def _format_bytes_speed(bps: float | None) -> str:
    if not bps or bps <= 0:
        return ""
    if bps >= 1024 * 1024:
        return f"{bps / (1024 * 1024):.1f} MB/sn"
    if bps >= 1024:
        return f"{bps / 1024:.0f} KB/sn"
    return f"{bps:.0f} B/sn"


def _format_eta(seconds: float | int | None) -> str:
    if seconds is None or seconds < 0:
        return ""
    sec = int(seconds)
    if sec >= 3600:
        return f"{sec // 3600}:{(sec % 3600) // 60:02d}:{sec % 60:02d}"
    return f"{sec // 60:02d}:{sec % 60:02d}"


class DownloadQueueManager:
    def __init__(self, max_workers: int = 2) -> None:
        self._lock = threading.RLock()
        self._jobs: dict[str, DownloadJob] = {}
        self._job_order: list[str] = []
        self._executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="dl-worker")
        self._version: int = 0

    def _bump(self) -> None:
        with self._lock:
            self._version += 1

    @property
    def version(self) -> int:
        return self._version

    def list_jobs(self) -> list[dict[str, Any]]:
        with self._lock:
            return [self._jobs[jid].to_dict() for jid in reversed(self._job_order) if jid in self._jobs]

    def enqueue(self, req: DownloadRequest) -> dict[str, Any]:
        clean_url = extract_clean_url(req.url)
        req.url = clean_url
        # Validate timestamps upfront so user gets immediate feedback
        start_sec = parse_timestamp_seconds(req.start_time)
        end_sec = parse_timestamp_seconds(req.end_time)
        if start_sec is not None and end_sec is not None and end_sec <= start_sec:
            raise ValueError("Bitiş zamanı, başlangıç zamanından büyük olmalıdır.")

        job = DownloadJob(req)
        with self._lock:
            self._jobs[job.id] = job
            self._job_order.append(job.id)
            if len(self._job_order) > 100:
                oldest = self._job_order.pop(0)
                if oldest in self._jobs and self._jobs[oldest].status in ("completed", "error", "cancelled"):
                    del self._jobs[oldest]
            self._version += 1

        self._executor.submit(self._run_job, job)
        return job.to_dict()

    def cancel_job(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return False
            job.cancel_requested = True
            if job.status == "queued":
                job.status = "cancelled"
                job.status_text = "İptal edildi"
            else:
                job.status_text = "İptal ediliyor..."
            self._version += 1
            return True

    def clear_finished_jobs(self) -> None:
        with self._lock:
            keep_ids = [
                jid
                for jid in self._job_order
                if jid in self._jobs and self._jobs[jid].status in ("queued", "downloading", "processing")
            ]
            self._jobs = {jid: self._jobs[jid] for jid in keep_ids}
            self._job_order = keep_ids
            self._version += 1

    def _run_job(self, job: DownloadJob) -> None:
        if job.cancel_requested:
            job.status = "cancelled"
            job.status_text = "İptal edildi"
            self._bump()
            return

        job.status = "downloading"
        job.status_text = "Medya bilgileri alınıyor..."
        self._bump()

        job_temp_dir = TEMP_DIR / job.id
        job_temp_dir.mkdir(parents=True, exist_ok=True)

        try:
            final_path = self._execute_ytdlp(job, job_temp_dir, use_cookies=True)
        except DownloadCancelled:
            job.status = "cancelled"
            job.status_text = "İptal edildi"
            self._bump()
            shutil.rmtree(job_temp_dir, ignore_errors=True)
            return
        except Exception as exc:
            if _is_cookie_lock_error(exc):
                try:
                    final_path = self._execute_ytdlp(job, job_temp_dir, use_cookies=False)
                except DownloadCancelled:
                    job.status = "cancelled"
                    job.status_text = "İptal edildi"
                    self._bump()
                    shutil.rmtree(job_temp_dir, ignore_errors=True)
                    return
                except Exception:
                    job.status = "error"
                    job.error = _friendly_error_message(exc)
                    job.status_text = "Hata oluştu"
                    self._bump()
                    shutil.rmtree(job_temp_dir, ignore_errors=True)
                    return
            else:
                fb = _try_social_api_fallback(job.url)
                if fb:
                    try:
                        job.url = fb["direct_url"]
                        if job.title == "Bağlantı hazırlanıyor..." and fb.get("title"):
                            job.title = fb["title"]
                        if not job.thumbnail and fb.get("thumbnail"):
                            job.thumbnail = fb["thumbnail"]
                        job.platform = fb["platform"]
                        final_path = self._execute_ytdlp(job, job_temp_dir, use_cookies=False)
                    except Exception:
                        job.status = "error"
                        job.error = _friendly_error_message(exc)
                        job.status_text = "Hata oluştu"
                        self._bump()
                        shutil.rmtree(job_temp_dir, ignore_errors=True)
                        return
                else:
                    job.status = "error"
                    job.error = _friendly_error_message(exc)
                    job.status_text = "Hata oluştu"
                    self._bump()
                    shutil.rmtree(job_temp_dir, ignore_errors=True)
                    return

        try:
            if job.req.mode == "video":
                def _on_status(txt: str) -> None:
                    job.status = "processing"
                    job.status_text = txt
                    self._bump()

                final_path = _ensure_compatible_mp4(
                    final_path,
                    iphone_compatible=job.req.iphone_compatible,
                    on_status=_on_status,
                    is_cancelled=lambda: job.cancel_requested,
                )

            # Move final file into DOWNLOADS_DIR with clean human-readable unique name
            ext = final_path.suffix or (f".{job.req.audio_format}" if job.req.mode == "audio" else ".mp4")
            base_title = sanitize_filename(job.title)
            suffix_parts: list[str] = []
            if job.req.mode == "video" and job.req.quality != "best":
                suffix_parts.append(f"{job.req.quality}p")
            if job.req.start_time or job.req.end_time:
                s_lbl = (job.req.start_time or "0").replace(":", ".")
                e_lbl = (job.req.end_time or "son").replace(":", ".")
                suffix_parts.append(f"kesit_{s_lbl}-{e_lbl}")
            suffix_str = f" [{', '.join(suffix_parts)}]" if suffix_parts else ""

            dest_name = f"{base_title}{suffix_str}{ext}"
            dest_path = DOWNLOADS_DIR / dest_name
            counter = 1
            while dest_path.exists():
                dest_name = f"{base_title}{suffix_str} ({counter}){ext}"
                dest_path = DOWNLOADS_DIR / dest_name
                counter += 1

            shutil.move(str(final_path), str(dest_path))

            fsize = dest_path.stat().st_size
            job.filename = dest_path.name
            job.filesize = fsize
            job.progress = 100.0
            job.status = "completed"
            job.status_text = "Tamamlandı"
            job.speed_text = ""
            job.eta_text = ""
            job.completed_at = time.time()
            self._bump()

            add_history_item(
                {
                    "id": job.id,
                    "url": job.url,
                    "title": job.title,
                    "thumbnail": job.thumbnail,
                    "platform": job.platform,
                    "mode": job.req.mode,
                    "quality_label": job.quality_label,
                    "filename": job.filename,
                    "filesize": job.filesize,
                    "completed_at": job.completed_at,
                }
            )
        except DownloadCancelled:
            job.status = "cancelled"
            job.status_text = "İptal edildi"
            self._bump()
        except Exception as exc:
            job.status = "error"
            job.error = _friendly_error_message(exc)
            job.status_text = "İşleme hatası"
            self._bump()
        finally:
            shutil.rmtree(job_temp_dir, ignore_errors=True)

    def _execute_ytdlp(self, job: DownloadJob, temp_dir: Path, use_cookies: bool) -> Path:
        opts = _base_ydl_opts(apply_cookies=use_cookies, target_url=job.url)
        if job.req.playlist_item:
            opts["noplaylist"] = False
            opts["playlist_items"] = str(job.req.playlist_item)
        else:
            opts["noplaylist"] = True
        opts["outtmpl"] = {"default": str(temp_dir / "output.%(ext)s")}

        req = job.req
        start_sec = parse_timestamp_seconds(req.start_time)
        end_sec = parse_timestamp_seconds(req.end_time)
        if start_sec is not None or end_sec is not None:
            s_val = start_sec if start_sec is not None else 0.0
            e_val = end_sec if end_sec is not None else float("inf")
            opts["download_ranges"] = download_range_func(None, [(s_val, e_val)])
            opts["force_keyframes_at_cuts"] = bool(req.force_keyframes)

        postprocessors: list[dict[str, Any]] = []

        if req.mode == "audio":
            opts["format"] = "bestaudio/best"
            postprocessors.append(
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": req.audio_format,
                    "preferredquality": req.audio_bitrate,
                }
            )
            if req.audio_format in ("mp3", "m4a", "opus"):
                opts["writethumbnail"] = True
                postprocessors.append({"key": "FFmpegMetadata", "add_metadata": True})
                postprocessors.append({"key": "EmbedThumbnail"})
        else:
            # Video mode — support both landscape and portrait (Reels/Shorts/TikTok) cleanly via format_sort
            opts["format"] = "bestvideo+bestaudio/best"
            opts["merge_output_format"] = "mp4"

            sort_rules: list[str] = []
            if CLOUD_MODE and req.iphone_compatible and req.quality == "best":
                sort_rules.append("vcodec:h264")
            if req.quality and req.quality != "best" and req.quality.isdigit():
                sort_rules.append(f"res:{req.quality}")
            if req.iphone_compatible:
                sort_rules.extend(["vcodec:h264", "acodec:m4a", "ext:mp4:m4a"])
            else:
                sort_rules.extend(["acodec:m4a", "ext:mp4:m4a"])
            opts["format_sort"] = sort_rules
            postprocessors.append({"key": "FFmpegMetadata", "add_metadata": True})

        opts["postprocessors"] = postprocessors

        last_emit = 0.0

        def _progress_hook(d: dict[str, Any]) -> None:
            nonlocal last_emit
            if job.cancel_requested:
                raise DownloadCancelled("İndirme kullanıcı tarafından iptal edildi.")

            st = d.get("status")
            info_dict = d.get("info_dict") or {}
            if info_dict.get("title") and job.title == "Bağlantı hazırlanıyor...":
                job.title = info_dict["title"]
            if not job.thumbnail:
                t = _pick_best_thumbnail(info_dict)
                if t:
                    job.thumbnail = t
            if info_dict.get("extractor_key"):
                job.platform = detect_platform(job.url, info_dict.get("extractor_key"))

            now = time.time()
            if st == "downloading":
                dl = d.get("downloaded_bytes") or 0
                tot = d.get("total_bytes") or d.get("total_bytes_estimate")
                job.downloaded_bytes = int(dl)
                job.total_bytes = int(tot) if tot else None
                if tot and tot > 0:
                    job.progress = min(99.0, (dl / tot) * 100.0)
                else:
                    frag_idx = d.get("fragment_index")
                    frag_cnt = d.get("fragment_count")
                    if frag_idx and frag_cnt:
                        job.progress = min(99.0, (frag_idx / frag_cnt) * 100.0)
                job.speed_text = _format_bytes_speed(d.get("speed"))
                job.eta_text = _format_eta(d.get("eta"))
                job.status = "downloading"
                job.status_text = (
                    "Kesit indiriliyor..."
                    if (start_sec is not None or end_sec is not None)
                    else "İndiriliyor..."
                )
                if now - last_emit >= 0.2:
                    last_emit = now
                    self._bump()
            elif st == "finished":
                job.progress = max(job.progress, 95.0)
                job.speed_text = ""
                job.eta_text = ""
                job.status = "processing"
                job.status_text = "Ses ve görüntü birleştiriliyor (FFmpeg)..."
                self._bump()

        def _postprocessor_hook(d: dict[str, Any]) -> None:
            if job.cancel_requested:
                raise DownloadCancelled("İndirme kullanıcı tarafından iptal edildi.")
            if d.get("status") == "started":
                pp = d.get("postprocessor") or ""
                job.status = "processing"
                if "ExtractAudio" in pp:
                    job.status_text = f"{req.audio_format.upper()} ses dosyasına dönüştürülüyor..."
                elif "Merger" in pp:
                    job.status_text = "Yüksek kaliteli ses ve video birleştiriliyor..."
                self._bump()

        opts["progress_hooks"] = [_progress_hook]
        opts["postprocessor_hooks"] = [_postprocessor_hook]

        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(job.url, download=True)
            if info:
                if info.get("title"):
                    job.title = info["title"]
                if not job.thumbnail:
                    job.thumbnail = _pick_best_thumbnail(info)
                job.platform = detect_platform(job.url, info.get("extractor_key") or info.get("extractor"))

        # Locate the produced media file in temp_dir (ignore leftover thumbnail files if any)
        ignore_exts = {".webp", ".jpg", ".jpeg", ".png", ".part", ".ytdl", ".json"}
        candidates = [
            p
            for p in temp_dir.iterdir()
            if p.is_file() and p.suffix.lower() not in ignore_exts
        ]
        if not candidates:
            raise RuntimeError("İndirilen medya dosyası oluşturulamadı.")
        candidates.sort(key=lambda p: p.stat().st_size, reverse=True)
        return candidates[0]


queue_manager = DownloadQueueManager(max_workers=1 if CLOUD_MODE else 2)
