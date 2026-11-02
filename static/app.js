(() => {
  "use strict";

  const ICONS = {
    share: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" x2="12" y1="2" y2="15"/></svg>`,
    download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>`,
    play: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>`,
    folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>`,
    trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`,
    close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
  };

  const state = {
    system: null,
    isIOS:
      /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
    isStandalone:
      Boolean(window.navigator.standalone) ||
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches),
    analyzed: null,
    dlMode: "video",
    selectedQuality: "1080",
    selectedAudioFormat: "mp3",
    selectedAudioBitrate: "320",
    jobs: [],
    completedIdsSeen: new Set(),
    history: [],
    shareFileCache: new Map(),
  };

  const $ = (id) => document.getElementById(id);

  function escHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function thumbSrc(rawUrl) {
    if (!rawUrl || !String(rawUrl).startsWith("http")) {
      return "/logo-128.png?v=4";
    }
    return `/api/thumbnail?url=${encodeURIComponent(rawUrl)}`;
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return "";
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
  }

  function formatDuration(sec) {
    if (sec === null || sec === undefined || isNaN(sec)) return "";
    const s = Math.floor(Number(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
    }
    return `${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
  }

  function toast(msg, type = "info") {
    const box = $("toastContainer");
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transition = "opacity 0.25s ease";
      setTimeout(() => el.remove(), 260);
    }, 3400);
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers:
        options.body && !(options.body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : undefined,
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.startsWith("/api/auth/")) {
      $("authModal").classList.remove("hidden");
    }
    if (!res.ok) {
      throw new Error(data.detail || `İstek başarısız (${res.status})`);
    }
    return data;
  }

  async function loadSystemInfo() {
    try {
      const sys = await api("/api/system");
      state.system = sys;
      $("btnOpenDownloadsDir").classList.toggle("hidden", !sys.is_local_pc);
      $("btnLogout").classList.toggle("hidden", !sys.auth_enabled);
      $("cookieBrowserRadioCard").classList.toggle("hidden", Boolean(sys.cloud_mode));
      updateCookieUI(sys.settings);
    } catch (err) {
      console.error("Sistem bilgisi alınamadı:", err);
    }
  }

  function updateCookieUI(settings) {
    if (!settings) return;
    const dot = $("cookieStatusDot");
    const active = settings.cookie_mode && settings.cookie_mode !== "none";
    dot.classList.toggle("active", Boolean(active));

    document.querySelectorAll('input[name="cookieMode"]').forEach((r) => {
      r.checked = r.value === (settings.cookie_mode || "none");
    });

    if (settings.cookie_browser) {
      $("cookieBrowserSelect").value = settings.cookie_browser;
    }

    const badge = $("cookieFileBadge");
    if (settings.has_cookie_file) {
      badge.textContent = "cookies.txt tanımlı ve aktif";
      badge.style.color = "#4ade80";
      $("btnCopyCookieB64").classList.toggle(
        "hidden",
        !Boolean(state.system && state.system.cloud_mode)
      );
    } else {
      badge.textContent = "Yüklü çerez dosyası yok";
      badge.style.color = "rgba(255,255,255,0.5)";
      $("btnCopyCookieB64").classList.add("hidden");
    }
    syncCookieSections();
  }

  function syncCookieSections() {
    const selected =
      document.querySelector('input[name="cookieMode"]:checked')?.value || "none";
    $("cookieFileSection").classList.toggle("hidden", selected !== "file");
    $("cookieBrowserSection").classList.toggle("hidden", selected !== "browser");
  }

  function initTabs() {
    document.querySelectorAll(".mode-tab[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document
          .querySelectorAll(".mode-tab[data-tab]")
          .forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const tab = btn.dataset.tab;
        $("tabSingle").classList.toggle("hidden", tab !== "single");
        $("tabBatch").classList.toggle("hidden", tab !== "batch");
      });
    });

    const urlInput = $("urlInput");
    const clearBtn = $("btnClearUrl");
    urlInput.addEventListener("input", () => {
      clearBtn.classList.toggle("hidden", !urlInput.value.trim());
    });
    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        runAnalyze(false);
      }
    });
    urlInput.addEventListener("paste", () => {
      setTimeout(() => {
        clearBtn.classList.toggle("hidden", !urlInput.value.trim());
      }, 50);
    });

    clearBtn.addEventListener("click", () => {
      urlInput.value = "";
      clearBtn.classList.add("hidden");
      $("previewCard").classList.add("hidden");
      $("playlistCard").classList.add("hidden");
      $("playlistHintBanner").classList.add("hidden");
      urlInput.focus();
    });

    $("btnPaste").addEventListener("click", async () => {
      let pastedText = "";
      let readExecuted = false;

      // On iOS Safari, copied links from Instagram/YouTube/Safari are often stored as
      // 'text/uri-list' or 'text/html' rather than 'text/plain', making readText() return empty!
      if (navigator.clipboard && navigator.clipboard.read) {
        try {
          const items = await navigator.clipboard.read();
          readExecuted = true;
          for (const item of items) {
            const preferred = ["text/plain", "text/uri-list", "text/html"];
            const types = [
              ...preferred.filter((t) => item.types.includes(t)),
              ...item.types.filter((t) => !preferred.includes(t) && t.startsWith("text/")),
            ];
            for (const mime of types) {
              try {
                const blob = await item.getType(mime);
                const raw = (await blob.text()).trim();
                if (!raw) continue;
                const urlMatch = raw.match(/https?:\/\/[^\s<>"']+/i);
                if (urlMatch) {
                  pastedText = urlMatch[0].replace(/[.,;)]+$/, "");
                  break;
                }
                if (mime !== "text/html") {
                  pastedText = raw;
                  break;
                }
              } catch {
                // try next MIME representation
              }
            }
            if (pastedText) break;
          }
        } catch {
          readExecuted = false;
        }
      }

      if (!pastedText && !readExecuted && navigator.clipboard && navigator.clipboard.readText) {
        try {
          const txt = (await navigator.clipboard.readText()).trim();
          if (txt) {
            const urlMatch = txt.match(/https?:\/\/[^\s<>"']+/i);
            pastedText = urlMatch ? urlMatch[0].replace(/[.,;)]+$/, "") : txt;
          }
        } catch {
          // fall through to manual input focus
        }
      }

      if (pastedText) {
        urlInput.value = pastedText;
        clearBtn.classList.remove("hidden");
        runAnalyze(false);
      } else {
        urlInput.focus();
        toast("Kutucuğa basılı tutup Yapıştır seçebilirsiniz.");
      }
    });

    $("btnAnalyze").addEventListener("click", () => runAnalyze(false));
    $("btnLoadFullPlaylist").addEventListener("click", () => {
      if (state.analyzed && state.analyzed.playlist_url) {
        $("urlInput").value = state.analyzed.playlist_url;
      }
      runAnalyze(true);
    });

    document.querySelectorAll(".seg-btn[data-dlmode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document
          .querySelectorAll(".seg-btn[data-dlmode]")
          .forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.dlMode = btn.dataset.dlmode;
        $("videoOptionsBox").classList.toggle("hidden", state.dlMode !== "video");
        $("audioOptionsBox").classList.toggle("hidden", state.dlMode !== "audio");
      });
    });

    document.querySelectorAll("#audioOptionsBox .q-card").forEach((card) => {
      card.addEventListener("click", () => {
        document
          .querySelectorAll("#audioOptionsBox .q-card")
          .forEach((c) => c.classList.remove("active"));
        card.classList.add("active");
        state.selectedAudioFormat = card.dataset.afmt;
        state.selectedAudioBitrate = card.dataset.abr;
      });
    });

    $("btnToggleTrim").addEventListener("click", () => {
      const body = $("trimBody");
      const hidden = body.classList.toggle("hidden");
      $("trimChevron").classList.toggle("open", !hidden);
    });

    $("btnResetTrim").addEventListener("click", () => {
      $("trimStart").value = "";
      $("trimEnd").value = "";
      $("chkForceKeyframes").checked = false;
    });

    $("batchModeSelect").addEventListener("change", (e) => {
      const isVid = e.target.value === "video";
      $("batchVideoQualityWrap").classList.toggle("hidden", !isVid);
      $("batchAudioFormatWrap").classList.toggle("hidden", isVid);
      document.querySelector(".batch-compat").classList.toggle("hidden", !isVid);
    });

    $("plModeSelect").addEventListener("change", (e) => {
      const isVid = e.target.value === "video";
      $("plVideoQualityWrap").classList.toggle("hidden", !isVid);
      $("plAudioFormatWrap").classList.toggle("hidden", isVid);
    });
  }

  async function runAnalyze(includePlaylist = false) {
    const raw = $("urlInput").value.trim();
    if (!raw) {
      toast("Lütfen bir bağlantı girin.", "error");
      $("urlInput").focus();
      return;
    }

    $("btnAnalyze").disabled = true;
    $("analyzeBtnText").textContent = "Bekleyin...";
    $("analyzeLoading").classList.remove("hidden");
    $("previewCard").classList.add("hidden");
    $("playlistCard").classList.add("hidden");
    $("playlistHintBanner").classList.add("hidden");

    try {
      const data = await api("/api/analyze", {
        method: "POST",
        body: JSON.stringify({ url: raw, include_playlist: includePlaylist }),
      });
      state.analyzed = data;

      if (data.is_playlist) {
        renderPlaylistCard(data);
      } else {
        renderSinglePreview(data);
      }
    } catch (err) {
      toast(err.message || "Analiz başarısız.", "error");
    } finally {
      $("btnAnalyze").disabled = false;
      $("analyzeBtnText").textContent = "Analiz Et";
      $("analyzeLoading").classList.add("hidden");
    }
  }

  function renderSinglePreview(data) {
    $("previewThumb").src = thumbSrc(data.thumbnail);
    $("previewThumb").onerror = () => {
      $("previewThumb").onerror = null;
      $("previewThumb").src = "/logo-128.png?v=4";
    };

    const durEl = $("previewDuration");
    const durTxt = formatDuration(data.duration);
    if (durTxt) {
      durEl.textContent = durTxt;
      durEl.classList.remove("hidden");
    } else {
      durEl.classList.add("hidden");
    }

    $("previewPlatform").textContent = data.platform || "Medya";
    $("previewTitle").textContent = data.title || "Medya";
    $("previewUploader").textContent = data.uploader || "";
    $("previewSourceLink").href = data.webpage_url || data.url;

    $("trimStart").value = "";
    $("trimEnd").value = "";
    $("trimEnd").placeholder = durTxt || "01:30";

    if (data.has_playlist_param && data.playlist_url) {
      $("playlistHintBanner").classList.remove("hidden");
    }

    const grid = $("qualityGrid");
    grid.innerHTML = "";
    const formats =
      data.formats && data.formats.length
        ? data.formats
        : [{ id: "best", label: "En Yüksek (MP4)" }];

    const has1080 = formats.some((f) => f.id === "1080");
    state.selectedQuality = has1080 ? "1080" : formats[0].id;

    formats.forEach((f) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `q-card ${f.id === state.selectedQuality ? "active" : ""}`;
      const sizeStr = formatBytes(f.filesize_approx);
      const fpsStr = f.fps && f.fps > 30 ? ` • ${Math.round(f.fps)}fps` : "";
      const subParts = [sizeStr ? `~${sizeStr}` : "MP4", fpsStr].join("");
      btn.innerHTML = `
        ${f.badge ? `<span class="q-badge">${escHtml(f.badge)}</span>` : ""}
        <strong>${escHtml(f.label)}</strong>
        <small>${escHtml(subParts)}</small>
      `;
      btn.addEventListener("click", () => {
        grid.querySelectorAll(".q-card").forEach((c) => c.classList.remove("active"));
        btn.classList.add("active");
        state.selectedQuality = f.id;
      });
      grid.appendChild(btn);
    });

    $("previewCard").classList.remove("hidden");
  }

  function renderPlaylistCard(data) {
    $("playlistPlatformBadge").textContent = `${data.platform} • ${data.entries.length}`;
    $("playlistTitle").textContent = data.title || "Oynatma Listesi";
    $("playlistSubtitle").textContent = data.uploader || "";

    const listEl = $("playlistEntriesList");
    listEl.innerHTML = "";

    data.entries.forEach((entry, idx) => {
      const row = document.createElement("label");
      row.className = "pl-item";
      const dur = formatDuration(entry.duration);
      const metaParts = [dur, entry.uploader].filter(Boolean).join(" • ");
      row.innerHTML = `
        <input type="checkbox" class="pl-chk" data-idx="${idx}" checked />
        <img class="pl-thumb" src="${thumbSrc(entry.thumbnail)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='/logo-128.png?v=4'" />
        <div class="pl-info">
          <div class="pl-title">${escHtml(entry.index)}. ${escHtml(entry.title)}</div>
          <div class="pl-meta">${escHtml(metaParts)}</div>
        </div>
      `;
      row.querySelector(".pl-chk").addEventListener("change", updatePlaylistSelectedCount);
      listEl.appendChild(row);
    });

    updatePlaylistSelectedCount();
    $("playlistCard").classList.remove("hidden");
  }

  function updatePlaylistSelectedCount() {
    const count = document.querySelectorAll("#playlistEntriesList .pl-chk:checked").length;
    $("plSelectedCount").textContent = String(count);
  }

  function initDownloadActions() {
    $("btnDownloadNow").addEventListener("click", async () => {
      if (!state.analyzed) return;
      const btn = $("btnDownloadNow");
      btn.disabled = true;
      try {
        const payload = {
          url: state.analyzed.url,
          mode: state.dlMode,
          quality: state.selectedQuality,
          audio_format: state.selectedAudioFormat,
          audio_bitrate: state.selectedAudioBitrate,
          iphone_compatible: $("chkIphoneCompat").checked,
          start_time: $("trimStart").value.trim() || null,
          end_time: $("trimEnd").value.trim() || null,
          force_keyframes: $("chkForceKeyframes").checked,
          title_hint: state.analyzed.title,
          thumbnail_hint: state.analyzed.thumbnail,
          platform_hint: state.analyzed.platform,
        };
        await api("/api/download", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        toast("Sıraya eklendi", "success");
        await refreshJobs();
      } catch (err) {
        toast(err.message, "error");
      } finally {
        btn.disabled = false;
      }
    });

    $("btnSelectAllPl").addEventListener("click", () => {
      document.querySelectorAll("#playlistEntriesList .pl-chk").forEach((c) => {
        c.checked = true;
      });
      updatePlaylistSelectedCount();
    });

    $("btnDeselectAllPl").addEventListener("click", () => {
      document.querySelectorAll("#playlistEntriesList .pl-chk").forEach((c) => {
        c.checked = false;
      });
      updatePlaylistSelectedCount();
    });

    $("btnDownloadPlaylist").addEventListener("click", async () => {
      if (!state.analyzed || !state.analyzed.entries) return;
      const checked = Array.from(
        document.querySelectorAll("#playlistEntriesList .pl-chk:checked")
      );
      if (!checked.length) {
        toast("En az bir öğe seçin.", "error");
        return;
      }

      const mode = $("plModeSelect").value;
      const quality = $("plQualitySelect").value;
      const audioFmt = $("plAudioSelect").value;

      const items = checked.map((chk) => {
        const entry = state.analyzed.entries[Number(chk.dataset.idx)];
        return {
          url: entry.url,
          mode,
          quality,
          audio_format: audioFmt,
          audio_bitrate: "320",
          iphone_compatible: true,
          title_hint: entry.title,
          thumbnail_hint: entry.thumbnail || state.analyzed.thumbnail,
          platform_hint: state.analyzed.platform,
          playlist_item: entry.use_playlist_index ? entry.index : null,
        };
      });

      $("btnDownloadPlaylist").disabled = true;
      try {
        const res = await api("/api/download/batch", {
          method: "POST",
          body: JSON.stringify({ items }),
        });
        toast(`${res.jobs.length} öğe sıraya eklendi`, "success");
        await refreshJobs();
      } catch (err) {
        toast(err.message, "error");
      } finally {
        $("btnDownloadPlaylist").disabled = false;
      }
    });

    $("btnStartBatchUrls").addEventListener("click", async () => {
      const lines = $("batchUrlsInput")
        .value.split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (!lines.length) {
        toast("En az bir bağlantı girin.", "error");
        return;
      }
      const mode = $("batchModeSelect").value;
      const btn = $("btnStartBatchUrls");
      btn.disabled = true;
      try {
        const res = await api("/api/download/urls", {
          method: "POST",
          body: JSON.stringify({
            urls: lines,
            mode,
            quality: $("batchQualitySelect").value,
            audio_format: $("batchAudioSelect").value,
            audio_bitrate: "320",
            iphone_compatible: $("batchIphoneCompat").checked,
          }),
        });
        toast(`${res.jobs.length} bağlantı sıraya eklendi`, "success");
        $("batchUrlsInput").value = "";
        await refreshJobs();
      } catch (err) {
        toast(err.message, "error");
      } finally {
        btn.disabled = false;
      }
    });
  }

  async function shareOrSaveToIphonePhotos(filename, btnEl) {
    if (!filename) return;
    const downloadUrl = `/api/files/${encodeURIComponent(filename)}?download=1`;

    if (state.shareFileCache.has(filename)) {
      const cachedFile = state.shareFileCache.get(filename);
      try {
        await navigator.share({ files: [cachedFile], title: filename });
      } catch (err) {
        if (err.name !== "AbortError" && !state.isStandalone) {
          window.location.href = downloadUrl;
        }
      }
      return;
    }

    if (!navigator.canShare) {
      if (state.isStandalone) {
        openMediaPlayer(filename, filename);
      } else {
        window.location.href = downloadUrl;
      }
      return;
    }

    const origHtml = btnEl.innerHTML;
    btnEl.disabled = true;
    btnEl.innerHTML = `<span>Hazırlanıyor...</span>`;

    try {
      const resp = await fetch(downloadUrl);
      if (!resp.ok) throw new Error("Dosya alınamadı");

      const contentType = resp.headers.get("content-type") || "video/mp4";
      const totalLen = Number(resp.headers.get("content-length") || 0);
      let blob;

      if (resp.body && totalLen > 0) {
        const reader = resp.body.getReader();
        const chunks = [];
        let received = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.byteLength;
          const pct = Math.min(99, Math.round((received / totalLen) * 100));
          btnEl.innerHTML = `<span>%${pct}</span>`;
        }
        blob = new Blob(chunks, { type: contentType });
      } else {
        blob = await resp.blob();
      }

      const file = new File([blob], filename, { type: blob.type || "video/mp4" });

      if (!navigator.canShare({ files: [file] })) {
        btnEl.innerHTML = origHtml;
        if (state.isStandalone) {
          openMediaPlayer(filename, filename);
        } else {
          window.location.href = downloadUrl;
        }
        return;
      }

      state.shareFileCache.set(filename, file);
      await navigator.share({ files: [file], title: filename });
      btnEl.innerHTML = origHtml;
    } catch (err) {
      if (err.name === "AbortError") {
        btnEl.innerHTML = origHtml;
      } else if (state.shareFileCache.has(filename)) {
        // iOS transient user-activation timed out during download — 1 tap opens Share Sheet instantly
        btnEl.innerHTML = `${ICONS.download}<span>Kaydet (Hazır)</span>`;
        toast("Dosya hazır — kaydetmek için tekrar dokunun", "success");
      } else {
        btnEl.innerHTML = origHtml;
        if (!state.isStandalone) {
          window.location.href = downloadUrl;
        } else {
          toast("Dosya alınamadı, lütfen tekrar deneyin.", "error");
        }
      }
    } finally {
      btnEl.disabled = false;
    }
  }

  function openMediaPlayer(filename, title) {
    const streamUrl = `/api/files/${encodeURIComponent(filename)}?download=0`;
    const isAudio = /\.(mp3|m4a|wav|opus|ogg)$/i.test(filename);
    const vid = $("mediaPlayerVideo");
    const aud = $("mediaPlayerAudio");

    $("playerModalTitle").textContent = title || filename;
    vid.pause();
    aud.pause();

    if (isAudio) {
      vid.classList.add("hidden");
      vid.removeAttribute("src");
      aud.src = streamUrl;
      aud.classList.remove("hidden");
      aud.play().catch(() => {});
    } else {
      aud.classList.add("hidden");
      aud.removeAttribute("src");
      vid.src = streamUrl;
      vid.classList.remove("hidden");
      vid.play().catch(() => {});
    }
    $("playerModal").classList.remove("hidden");
  }

  function closeMediaPlayer() {
    const vid = $("mediaPlayerVideo");
    const aud = $("mediaPlayerAudio");
    vid.pause();
    aud.pause();
    vid.removeAttribute("src");
    aud.removeAttribute("src");
    $("playerModal").classList.add("hidden");
  }

  function buildFileActionButtons(item) {
    if (!item.filename) return "";
    const fnEnc = encodeURIComponent(item.filename);
    const dlHref = `/api/files/${fnEnc}?download=1`;
    const isLocalPc = Boolean(state.system && state.system.is_local_pc);
    const canShareFiles = Boolean(navigator.canShare);

    const btns = [];
    if (state.isIOS && state.isStandalone) {
      // In iOS Home Screen Standalone mode, <a download> traps the WebView on a black screen with no Back button.
      // Use native iOS Share/Save Sheet overlay ("Videoyu Kaydet" / "Dosyalara Kaydet") so user stays inside Omniloader!
      btns.push(
        `<button type="button" class="act-btn primary js-ios-share" data-fn="${escHtml(item.filename)}">${ICONS.download}<span>İndir / Kaydet</span></button>`
      );
    } else {
      if (state.isIOS || (canShareFiles && !isLocalPc)) {
        btns.push(
          `<button type="button" class="act-btn primary js-ios-share" data-fn="${escHtml(item.filename)}">${ICONS.share}<span>Kaydet / Paylaş</span></button>`
        );
      }
      btns.push(
        `<a class="act-btn ${!state.isIOS && !isLocalPc ? "primary" : ""}" href="${dlHref}" download>${ICONS.download}<span>İndir</span></a>`
      );
    }
    if (isLocalPc) {
      btns.push(
        `<button type="button" class="act-btn primary js-open-file" data-fn="${escHtml(item.filename)}">${ICONS.folder}<span>Klasör</span></button>`
      );
    }
    btns.push(
      `<button type="button" class="act-btn js-play-file" data-fn="${escHtml(item.filename)}" data-title="${escHtml(item.title)}">${ICONS.play}<span>Oynat</span></button>`
    );
    return btns.join("");
  }

  function bindActionButtons(container) {
    container.querySelectorAll(".js-ios-share").forEach((btn) => {
      btn.addEventListener("click", () => shareOrSaveToIphonePhotos(btn.dataset.fn, btn));
    });
    container.querySelectorAll(".js-open-file").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await api(`/api/open-folder?filename=${encodeURIComponent(btn.dataset.fn)}`, {
            method: "POST",
          });
        } catch (err) {
          toast(err.message, "error");
        }
      });
    });
    container.querySelectorAll(".js-play-file").forEach((btn) => {
      btn.addEventListener("click", () => openMediaPlayer(btn.dataset.fn, btn.dataset.title));
    });
    container.querySelectorAll(".js-cancel-job").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await api(`/api/jobs/${encodeURIComponent(btn.dataset.id)}/cancel`, {
            method: "POST",
          });
        } catch (err) {
          toast(err.message, "error");
        }
      });
    });
    container.querySelectorAll(".js-del-hist").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await api(`/api/history/${encodeURIComponent(btn.dataset.id)}?delete_file=false`, {
            method: "DELETE",
          });
          await loadHistory();
        } catch (err) {
          toast(err.message, "error");
        }
      });
    });
  }

  function renderJobs(jobs) {
    state.jobs = jobs || [];
    const activeCount = state.jobs.filter(
      (j) =>
        j.status === "queued" ||
        j.status === "downloading" ||
        j.status === "processing"
    ).length;
    $("activeCountBadge").textContent = String(activeCount);

    let newlyCompleted = false;
    state.jobs.forEach((j) => {
      if (j.status === "completed" && !state.completedIdsSeen.has(j.id)) {
        state.completedIdsSeen.add(j.id);
        newlyCompleted = true;
      }
    });
    if (newlyCompleted) {
      loadHistory();
    }

    const box = $("queueList");
    if (!state.jobs.length) {
      box.innerHTML = `<div class="empty-state"><p>Aktif indirme bulunmuyor</p></div>`;
      return;
    }

    box.innerHTML = state.jobs
      .map((j) => {
        const isDone = j.status === "completed";
        const isErr = j.status === "error" || j.status === "cancelled";
        const isRunning = !isDone && !isErr;
        const pct = isDone ? 100 : Math.max(0, Math.min(100, j.progress || 0));
        const speedEta = [
          j.speed_text,
          j.eta_text,
          j.filesize ? formatBytes(j.filesize) : formatBytes(j.total_bytes),
        ]
          .filter(Boolean)
          .join(" • ");

        return `
          <div class="job-item">
            <div class="job-top">
              <img class="job-thumb" src="${thumbSrc(j.thumbnail)}" alt="" onerror="this.onerror=null;this.src='/logo-128.png?v=4'" />
              <div class="job-info">
                <div class="job-title" title="${escHtml(j.title)}">${escHtml(j.title)}</div>
                <div class="job-sub">${escHtml(j.platform)} • ${escHtml(j.quality_label)}</div>
              </div>
            </div>

            <div class="progress-track">
              <div class="progress-fill ${isErr ? "err" : ""}" style="width:${pct}%"></div>
            </div>

            <div class="job-stats">
              <span>${escHtml(j.status_text)} (${pct.toFixed(0)}%)</span>
              <span>${escHtml(speedEta)}</span>
            </div>

            ${j.error ? `<div class="job-error">${escHtml(j.error)}</div>` : ""}

            <div class="job-actions">
              ${isRunning ? `<button type="button" class="act-btn danger js-cancel-job" data-id="${escHtml(j.id)}">${ICONS.close}<span>İptal</span></button>` : ""}
              ${isDone ? buildFileActionButtons(j) : ""}
            </div>
          </div>
        `;
      })
      .join("");

    bindActionButtons(box);
  }

  async function refreshJobs() {
    try {
      const data = await api("/api/jobs");
      renderJobs(data.jobs);
    } catch {
      // ignore transient error
    }
  }

  async function loadHistory() {
    try {
      const data = await api("/api/history");
      state.history = data.items || [];
      $("historyCountBadge").textContent = String(state.history.length);

      const box = $("historyList");
      if (!state.history.length) {
        box.innerHTML = `<div class="empty-state"><p>Henüz indirilen medya yok</p></div>`;
        return;
      }

      box.innerHTML = state.history
        .map((item) => {
          const sizeTxt = formatBytes(item.filesize);
          const sub = [item.platform, item.quality_label, sizeTxt]
            .filter(Boolean)
            .join(" • ");
          return `
            <div class="job-item">
              <div class="job-top">
                <img class="job-thumb" src="${thumbSrc(item.thumbnail)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='/logo-128.png?v=4'" />
                <div class="job-info">
                  <div class="job-title" title="${escHtml(item.title)}">${escHtml(item.title)}</div>
                  <div class="job-sub">${escHtml(sub)}</div>
                </div>
              </div>
              <div class="job-actions">
                ${item.file_exists ? buildFileActionButtons(item) : `<span class="helper-text" style="margin:0;flex:1">Dosya süresi doldu</span>`}
                <button type="button" class="act-btn icon-only danger js-del-hist" data-id="${escHtml(item.id)}" aria-label="Sil" title="Kaldır">${ICONS.trash}</button>
              </div>
            </div>
          `;
        })
        .join("");

      bindActionButtons(box);
    } catch (err) {
      console.error("Geçmiş yüklenemedi:", err);
    }
  }

  function connectSSE() {
    try {
      const es = new EventSource("/api/events");
      es.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(ev.data);
          if (parsed.jobs) renderJobs(parsed.jobs);
        } catch {
          // ignore
        }
      };
      es.onerror = () => {
        es.close();
        setTimeout(connectSSE, 3500);
      };
    } catch {
      setInterval(refreshJobs, 2000);
    }
  }

  function initModals() {
    $("btnCookies").addEventListener("click", async () => {
      await loadSystemInfo();
      $("cookieModal").classList.remove("hidden");
    });

    $("btnClosePlayer").addEventListener("click", closeMediaPlayer);

    document.querySelectorAll("[data-close]").forEach((btn) => {
      btn.addEventListener("click", () => {
        $(btn.dataset.close).classList.add("hidden");
      });
    });

    document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
      backdrop.addEventListener("click", (e) => {
        if (backdrop.id === "authModal") return;
        if (e.target === backdrop) {
          if (backdrop.id === "playerModal") closeMediaPlayer();
          else backdrop.classList.add("hidden");
        }
      });
    });

    $("btnLogout").addEventListener("click", async () => {
      await api("/api/auth/logout", { method: "POST" });
      $("authModal").classList.remove("hidden");
      $("authPasswordInput").value = "";
      $("authPasswordInput").focus();
    });

    $("authForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const pw = $("authPasswordInput").value.trim();
      if (!pw) return;
      $("btnAuthSubmit").disabled = true;
      try {
        await api("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ password: pw }),
        });
        $("authModal").classList.add("hidden");
        toast("Giriş yapıldı", "success");
        await bootAuthenticated();
      } catch (err) {
        toast(err.message || "Hatalı şifre", "error");
      } finally {
        $("btnAuthSubmit").disabled = false;
      }
    });

    document.querySelectorAll('input[name="cookieMode"]').forEach((r) => {
      r.addEventListener("change", syncCookieSections);
    });

    $("cookieFileInput").addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append("file", file);
      try {
        const updated = await api("/api/cookies/upload", { method: "POST", body: fd });
        updateCookieUI(updated);
        toast("cookies.txt yüklendi", "success");
      } catch (err) {
        toast(err.message, "error");
      }
    });

    $("btnDeleteCookieFile").addEventListener("click", async () => {
      try {
        const updated = await api("/api/cookies/file", { method: "DELETE" });
        $("cookieTextArea").value = "";
        updateCookieUI(updated);
        toast("Çerez dosyası silindi");
      } catch (err) {
        toast(err.message, "error");
      }
    });

    $("btnCopyCookieB64").addEventListener("click", async () => {
      try {
        const data = await api("/api/cookies");
        if (!data.cookies_base64) {
          toast("Önce bir cookies.txt yükleyin.", "error");
          return;
        }
        await navigator.clipboard.writeText(data.cookies_base64);
        toast("COOKIES_BASE64 panoya kopyalandı", "success");
      } catch (err) {
        toast(err.message, "error");
      }
    });

    $("btnSaveCookies").addEventListener("click", async () => {
      const mode =
        document.querySelector('input[name="cookieMode"]:checked')?.value || "none";
      const browser = $("cookieBrowserSelect").value;
      const cookiesText = $("cookieTextArea").value.trim() || null;
      try {
        const updated = await api("/api/cookies", {
          method: "POST",
          body: JSON.stringify({ mode, browser, cookies_text: cookiesText }),
        });
        $("cookieTextArea").value = "";
        updateCookieUI(updated);
        $("cookieModal").classList.add("hidden");
        toast("Ayarlar kaydedildi", "success");
      } catch (err) {
        toast(err.message, "error");
      }
    });

    $("btnOpenDownloadsDir").addEventListener("click", async () => {
      try {
        await api("/api/open-folder", { method: "POST" });
      } catch (err) {
        toast(err.message, "error");
      }
    });

    $("btnClearQueue").addEventListener("click", async () => {
      await api("/api/jobs/clear", { method: "POST" });
      await refreshJobs();
    });

    $("btnClearHistory").addEventListener("click", async () => {
      if (!state.history.length) return;
      await api("/api/history?delete_files=false", { method: "DELETE" });
      await loadHistory();
      toast("Geçmiş temizlendi");
    });
  }

  async function bootAuthenticated() {
    await loadSystemInfo();
    await loadHistory();
    await refreshJobs();
    connectSSE();

    const params = new URLSearchParams(window.location.search);
    const sharedUrl = params.get("url") || params.get("text");
    if (sharedUrl) {
      $("urlInput").value = sharedUrl;
      $("btnClearUrl").classList.remove("hidden");
      runAnalyze(false);
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    initTabs();
    initDownloadActions();
    initModals();

    try {
      const auth = await api("/api/auth/status");
      if (auth.required && !auth.authenticated) {
        $("authModal").classList.remove("hidden");
        $("authPasswordInput").focus();
        return;
      }
    } catch {
      // ignore
    }

    await bootAuthenticated();
  });
})();
