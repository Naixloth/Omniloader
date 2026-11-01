from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field


class AnalyzeRequest(BaseModel):
    url: str
    include_playlist: bool = False


class FormatOption(BaseModel):
    id: str
    label: str
    resolution: int | None = None
    ext: str = "mp4"
    filesize_approx: int | None = None
    fps: float | None = None
    has_h264: bool = False
    badge: str | None = None


class PlaylistEntryItem(BaseModel):
    index: int
    id: str
    url: str
    use_playlist_index: bool = False
    title: str
    duration: float | None = None
    thumbnail: str | None = None
    uploader: str | None = None


class AnalyzeResponse(BaseModel):
    is_playlist: bool = False
    has_playlist_param: bool = False
    playlist_url: str | None = None
    id: str
    url: str
    webpage_url: str
    title: str
    uploader: str | None = None
    duration: float | None = None
    thumbnail: str | None = None
    platform: str
    view_count: int | None = None
    formats: list[FormatOption] = Field(default_factory=list)
    entries: list[PlaylistEntryItem] = Field(default_factory=list)


class DownloadRequest(BaseModel):
    url: str
    mode: Literal["video", "audio"] = "video"
    quality: str = "1080"  # "best", "2160", "1440", "1080", "720", "480", "360"
    audio_format: Literal["mp3", "m4a", "wav", "opus"] = "mp3"
    audio_bitrate: str = "320"
    iphone_compatible: bool = True
    start_time: str | None = None
    end_time: str | None = None
    force_keyframes: bool = False
    title_hint: str | None = None
    thumbnail_hint: str | None = None
    platform_hint: str | None = None
    playlist_item: int | None = None


class BatchDownloadRequest(BaseModel):
    items: list[DownloadRequest]


class RawUrlsBatchRequest(BaseModel):
    urls: list[str]
    mode: Literal["video", "audio"] = "video"
    quality: str = "1080"
    audio_format: Literal["mp3", "m4a", "wav", "opus"] = "mp3"
    audio_bitrate: str = "320"
    iphone_compatible: bool = True


class CookieSettingsUpdate(BaseModel):
    mode: Literal["none", "browser", "file"] = "none"
    browser: Literal["chrome", "edge", "firefox", "brave", "opera"] = "chrome"
    cookies_text: str | None = None


class AuthLoginRequest(BaseModel):
    password: str
