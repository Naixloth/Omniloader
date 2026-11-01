(() => {
  "use strict";

  const state = {
    system: null,
    isIOS: /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
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
      return "/icon.svg";
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
      headers: options.body && !(options.body instanceof FormData)
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

  // --- System & Header Initialization ---
  async function loadSystemInfo() {
    try {
      const sys = await api("/api/system");
      state.system = sys;

      $("btnOpenDownloadsDir").classList.toggle("hidden", !sys.is_local_pc);
      $("btnLogout").classList.toggle("hidden", !sys.auth_enabled);
      $("cookieBrowserRadioCard").classList.toggle("hidden", Boolean(sys.cloud_mode));

      updateCookieUI(sys.settings);
      updateNetworkModalUI(sys);
    } catch (err) {
      console.error("Sistem bilgisi alınamadı:", err);
    }
  }

  function updateCookieUI(settings) {
    if (!settings) return;
    const dot = $("cookieStatusDot");
    const active = settings.cookie_mode && settings.cookie_mode !== "none";
    dot.classList.toggle("active", Boolean(active));

    const radios = document.querySelectorAll('input[name="cookieMode"]');
    radios.forEach((r) => {
      r.checked = r.value === (settings.cookie_mode || "none");
    });

    if (settings.cookie_browser) {
      $("cookieBrowserSelect").value = settings.cookie_browser;
    }

    const badge = $("cookieFileBadge");
    if (settings.has_cookie_file) {
      badge.textContent = "✅ Kayıtlı cookies.txt dosyası mevcut ve kullanıma hazır.";
      badge.style.color = "#34d399";
      $("btnCopyCookieB64").classList.toggle("hidden", !Boolean(state.system && state.system.cloud_mode));
    } else {
      badge.textContent = "ℹ️ Henüz yüklenmiş bir cookies.txt dosyası yok.";
      badge.style.color = "#94a3b8";
      $("btnCopyCookieB64").classList.add("hidden");
    }
    syncCookieSections();
  }

  function syncCookieSections() {
    const selected = document.querySelector('input[name="cookieMode"]:checked')?.value || "none";
    $("cookieFileSection").classList.toggle("hidden", selected !== "file");
    $("cookieBrowserSection").classList.toggle("hidden", selected !== "browser");
  }

  function updateNetworkModalUI(sys) {
    if (!sys) return;
    if (sys.cloud_mode) {
      const cloudUrl = window.location.origin;
      $("netTabsBar").classList.add("hidden");
      $("netTabLan").classList.add("hidden");
      $("netTabTunnel").classList.add("hidden");
      $("netTabCloud").classList.remove("hidden");
      $("cloudUrlText").textContent = cloudUrl;
      $("cloudQrImg").src = `/api/qr?text=${encodeURIComponent(cloudUrl)}`;
      return;
    }

    const lanUrl = sys.primary_lan_url;
    $("lanUrlText").textContent = lanUrl;
    $("lanQrImg").src = `/api/qr?text=${encodeURIComponent(lanUrl)}`;

    renderTunnelState(sys.tunnel);
  }

  function renderTunnelState(tunnel) {
    if (!tunnel) return;
    const startBtn = $("btnStartTunnel");
    const stopBtn = $("btnStopTunnel");
    const resBox = $("tunnelResultBox");

    if (tunnel.status === "running" && tunnel.public_url) {
      startBtn.classList.add("hidden");
      stopBtn.classList.remove("hidden");
      resBox.classList.remove("hidden");
      $("tunnelUrlText").textContent = tunnel.public_url;
      $("tunnelQrImg").src = `/api/qr?text=${encodeURIComponent(tunnel.public_url)}`;
    } else {
      startBtn.classList.remove("hidden");
      startBtn.disabled = false;
      startBtn.textContent = "⚡ HTTPS Tünelini Başlat";
      stopBtn.classList.add("hidden");
      resBox.classList.add("hidden");
    }
  }

  // --- Tabs & Inputs ---
  function initTabs() {
    document.querySelectorAll(".mode-tab[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".mode-tab[data-tab]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const tab = btn.dataset.tab;
        $("tabSingle").classList.toggle("hidden", tab !== "single");
        $("tabBatch").classList.toggle("hidden", tab !== "batch");
      });
    });

    document.querySelectorAll(".mode-tab[data-nettab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".mode-tab[data-nettab]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const t = btn.dataset.nettab;
        $("netTabLan").classList.toggle("hidden", t !== "lan");
        $("netTabTunnel").classList.toggle("hidden", t !== "tunnel");
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
      if (navigator.clipboard && navigator.clipboard.readText) {
        try {
          const txt = await navigator.clipboard.readText();
          if (txt && txt.trim()) {
            urlInput.value = txt.trim();
            clearBtn.classList.remove("hidden");
            runAnalyze(false);
            return;
          }
          toast("Panoda metin bulunamadı.", "error");
        } catch {
          urlInput.focus();
          toast("Kutucuğa dokunup 'Yapıştır' seçin.");
        }
      } else {
        urlInput.focus();
        urlInput.select();
        toast("Giriş kutusuna basılı tutup 'Yapıştır' seçin.");
      }
    });

    $("btnAnalyze").addEventListener("click", () => runAnalyze(false));
    $("btnLoadFullPlaylist").addEventListener("click", () => {
      if (state.analyzed && state.analyzed.playlist_url) {
        $("urlInput").value = state.analyzed.playlist_url;
      }
      runAnalyze(true);
    });

    // Video vs Audio segmented switch
    document.querySelectorAll(".seg-btn[data-dlmode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".seg-btn[data-dlmode]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.dlMode = btn.dataset.dlmode;
        $("videoOptionsBox").classList.toggle("hidden", state.dlMode !== "video");
        $("audioOptionsBox").classList.toggle("hidden", state.dlMode !== "audio");
      });
    });

    // Audio format cards
    document.querySelectorAll("#audioOptionsBox .q-card").forEach((card) => {
      card.addEventListener("click", () => {
        document.querySelectorAll("#audioOptionsBox .q-card").forEach((c) => c.classList.remove("active"));
        card.classList.add("active");
        state.selectedAudioFormat = card.dataset.afmt;
        state.selectedAudioBitrate = card.dataset.abr;
      });
    });

    // Trimmer accordion
    $("btnToggleTrim").addEventListener("click", () => {
      const body = $("trimBody");
      const hidden = body.classList.toggle("hidden");
      $("trimChevron").textContent = hidden ? "▾" : "▴";
    });
    $("btnResetTrim").addEventListener("click", () => {
      $("trimStart").value = "";
      $("trimEnd").value = "";
      $("chkForceKeyframes").checked = false;
    });

    // Batch mode switcher
    $("batchModeSelect").addEventListener("change", (e) => {
      const isVid = e.target.value === "video";
      $("batchVideoQualityWrap").classList.toggle("hidden", !isVid);
      $("batchAudioFormatWrap").classList.toggle("hidden", isVid);
      document.querySelector(".batch-compat").classList.toggle("hidden", !isVid);
    });

    // Playlist mode switcher
    $("plModeSelect").addEventListener("change", (e) => {
      const isVid = e.target.value === "video";
      $("plVideoQualityWrap").classList.toggle("hidden", !isVid);
      $("plAudioFormatWrap").classList.toggle("hidden", isVid);
    });
  }

  // --- Analyze Flow ---
  async function runAnalyze(includePlaylist = false) {
    const raw = $("urlInput").value.trim();
    if (!raw) {
      toast("Lütfen önce bir video veya sosyal medya bağlantısı girin.", "error");
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
      toast(err.message || "Analiz başarısız oldu.", "error");
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
      $("previewThumb").src = "/icon.svg";
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
    $("previewUploader").textContent = data.uploader ? `👤 ${data.uploader}` : "";
    $("previewSourceLink").href = data.webpage_url || data.url;

    // Reset trim values for new video
    $("trimStart").value = "";
    $("trimEnd").value = "";
    $("trimEnd").placeholder = durTxt ? `Örn: ${durTxt}` : "Örn: 01:30";

    if (data.has_playlist_param && data.playlist_url) {
      $("playlistHintBanner").classList.remove("hidden");
    }

    // Build quality grid
    const grid = $("qualityGrid");
    grid.innerHTML = "";
    const formats = data.formats && data.formats.length ? data.formats : [{ id: "best", label: "En Yüksek Kalite (MP4)" }];

    // Pick smart default: 1080 if present, otherwise highest available
    const has1080 = formats.some((f) => f.id === "1080");
    state.selectedQuality = has1080 ? "1080" : formats[0].id;

    formats.forEach((f) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `q-card ${f.id === state.selectedQuality ? "active" : ""}`;
      const sizeStr = formatBytes(f.filesize_approx);
      const fpsStr = f.fps && f.fps > 30 ? ` • ${Math.round(f.fps)}fps` : "";
      const subParts = [sizeStr ? `~${sizeStr}` : "MP4 Video", fpsStr].join("");
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
    $("playlistPlatformBadge").textContent = `${data.platform} • ${data.entries.length} Öğe`;
    $("playlistTitle").textContent = data.title || "Oynatma Listesi";
    $("playlistSubtitle").textContent = data.uploader ? `👤 ${data.uploader}` : "";

    const listEl = $("playlistEntriesList");
    listEl.innerHTML = "";

    data.entries.forEach((entry, idx) => {
      const row = document.createElement("label");
      row.className = "pl-item";
      const dur = formatDuration(entry.duration);
      row.innerHTML = `
        <input type="checkbox" class="pl-chk" data-idx="${idx}" checked />
        <img class="pl-thumb" src="${thumbSrc(entry.thumbnail)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='/icon.svg'" />
        <div class="pl-info">
          <div class="pl-title">${escHtml(entry.index)}. ${escHtml(entry.title)}</div>
          <div class="pl-meta">${dur ? `⏱️ ${escHtml(dur)}` : ""} ${entry.uploader ? `• ${escHtml(entry.uploader)}` : ""}</div>
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

  // --- Start Downloads ---
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
        toast("İndirme sıraya eklendi! ⚡", "success");
        await refreshJobs();
      } catch (err) {
        toast(err.message, "error");
      } finally {
        btn.disabled = false;
      }
    });

    $("btnSelectAllPl").addEventListener("click", () => {
      document.querySelectorAll("#playlistEntriesList .pl-chk").forEach((c) => { c.checked = true; });
      updatePlaylistSelectedCount();
    });

    $("btnDeselectAllPl").addEventListener("click", () => {
      document.querySelectorAll("#playlistEntriesList .pl-chk").forEach((c) => { c.checked = false; });
      updatePlaylistSelectedCount();
    });

    $("btnDownloadPlaylist").addEventListener("click", async () => {
      if (!state.analyzed || !state.analyzed.entries) return;
      const checked = Array.from(document.querySelectorAll("#playlistEntriesList .pl-chk:checked"));
      if (!checked.length) {
        toast("Lütfen listeden en az bir medya seçin.", "error");
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
        toast(`${res.jobs.length} medya indirme sırasına eklendi!`, "success");
        await refreshJobs();
      } catch (err) {
        toast(err.message, "error");
      } finally {
        $("btnDownloadPlaylist").disabled = false;
      }
    });

    $("btnStartBatchUrls").addEventListener("click", async () => {
      const lines = $("batchUrlsInput").value
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (!lines.length) {
        toast("Lütfen en az bir bağlantı yapıştırın.", "error");
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
        toast(`${res.jobs.length} bağlantı sıraya eklendi!`, "success");
        $("batchUrlsInput").value = "";
        await refreshJobs();
      } catch (err) {
        toast(err.message, "error");
      } finally {
        btn.disabled = false;
      }
    });
  }

  // --- iPhone Native Share Sheet ("Save Video" to Photos) ---
  async function shareOrSaveToIphonePhotos(filename, btnEl) {
    if (!filename) return;
    const downloadUrl = `/api/files/${encodeURIComponent(filename)}?download=1`;

    // If we already fetched and cached this File (for instant synchronous user activation)
    if (state.shareFileCache.has(filename)) {
      const cachedFile = state.shareFileCache.get(filename);
      try {
        await navigator.share({ files: [cachedFile], title: filename });
        return;
      } catch (err) {
        if (err.name !== "AbortError") {
          window.location.href = downloadUrl;
        }
        return;
      }
    }

    if (!navigator.canShare) {
      window.location.href = downloadUrl;
      return;
    }

    const origLabel = btnEl.innerHTML;
    btnEl.disabled = true;
    btnEl.textContent = "⏳ Hazırlanıyor...";

    try {
      const resp = await fetch(downloadUrl);
      if (!resp.ok) throw new Error("Dosya alınamadı");
      const blob = await resp.blob();
      const file = new File([blob], filename, { type: blob.type || "video/mp4" });

      if (!navigator.canShare({ files: [file] })) {
        window.location.href = downloadUrl;
        return;
      }

      state.shareFileCache.set(filename, file);
      await navigator.share({ files: [file], title: filename });
      btnEl.innerHTML = origLabel;
    } catch (err) {
      if (err.name === "AbortError") {
        btnEl.innerHTML = origLabel;
      } else if (err.name === "NotAllowedError" && state.shareFileCache.has(filename)) {
        // Transient activation expired during large file fetch; next tap is 0ms synchronous!
        btnEl.textContent = "📲 Hazır! Galeriye Kaydetmek İçin Dokun";
      } else {
        btnEl.innerHTML = origLabel;
        window.location.href = downloadUrl;
      }
    } finally {
      btnEl.disabled = false;
    }
  }

  // --- Built-in Player ---
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

  // --- Render Queue & History ---
  function buildFileActionButtons(item) {
    if (!item.filename) return "";
    const fnEnc = encodeURIComponent(item.filename);
    const dlHref = `/api/files/${fnEnc}?download=1`;
    const isLocalPc = Boolean(state.system && state.system.is_local_pc);
    const canShareFiles = Boolean(navigator.canShare);

    const btns = [];
    if (state.isIOS || (canShareFiles && !isLocalPc)) {
      btns.push(
        `<button type="button" class="act-btn primary js-ios-share" data-fn="${escHtml(item.filename)}">📲 Fotoğraflara / Paylaş</button>`
      );
    }
    btns.push(
      `<a class="act-btn ${!state.isIOS && !isLocalPc ? "primary" : ""}" href="${dlHref}" download>⬇️ Cihaza İndir</a>`
    );
    if (isLocalPc) {
      btns.push(
        `<button type="button" class="act-btn primary js-open-file" data-fn="${escHtml(item.filename)}">📂 Klasörde Göster</button>`
      );
    }
    btns.push(
      `<button type="button" class="act-btn js-play-file" data-fn="${escHtml(item.filename)}" data-title="${escHtml(item.title)}">▶️ Oynat</button>`
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
          await api(`/api/open-folder?filename=${encodeURIComponent(btn.dataset.fn)}`, { method: "POST" });
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
          await api(`/api/jobs/${encodeURIComponent(btn.dataset.id)}/cancel`, { method: "POST" });
        } catch (err) {
          toast(err.message, "error");
        }
      });
    });
    container.querySelectorAll(".js-del-hist").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await api(`/api/history/${encodeURIComponent(btn.dataset.id)}?delete_file=false`, { method: "DELETE" });
          await loadHistory();
        } catch (err) {
          toast(err.message, "error");
        }
      });
    });
  }

  function renderJobs(jobs) {
    state.jobs = jobs || [];
    const activeCount = state.jobs.filter((j) =>
      j.status === "queued" || j.status === "downloading" || j.status === "processing"
    ).length;
    $("activeCountBadge").textContent = String(activeCount);

    // Check if any newly completed job appeared so we refresh persistent history
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
      box.innerHTML = `
        <div class="empty-state">
          <p>Henüz aktif bir indirme yok.</p>
          <small>Bir link analiz edip indirmeyi başlattığınızda hız ve ilerleme çubuğu burada görünür.</small>
        </div>
      `;
      return;
    }

    box.innerHTML = state.jobs
      .map((j) => {
        const isDone = j.status === "completed";
        const isErr = j.status === "error" || j.status === "cancelled";
        const isRunning = !isDone && !isErr;
        const pct = isDone ? 100 : Math.max(0, Math.min(100, j.progress || 0));
        const speedEta = [
          j.speed_text ? `🚀 ${j.speed_text}` : "",
          j.eta_text ? `⏳ ${j.eta_text}` : "",
          j.filesize ? formatBytes(j.filesize) : formatBytes(j.total_bytes),
        ]
          .filter(Boolean)
          .join(" • ");

        return `
          <div class="job-item">
            <div class="job-top">
              <img class="job-thumb" src="${thumbSrc(j.thumbnail)}" alt="" onerror="this.onerror=null;this.src='/icon.svg'" />
              <div class="job-info">
                <div class="job-title" title="${escHtml(j.title)}">${escHtml(j.title)}</div>
                <div class="job-sub">
                  <span>${escHtml(j.platform)}</span> • <span>${escHtml(j.quality_label)}</span>
                </div>
              </div>
            </div>

            <div class="progress-track">
              <div class="progress-fill ${isDone ? "done" : ""} ${isErr ? "err" : ""}" style="width:${pct}%"></div>
            </div>

            <div class="job-stats">
              <span>${escHtml(j.status_text)} (${pct.toFixed(0)}%)</span>
              <span>${escHtml(speedEta)}</span>
            </div>

            ${j.error ? `<div class="job-error">⚠️ ${escHtml(j.error)}</div>` : ""}

            <div class="job-actions">
              ${isRunning ? `<button type="button" class="act-btn danger js-cancel-job" data-id="${escHtml(j.id)}">✕ İptal Et</button>` : ""}
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
        box.innerHTML = `
          <div class="empty-state">
            <p>İndirme geçmişi boş.</p>
            <small>İndirdiğiniz tüm videolar ve sesler iPhone veya PC'ye kaydetmeniz için burada listelenir.</small>
          </div>
        `;
        return;
      }

      box.innerHTML = state.history
        .map((item) => {
          const sizeTxt = formatBytes(item.filesize);
          return `
            <div class="job-item">
              <div class="job-top">
                <img class="job-thumb" src="${thumbSrc(item.thumbnail)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='/icon.svg'" />
                <div class="job-info">
                  <div class="job-title" title="${escHtml(item.title)}">${escHtml(item.title)}</div>
                  <div class="job-sub">
                    <span>${escHtml(item.platform)}</span> •
                    <span>${escHtml(item.quality_label)}</span>
                    ${sizeTxt ? `• <span>${escHtml(sizeTxt)}</span>` : ""}
                  </div>
                </div>
              </div>
              <div class="job-actions">
                ${item.file_exists ? buildFileActionButtons(item) : `<span class="helper-text">Dosya taşınmış veya silinmiş</span>`}
                <button type="button" class="act-btn danger js-del-hist" data-id="${escHtml(item.id)}" title="Listeden kaldır">🗑️</button>
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
    let es = null;
    try {
      es = new EventSource("/api/events");
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

  // --- Modals & Topbar Controls ---
  function initModals() {
    $("btnCookies").addEventListener("click", async () => {
      await loadSystemInfo();
      $("cookieModal").classList.remove("hidden");
    });

    $("btnIphoneModal").addEventListener("click", async () => {
      await loadSystemInfo();
      $("iphoneModal").classList.remove("hidden");
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

    $("btnCopyCloudUrl").addEventListener("click", () => {
      const txt = $("cloudUrlText").textContent;
      navigator.clipboard?.writeText(txt);
      toast("7/24 Bulut adresi kopyalandı!", "success");
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
        toast("Giriş başarılı! Hoş geldiniz.", "success");
        await bootAuthenticated();
      } catch (err) {
        toast(err.message || "Hatalı şifre.", "error");
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
        toast("cookies.txt başarıyla yüklendi!", "success");
      } catch (err) {
        toast(err.message, "error");
      }
    });

    $("btnDeleteCookieFile").addEventListener("click", async () => {
      try {
        const updated = await api("/api/cookies/file", { method: "DELETE" });
        $("cookieTextArea").value = "";
        updateCookieUI(updated);
        toast("Çerez dosyası silindi.");
      } catch (err) {
        toast(err.message, "error");
      }
    });

    $("btnCopyCookieB64").addEventListener("click", async () => {
      try {
        const data = await api("/api/cookies");
        if (!data.cookies_base64) {
          toast("Önce bir cookies.txt dosyası yükleyin.", "error");
          return;
        }
        await navigator.clipboard.writeText(data.cookies_base64);
        toast("COOKIES_BASE64 kodu panoya kopyalandı! Render -> Environment kısmına yapıştırabilirsiniz.", "success");
      } catch (err) {
        toast(err.message, "error");
      }
    });

    $("btnSaveCookies").addEventListener("click", async () => {
      const mode = document.querySelector('input[name="cookieMode"]:checked')?.value || "none";
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
        toast("Çerez ayarları kaydedildi.", "success");
      } catch (err) {
        toast(err.message, "error");
      }
    });

    // Copy URLs & Tunnel buttons
    $("btnCopyLanUrl").addEventListener("click", () => {
      const txt = $("lanUrlText").textContent;
      navigator.clipboard?.writeText(txt);
      toast("Wi-Fi adresi panoya kopyalandı!", "success");
    });

    $("btnCopyTunnelUrl").addEventListener("click", () => {
      const txt = $("tunnelUrlText").textContent;
      navigator.clipboard?.writeText(txt);
      toast("HTTPS Tünel adresi kopyalandı!", "success");
    });

    $("btnStartTunnel").addEventListener("click", async () => {
      const btn = $("btnStartTunnel");
      btn.disabled = true;
      btn.textContent = "⏳ Tünel açılıyor (5-8 sn)...";
      try {
        const st = await api("/api/tunnel/start", { method: "POST" });
        renderTunnelState(st);
        if (st.public_url) {
          toast("HTTPS Tüneli aktif! QR kodu okutabilirsiniz.", "success");
        } else if (st.error) {
          toast(st.error, "error");
        }
      } catch (err) {
        toast(err.message, "error");
        btn.disabled = false;
        btn.textContent = "⚡ HTTPS Tünelini Başlat";
      }
    });

    $("btnStopTunnel").addEventListener("click", async () => {
      const st = await api("/api/tunnel/stop", { method: "POST" });
      renderTunnelState(st);
      toast("HTTPS Tüneli kapatıldı.");
    });

    // Queue & History header actions
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
      toast("İndirme geçmişi temizlendi.");
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

  // --- Boot ---
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
