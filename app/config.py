from __future__ import annotations

import os
import shutil
import socket
import ssl
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
BIN_DIR = BASE_DIR / "bin"
DOWNLOADS_DIR = BASE_DIR / "downloads"
DATA_DIR = BASE_DIR / "data"
STATIC_DIR = BASE_DIR / "static"
TEMP_DIR = DATA_DIR / "temp"

COOKIES_FILE = DATA_DIR / "cookies.txt"
SETTINGS_FILE = DATA_DIR / "settings.json"
HISTORY_FILE = DATA_DIR / "history.json"
SYSTEM_CA_BUNDLE = DATA_DIR / "system_ca_bundle.pem"

DEFAULT_PORT = int(os.environ.get("PORT", "8000"))
CLOUD_MODE = (
    os.environ.get("CLOUD_MODE", "0").strip().lower() in ("1", "true", "yes")
    or bool(os.environ.get("SPACE_ID"))
    or bool(os.environ.get("RENDER"))
    or bool(os.environ.get("RAILWAY_ENVIRONMENT"))
)
APP_PASSWORD = os.environ.get("APP_PASSWORD", "").strip()
MAX_FILE_AGE_HOURS = float(os.environ.get("MAX_FILE_AGE_HOURS", "2" if CLOUD_MODE else "0"))
MAX_STORAGE_MB = int(os.environ.get("MAX_STORAGE_MB", "1024" if CLOUD_MODE else "0"))

for _dir in (BIN_DIR, DOWNLOADS_DIR, DATA_DIR, STATIC_DIR, TEMP_DIR):
    _dir.mkdir(parents=True, exist_ok=True)

# Prepend local bin/ to PATH so yt-dlp FFmpegFD (partial clip downloader) & subprocesses find ffmpeg/ffprobe
if str(BIN_DIR) not in os.environ.get("PATH", ""):
    os.environ["PATH"] = str(BIN_DIR) + os.pathsep + os.environ.get("PATH", "")


def configure_system_tls() -> None:
    """Integrate Windows OS Root Certificate Store with Python SSL, curl_cffi, and httpx."""
    try:
        import truststore

        truststore.inject_into_ssl()
    except Exception:
        pass

    if os.name == "nt":
        try:
            import certifi

            pem_blocks: list[str] = [Path(certifi.where()).read_text(encoding="utf-8")]
            seen: set[bytes] = set()
            for store_name in ("ROOT", "CA"):
                for cert_bytes, encoding_type, _trust in ssl.enum_certificates(store_name):
                    if encoding_type == "x509_asn" and cert_bytes not in seen:
                        seen.add(cert_bytes)
                        pem_blocks.append(ssl.DER_cert_to_PEM_cert(cert_bytes))
            SYSTEM_CA_BUNDLE.write_text("\n".join(pem_blocks), encoding="utf-8")
            bundle_str = str(SYSTEM_CA_BUNDLE)
            os.environ["SSL_CERT_FILE"] = bundle_str
            os.environ["REQUESTS_CA_BUNDLE"] = bundle_str
            os.environ["CURL_CA_BUNDLE"] = bundle_str
            os.environ["NODE_EXTRA_CA_CERTS"] = bundle_str
        except Exception:
            pass


configure_system_tls()


def get_ffmpeg_location() -> str | None:
    """Return directory or path containing ffmpeg & ffprobe."""
    local_ffmpeg = BIN_DIR / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    if local_ffmpeg.exists():
        return str(BIN_DIR)
    sys_ffmpeg = shutil.which("ffmpeg")
    if sys_ffmpeg:
        return str(Path(sys_ffmpeg).parent)
    return None


def get_ffprobe_binary() -> str | None:
    local_ffprobe = BIN_DIR / ("ffprobe.exe" if os.name == "nt" else "ffprobe")
    if local_ffprobe.exists():
        return str(local_ffprobe)
    return shutil.which("ffprobe")


def get_ffmpeg_binary() -> str | None:
    local_ffmpeg = BIN_DIR / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    if local_ffmpeg.exists():
        return str(local_ffmpeg)
    return shutil.which("ffmpeg")


def get_cloudflared_binary() -> str | None:
    local_cf = BIN_DIR / ("cloudflared.exe" if os.name == "nt" else "cloudflared")
    if local_cf.exists():
        return str(local_cf)
    return shutil.which("cloudflared")


def get_local_lan_ips() -> list[str]:
    """Detect real LAN IPv4 addresses (prioritizing active Wi-Fi/Ethernet route)."""
    ips: list[str] = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(0.5)
            s.connect(("8.8.8.8", 80))
            primary = s.getsockname()[0]
            if primary and not primary.startswith("127."):
                ips.append(primary)
    except Exception:
        pass

    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if (
                ip
                and not ip.startswith("127.")
                and not ip.startswith("169.254.")
                and ip not in ips
            ):
                # Deprioritize common Hyper-V / WSL virtual subnets (172.16-31.x) if 192.168 / 10.x exists
                ips.append(ip)
    except Exception:
        pass

    return ips or ["127.0.0.1"]
