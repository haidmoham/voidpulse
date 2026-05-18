import { AudioEngine } from "./audio.js";
import { Visualizer } from "./visualizer.js";
import { SpotifyWatcher } from "./spotify.js";
import { BeatTracker } from "./beat-tracker.js";

// ── Stream mode (?stream=1) — transparent canvas, no UI, OBS browser source ──
const STREAM_MODE = new URLSearchParams(location.search).has("stream");
if (STREAM_MODE) document.body.classList.add("stream-mode");

function detectPhone() {
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const touch  = navigator.maxTouchPoints > 1;
  const ua     = /Mobi|Android|iPhone|iPod/i.test(navigator.userAgent);
  return (coarse && touch) || ua;
}
const IS_PHONE = detectPhone();
document.body.classList.toggle("is-phone", IS_PHONE);

const canvas = document.getElementById("stage");
const sourcePicker = document.getElementById("source-picker");
const fileInput = document.getElementById("file-input");
const sourceLabel = document.getElementById("source-label");
const playBtn = document.getElementById("play-btn");
const stopBtn = document.getElementById("stop-btn");
const errorToast = document.getElementById("error-toast");
const volSlider   = document.getElementById("vol-slider");
const sensSlider  = document.getElementById("sens-slider");
const volRow      = document.getElementById("vol-row");
const castBtn          = document.getElementById("cast-btn");
const castTooltip      = document.getElementById("cast-tooltip");
const helpBtn          = document.getElementById("help-btn");
const helpTooltip      = document.getElementById("help-tooltip");
const streamBtn        = document.getElementById("stream-btn");
const streamTooltip    = document.getElementById("stream-tooltip");
const spotifyTooltip   = document.getElementById("spotify-tooltip");
const spotifyDisconnect = document.getElementById("spotify-disconnect");
const npCard   = document.getElementById("now-playing");
const npArt    = document.getElementById("np-art");
const npTrack  = document.getElementById("np-track");
const npArtist = document.getElementById("np-artist");
const lyricsEl     = document.getElementById("lyrics");
const lyricLineEl  = lyricsEl?.querySelector(".lyric-line");

// ── custom cursor ────────────────────────────────────────────
const cursorEl   = document.getElementById("cursor");
const cursorRing = document.getElementById("cursor-ring");
let _cursorBeatTimer = 0;


// XP-style cursor trail — ring buffer of recent mouse positions.
const TRAIL_COUNT = 10;
const _trailPos = Array.from({ length: TRAIL_COUNT }, () => ({ x: -200, y: -200 }));
const _trailEls = Array.from({ length: TRAIL_COUNT }, () => {
  const el = document.createElement("div");
  el.className = "cursor-trail";
  document.body.appendChild(el);
  return el;
});

document.addEventListener("mousemove", (e) => {
  cursorEl.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
  // Shift position history: newest at front, oldest at back.
  _trailPos.unshift({ x: e.clientX, y: e.clientY });
  _trailPos.length = TRAIL_COUNT;
});
document.addEventListener("mouseleave", () => { cursorEl.style.opacity = "0"; });
document.addEventListener("mouseenter", () => { cursorEl.style.opacity = "1"; });

function pulseCursor() {
  cursorRing.classList.add("cursor-beat");
  clearTimeout(_cursorBeatTimer);
  _cursorBeatTimer = setTimeout(() => cursorRing.classList.remove("cursor-beat"), 280);
}

// ── favicon animation ────────────────────────────────────────
const _favCanvas = document.createElement("canvas");
_favCanvas.width = 32; _favCanvas.height = 32;
const _favCtx  = _favCanvas.getContext("2d");
const _favLink = document.querySelector("link[rel='icon']");
let _favPulse  = 0;
let _favFrame  = 0;

function drawFavicon(beat) {
  if (beat) _favPulse = 1;
  else _favPulse *= 0.82;
  _favFrame++;
  // Only redraw when something is happening (skip idle frames)
  if (!beat && _favPulse < 0.01 && _favFrame % 30 !== 0) return;

  const ctx = _favCtx;
  const size = 32;
  ctx.clearRect(0, 0, size, size);

  // Background
  ctx.fillStyle = "#0a001e";
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, 5);
  ctx.fill();

  // Outer glow
  const r = 5 + _favPulse * 8;
  const glow = ctx.createRadialGradient(16, 16, 0, 16, 16, r * 2.8);
  glow.addColorStop(0, `rgba(0,240,255,${0.5 + _favPulse * 0.5})`);
  glow.addColorStop(1, "rgba(0,240,255,0)");
  ctx.beginPath();
  ctx.arc(16, 16, r * 2.8, 0, Math.PI * 2);
  ctx.fillStyle = glow;
  ctx.fill();

  // Core dot
  ctx.beginPath();
  ctx.arc(16, 16, r, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(0,240,255,${0.75 + _favPulse * 0.25})`;
  ctx.fill();

  if (_favLink) _favLink.href = _favCanvas.toDataURL();
}
const zoomInBtn   = document.getElementById("zoom-in-btn");
const zoomOutBtn  = document.getElementById("zoom-out-btn");
const zoomValue   = document.getElementById("zoom-value");

const audio   = new AudioEngine();
const viz     = new Visualizer(canvas, {
  ...(IS_PHONE ? { particleCount: 15000, pixelRatioLimit: 1.5 } : {}),
  streamMode: STREAM_MODE,
});
const spotify = new SpotifyWatcher();
const spotifyBtn = document.querySelector('.src-btn[data-src="spotify"]');

// BeatTracker is instantiated lazily the first time an audio source is activated
// (the AudioContext must exist first). Once loaded, it replaces the FFT onset
// detector with Essentia.js RhythmExtractor2013 for real beat phase alignment.
// Until Essentia is ready (~6-8s on first use), audio.beat() is used as fallback.
let beatTracker = null;

function ensureBeatTracker() {
  if (beatTracker || !audio.ctx) return beatTracker;
  beatTracker = new BeatTracker(audio.ctx);
  beatTracker.onBeat = () => {
    // When Essentia detects a beat on a live audio source, phase-lock the
    // Spotify BPM pulse grid so it aligns with the real musical downbeat.
    if (spotify.isPlaying) spotify.phaseLock(spotify.estimatePositionMs());
  };
  beatTracker.onBpm = (bpm) => {
    console.info(`[beat-tracker] ${bpm.toFixed(1)} BPM`);
  };
  return beatTracker;
}

/** Connect (or reconnect) BeatTracker to the current audio source node. */
async function connectBeatTracker() {
  if (!audio.source || !audio.ctx) return;
  const bt = ensureBeatTracker();
  if (bt) await bt.connect(audio.source);
}

// ── Mobile detection ─────────────────────────────────────────────────────────
const isMobile = navigator.maxTouchPoints > 0 && window.innerWidth < 900;

// ── Sample search panel ──────────────────────────────────────────────────────
const mdTracksEl    = document.getElementById("md-tracks");
const mdResultsEl   = document.getElementById("md-results");
const mdSuggestEl   = document.getElementById("md-suggestions");
const mdSearchInput = document.getElementById("md-search");
let _activeTrackBtn = null;

/** Build a track card button from a { title, artist, preview_url, art_url } object. */
function buildTrackCard(track) {
  const btn = document.createElement("button");
  btn.className = "md-track";
  btn.innerHTML = `
    <img class="md-art" src="${track.art_url || ""}" alt="" loading="lazy">
    <div class="md-info">
      <div class="md-track-title">${track.title}</div>
      <div class="md-track-artist">${track.artist}</div>
    </div>
    <span class="md-play-icon">▶</span>
  `;
  btn.addEventListener("click", async () => {
    if (_activeTrackBtn) {
      _activeTrackBtn.classList.remove("md-playing");
      _activeTrackBtn.querySelector(".md-play-icon").textContent = "▶";
    }
    _activeTrackBtn = btn;
    btn.classList.add("md-playing");
    btn.querySelector(".md-play-icon").textContent = "▐▐";
    try {
      await audio.loadUrl(track.preview_url, track.title);
      await audio.play();
      connectBeatTracker().catch(() => {});
    } catch (err) {
      showError(err.message || String(err));
      return;
    }
    refreshUi();
  });
  return btn;
}

function renderTracks(container, tracks, emptyMsg) {
  container.innerHTML = "";
  if (!tracks.length) {
    container.innerHTML = `<div class="md-empty">${emptyMsg}</div>`;
    return;
  }
  tracks.forEach(t => container.appendChild(buildTrackCard(t)));
}

/** Load curated suggestions from our Flask endpoint (iTunes-backed, cached). */
async function loadSuggestions() {
  try {
    const res = await fetch("/auth/spotify/demos");
    const tracks = await res.json();
    renderTracks(mdTracksEl, Array.isArray(tracks) ? tracks : [],
      "previews unavailable — use mic below");
  } catch {
    mdTracksEl.innerHTML = '<div class="md-empty">couldn\'t load suggestions</div>';
  }
}

/** Search iTunes directly from the browser (open CORS). */
async function searchItunes(query) {
  const url = `https://itunes.apple.com/search?${new URLSearchParams({
    term: query, entity: "song", limit: 6, country: "US",
  })}`;
  const data = await fetch(url).then(r => r.json());
  return (data.results || [])
    .filter(item => item.previewUrl)
    .map(item => ({
      title:       item.trackName,
      artist:      item.artistName,
      preview_url: item.previewUrl,
      art_url:     (item.artworkUrl100 || "").replace("100x100", "300x300"),
    }));
}

// Debounced search — fires 350ms after the user stops typing.
let _searchTimer = 0;
mdSearchInput.addEventListener("input", () => {
  const q = mdSearchInput.value.trim();
  clearTimeout(_searchTimer);

  if (!q) {
    // Back to suggestions
    mdResultsEl.hidden  = true;
    mdSuggestEl.hidden  = false;
    return;
  }

  // Show results area with loading dots while we wait.
  mdSuggestEl.hidden  = true;
  mdResultsEl.hidden  = false;
  mdResultsEl.innerHTML = `<div class="md-loading">
    <span class="md-loading-dot"></span>
    <span class="md-loading-dot"></span>
    <span class="md-loading-dot"></span>
  </div>`;

  _searchTimer = setTimeout(async () => {
    try {
      const tracks = await searchItunes(q);
      renderTracks(mdResultsEl, tracks, "no previews found — try another track");
    } catch {
      mdResultsEl.innerHTML = '<div class="md-empty">search failed — try again</div>';
    }
  }, 350);
});

// Load suggestions immediately on mobile — panel is always visible inline.
if (isMobile) loadSuggestions();

// Photosensitivity warning — shown once per browser session (skipped in stream mode).
const ewOverlay = document.getElementById("epilepsy-warning");
const ewProceed = document.getElementById("ew-proceed");
if (sessionStorage.getItem("voidpulse.ew.ack")) {
  ewOverlay.hidden = true;
} else {
  ewProceed.addEventListener("click", () => {
    sessionStorage.setItem("voidpulse.ew.ack", "1");
    ewOverlay.hidden = true;
  }, { once: true });
}

// Stream mode: clicking the canvas (or pressing M) activates the mic so the
// streamer can go live without ever seeing the UI.  The hint overlay disappears
// once the source is live.
if (STREAM_MODE) {
  const streamHint   = document.getElementById("stream-hint");
  const streamCredit = document.getElementById("stream-credit");
  let _streamMicDone = false;

  // Fade the attribution credit out after 8 seconds.
  setTimeout(() => streamCredit && streamCredit.classList.add("credit-fade"), 8000);

  async function activateStreamMic() {
    if (_streamMicDone) return;
    _streamMicDone = true;
    // Dismiss the hint (CSS transition fades it out).
    if (streamHint) streamHint.classList.add("hint-dismissed");
    try {
      await audio.useMicrophone();
      connectBeatTracker().catch(() => {});
      refreshUi();
    } catch { /* mic denied — visualizer still runs silently */ }
  }
  canvas.addEventListener("click", activateStreamMic, { once: true });
  document.addEventListener("keydown", (e) => {
    if (e.key === "m" || e.key === "M") activateStreamMic();
  });
}

let errorTimer = 0;
function showError(msg) {
  errorToast.classList.remove("info");
  errorToast.textContent = msg;
  errorToast.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => { errorToast.hidden = true; }, 6000);
}
function showInfo(msg) {
  errorToast.classList.add("info");
  errorToast.textContent = msg;
  errorToast.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    errorToast.hidden = true;
    errorToast.classList.remove("info");
  }, 5000);
}

function refreshUi() {
  sourceLabel.textContent = buildSourceLabel();
  document.querySelectorAll(".src-btn").forEach((btn) => {
    const src = btn.dataset.src;
    if (src === "spotify") {
      // Spotify is a background service, not an audio source mode.
      // "active" = the watcher is currently running.
      btn.classList.toggle("active", spotify.isRunning);
    } else {
      const btnSrc = src || (btn.classList.contains("file-btn") ? "file" : "");
      btn.classList.toggle("active", audio.mode === btnSrc);
    }
  });
  // Volume slider only applies to file playback — mic/tab have no output
  // volume here, and Spotify volume lives in the user's Spotify client.
  const isFile = audio.mode === "file";
  volRow.classList.toggle("ctrl-disabled", !isFile);
  volSlider.disabled = !isFile;

  // Play/pause only makes sense for file mode; stop shows for any audio source.
  playBtn.hidden = !isFile;
  if (isFile) playBtn.textContent = audio.isPlaying() ? "pause" : "play";
  // Stop disconnects the audio source. Spotify is disconnected via its own button.
  stopBtn.hidden = !audio.mode;
}

/** Source label: shows audio source and Spotify link state together. */
function buildSourceLabel() {
  const hasAudio = !!audio.mode;
  if (hasAudio && spotify.isRunning) {
    const track = spotify.currentTrack;
    const linked = track ? `♪ ${track.name}` : "♪ spotify linked";
    return `${audio.label} · ${linked}`;
  }
  if (hasAudio) return audio.label;
  if (spotify.isRunning) return formatSpotifyLabel();
  return "no source";
}

/** Full Spotify status string for when it's the only active source. */
function formatSpotifyLabel() {
  const { currentTrack: track, currentDevice: device, isPlaying } = spotify;
  if (!track) return "spotify · play something in your spotify app";
  const artists = (track.artists || []).map(a => a.name).join(", ");
  const status  = isPlaying ? "" : " (paused)";
  const where   = device?.name ? ` · ${device.name}` : "";
  return `spotify · ${track.name}${artists ? " — " + artists : ""}${status}${where}`;
}

/** Render the active synced lyric line. Empty/null hides the overlay.
 *  LRC sometimes has blank lines at instrumental breaks — honor them by
 *  fading out for the duration instead of holding the previous line. */
let _lyricFadeTimer = 0;
function renderLyric(line) {
  if (!lyricsEl || !lyricLineEl) return;
  const text = (line?.text || "").trim();
  if (!text) {
    lyricsEl.classList.remove("lyrics-visible");
    lyricLineEl.classList.remove("lyric-show");
    return;
  }
  lyricsEl.classList.add("lyrics-visible");
  // Two-stage swap: fade old line out, swap text, fade new line in. The
  // 180ms delay matches the CSS transition just enough to feel deliberate
  // without lagging behind the music perceptibly.
  lyricLineEl.classList.remove("lyric-show");
  clearTimeout(_lyricFadeTimer);
  _lyricFadeTimer = setTimeout(() => {
    lyricLineEl.textContent = text;
    lyricLineEl.classList.add("lyric-show");
  }, 180);
}

/** Show/hide the now-playing card based on current Spotify state. */
function updateNowPlaying() {
  const track = spotify.currentTrack;
  if (!spotify.isRunning || !track) {
    npCard.classList.remove("np-visible");
    return;
  }
  // Album art — use smallest available image (last in Spotify's descending array)
  const images = track.album?.images;
  const artUrl = images?.length ? images[images.length - 1].url : "";
  npArt.src = artUrl;
  npTrack.textContent  = track.name || "";
  npArtist.textContent = (track.artists || []).map(a => a.name).join(", ");
  // Paused state: dim card + show status line
  const paused = !spotify.isPlaying;
  npCard.classList.toggle("np-paused", paused);
  document.getElementById("np-status").textContent = paused ? "⏸ paused" : "";
  npCard.classList.add("np-visible");
}

sourcePicker.addEventListener("click", async (e) => {
  const btn = e.target.closest(".src-btn");
  if (!btn) return;
  const src = btn.dataset.src;
  if (src === "system") {
    e.preventDefault();
    try { await audio.useSystemAudio(); connectBeatTracker().catch(() => {}); }
    catch (err) { showError(err.message || String(err)); }
    refreshUi();
  } else if (src === "mic") {
    e.preventDefault();
    try { await audio.useMicrophone(); connectBeatTracker().catch(() => {}); }
    catch (err) { showError(err.message || String(err)); }
    refreshUi();
  } else if (src === "spotify") {
    e.preventDefault();
    await handleSpotifyClick(e);
  }
  // file-btn opens the native file picker via its <input>.
});

// ── Spotify integration ──────────────────────────────────────────────
// Flow: probe /auth/spotify/status. If unconfigured, hide the button.
// If configured but unauthenticated, clicking it kicks off OAuth (full-page
// redirect). On return, ?spotify=connected auto-activates the source.

async function probeSpotify() {
  try {
    const r = await fetch("/auth/spotify/status");
    if (!r.ok) return { authenticated: false, configured: false };
    return await r.json();
  } catch { return { authenticated: false, configured: false }; }
}

async function handleSpotifyClick(e) {
  if (spotify.isRunning) {
    // Show/hide the info tooltip. Disconnect lives inside the tooltip
    // so accidental clicks don't break an active session.
    e?.stopPropagation();
    spotifyTooltip.hidden = !spotifyTooltip.hidden;
    return;
  }
  const { authenticated, configured } = await probeSpotify();
  if (!configured) {
    showError("Spotify source is not configured on this server.");
    return;
  }
  if (!authenticated) {
    // Full-page redirect to Spotify OAuth; we come back to /?spotify=connected.
    window.location.href = "/auth/spotify/login";
    return;
  }
  await activateSpotify();
}

async function activateSpotify() {
  // Spotify is a background service — it does NOT replace the audio source.
  // When a live audio source (mic/tab/file) is also active, FFT drives the
  // visuals and Spotify just supplies auto-palette + phase-lock on beat events.
  // When no audio source is active, SpotifyWatcher.tick() synthesises bands
  // from the track's BPM so the cloud still breathes in time.
  try {
    spotify.onTrackChange  = () => { refreshUi(); updateNowPlaying(); renderLyric(null); };
    spotify.onStateChange  = () => { refreshUi(); updateNowPlaying(); };
    spotify.onFeaturesLoad = (features) => {
      const palette = paletteForMood(features);
      if (palette) applyPalette(palette);
    };
    spotify.onLyricLine    = (line) => renderLyric(line);
    spotify.onError = ({ type, message }) => {
      if (type !== "poll") showError(`Spotify ${type.replace(/_/g, " ")}: ${message}`);
    };
    await spotify.start();
    refreshUi();
    showInfo("♪ spotify linked — connect tab audio or mic for full reactivity");
  } catch (err) {
    showError(err.message || String(err));
  }
}

// On load: surface OAuth errors, auto-activate the Spotify watcher after a
// successful callback, and reveal the button only when the server is configured.
(async () => {
  const params = new URLSearchParams(location.search);
  if (params.has("spotify_error")) {
    showError(`Spotify auth: ${params.get("spotify_error")}`);
  }
  const status = await probeSpotify();
  if (status.configured) spotifyBtn.hidden = false;
  if (params.has("spotify")) {
    history.replaceState({}, "", location.pathname);
    if (params.get("spotify") === "connected" && status.authenticated) {
      // Start the watcher in the background — the user can still pick any audio
      // source; Spotify will layer on top automatically.
      activateSpotify();
    }
  }
})();

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    await audio.loadFile(file);
    await audio.play();
    connectBeatTracker().catch(() => {});
  } catch (err) {
    showError(err.message || String(err));
  }
  refreshUi();
});

playBtn.addEventListener("click", async () => {
  if (audio.isPlaying()) audio.pause();
  else await audio.play();
  refreshUi();
});

stopBtn.addEventListener("click", async () => {
  // Disconnect beat tracker before tearing down the source node so the
  // worklet isn't left connected to a stale (disconnected) AudioNode.
  beatTracker?.disconnect();
  audio.pause();
  await audio._teardownCurrent();
  // Spotify watcher intentionally keeps running — the cloud will switch to
  // synthetic BPM bands and the palette link stays active.
  refreshUi();
});

// Burst gate state — persists across frames so the cooldown check works.
let _lastBurstMs = -Infinity;

function frame() {
  let bands, beat;
  if (audio.analyser) {
    // Live audio source active: rich FFT reactivity + Essentia beat detection.
    // Spotify watcher (if also running) contributes auto-palette in background
    // and receives phase-lock via beatTracker.onBeat — but doesn't drive bands.
    bands = audio.bands(); // also updates audio._beat internally

    // Visual bursts come from the FFT onset detector — it fires on actual
    // energy transients (kick, bass hit) and stays musical regardless of
    // Essentia state. No haywire transition when Essentia kicks in.
    // Essentia's role here is BPM estimation only: it sets the minimum gap
    // so bursts pace to the song tempo without becoming a metronome.
    // beatTracker.beat() is called separately just to advance the grid and
    // fire onBeat → spotify.phaseLock(); it doesn't drive the visual burst.
    if (beatTracker?.isReady) beatTracker.beat();

    const fftBeat  = audio.beat();
    const now      = performance.now();
    const bpmGapMs = (beatTracker?.intervalMs ?? 500) * 2.5;
    beat = fftBeat && (now - _lastBurstMs >= bpmGapMs);
    if (beat) _lastBurstMs = now;
  } else if (spotify.isPlaying) {
    // No audio source — Spotify only. Fall back to BPM-synthesised bands so
    // the cloud still breathes in time with whatever's playing.
    const tick = spotify.tick();
    bands = tick.bands;
    beat  = tick.beat;
  } else {
    bands = { bass: 0, mid: 0, treble: 0 };
    beat  = false;
  }
  const stereo = {
    bandsL:    audio.bandsL(),
    bandsR:    audio.bandsR(),
    freqDataL: audio.rawFreqL(),
    freqDataR: audio.rawFreqR(),
  };
  viz.render(bands, audio.rawFreq(), beat, stereo);
  // Resolve the active synced lyric line against the extrapolated Spotify
  // playhead. Fires onLyricLine only when the index changes, so the DOM
  // touch is rare even though this runs every frame.
  if (spotify.lyrics) spotify.currentLyric();
  if (beat) pulseCursor();
  drawFavicon(beat);
  // Update XP trail: each ghost fades + shrinks toward the back.
  _trailEls.forEach((el, i) => {
    const t = 1 - (i + 1) / (TRAIL_COUNT + 1);
    const { x, y } = _trailPos[i] ?? { x: -200, y: -200 };
    el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${0.3 + t * 0.7})`;
    el.style.opacity = String(t * 0.5);
  });
  requestAnimationFrame(frame);
}

// Tuning panel: sliders write directly to shader uniforms, values persist
// across reloads via localStorage so a good config survives a refresh.
const TUNING_KEY = "voidpulse.tuning.v9";
const savedTuning = JSON.parse(localStorage.getItem(TUNING_KEY) || "{}");

// If a slider has data-exponent="N", the raw slider value is raised to the
// Nth power before being applied. This gives log-like fine control at the
// low end while still reaching the full range at max. The *displayed* value
// and the value passed to setTuning are always the post-transform value so
// screenshots are truthful.
function applyTransform(input, raw) {
  const exp = parseFloat(input.dataset.exponent);
  return (exp && exp !== 1) ? Math.pow(raw, exp) : raw;
}

document.querySelectorAll("#tuning-panel input[type=range]").forEach((input) => {
  const valEl   = input.parentElement.querySelector(".slider-val");
  const label   = input.parentElement.querySelector("label");
  const uniform = input.dataset.uniform;

  // Restore from localStorage on load (saved value is the raw slider position).
  if (typeof savedTuning[uniform] === "number") {
    input.value = savedTuning[uniform];
    const restored = applyTransform(input, savedTuning[uniform]);
    valEl.textContent = restored.toFixed(2);
    viz.setTuning(uniform, restored);
  }

  input.addEventListener("input", () => {
    const raw = parseFloat(input.value);
    const v   = applyTransform(input, raw);
    valEl.textContent = v.toFixed(2);
    viz.setTuning(uniform, v);
    savedTuning[uniform] = raw;             // save raw position, not transformed
    localStorage.setItem(TUNING_KEY, JSON.stringify(savedTuning));
  });

  // Click the label to reset just that slider to its HTML default.
  // Tooltip shows the *effective* (transformed) default.
  const transformedDefault = applyTransform(input, parseFloat(input.defaultValue));
  label.dataset.resetTo = transformedDefault.toFixed(2);
  label.addEventListener("click", () => {
    input.value = input.defaultValue;
    valEl.textContent = transformedDefault.toFixed(2);
    viz.setTuning(uniform, transformedDefault);
    delete savedTuning[uniform];
    localStorage.setItem(TUNING_KEY, JSON.stringify(savedTuning));
  });
});

// Click a section header to reset only the sliders within that section.
document.querySelectorAll("#tuning-panel .section-label").forEach((header) => {
  const section = header.closest(".tuning-section");
  header.addEventListener("click", () => {
    section.querySelectorAll("input[type=range]").forEach((input) => {
      input.value = input.defaultValue;
      const v    = applyTransform(input, parseFloat(input.defaultValue));
      const valEl = input.parentElement.querySelector(".slider-val");
      valEl.textContent = v.toFixed(2);
      viz.setTuning(input.dataset.uniform, v);
      delete savedTuning[input.dataset.uniform];
    });
    localStorage.setItem(TUNING_KEY, JSON.stringify(savedTuning));
  });
});

// Helper: pick a random value within a slider's range (snapped to step), then
// fire the input event so all the existing wiring (transform, display, save,
// viz.setTuning) runs.
function randomizeSlider(input) {
  const min  = parseFloat(input.min);
  const max  = parseFloat(input.max);
  const step = parseFloat(input.step) || 0.01;
  const v    = min + Math.random() * (max - min);
  input.value = Math.round(v / step) * step;
  input.dispatchEvent(new Event("input"));
}

// 🎲 per-section randomize buttons.
document.querySelectorAll("#tuning-panel .section-random").forEach((btn) => {
  const section = btn.closest(".tuning-section");
  btn.addEventListener("click", () => {
    section.querySelectorAll("input[type=range]").forEach(randomizeSlider);
  });
});

// 🎲 overall randomize — sliders + palette + shape + stereo toggles.
const tuningRandom = document.getElementById("tuning-random");
tuningRandom.addEventListener("click", () => {
  document.querySelectorAll("#tuning-panel input[type=range]").forEach(randomizeSlider);
  randomizeSlider(sensSlider);
  const palettes = ["synthwave", "inferno", "arctic", "toxic", "void", "ember", "nebula"];
  applyPalette(palettes[Math.floor(Math.random() * palettes.length)]);
  const shapes = ["sphere", "heart", "torus", "galaxy", "cube", "helix"];
  applyShape(shapes[Math.floor(Math.random() * shapes.length)]);
  document.querySelectorAll(".stereo-btn").forEach((btn) => {
    setStereo(btn.dataset.stereo, Math.random() < 0.5 ? 1 : 0);
  });
  localStorage.setItem(STEREO_KEY, JSON.stringify(savedStereo));
});

// Collapse / expand the tuning panel.
const tuningPanel  = document.getElementById("tuning-panel");
const tuningToggle = document.getElementById("tuning-toggle");
const tuningReset  = document.getElementById("tuning-reset");
const TUNING_COLLAPSED_KEY = "voidpulse.tuning.collapsed";
// Panel starts collapsed (set via HTML class). Only expand if the user has
// explicitly opened it in a previous session.
if (localStorage.getItem(TUNING_COLLAPSED_KEY) === "0") {
  tuningPanel.classList.remove("collapsed");
}
tuningToggle.addEventListener("click", () => {
  tuningPanel.classList.toggle("collapsed");
  localStorage.setItem(
    TUNING_COLLAPSED_KEY,
    tuningPanel.classList.contains("collapsed") ? "1" : "0",
  );
});

// Simple ↔ advanced view. Simple = chip rows + stereo only. Advanced =
// expands the slider body. Default is simple to keep the menu uncluttered;
// power users explicitly opt into the sliders, and the choice persists.
const tuningDetails       = document.getElementById("tuning-details");
const TUNING_ADVANCED_KEY = "voidpulse.tuning.advanced";

function applyAdvancedMode(on) {
  tuningPanel.classList.toggle("advanced", on);
  tuningDetails.textContent = on ? "▾ advanced" : "▸ advanced";
  localStorage.setItem(TUNING_ADVANCED_KEY, on ? "1" : "0");
}

applyAdvancedMode(localStorage.getItem(TUNING_ADVANCED_KEY) === "1");
tuningDetails.addEventListener("click", () => {
  applyAdvancedMode(!tuningPanel.classList.contains("advanced"));
});

// Cinematic mode — auto-cut camera + palette every 12–20s. State persists
// across reloads. The visualizer fires onSceneTick on each cut and we pair
// it with a random palette swap so each cut feels like a scene change.
const tuningCinema    = document.getElementById("tuning-cinema");
const CINEMA_KEY      = "voidpulse.cinema";
let   lastCinemaPalette = null;

viz.onSceneTick = () => {
  // PALETTES is defined below; evaluate lazily at call time (not at module parse).
  const names = Object.keys(PALETTES);
  // Pick a different palette than the last cut so consecutive scenes feel distinct.
  let name;
  do { name = names[Math.floor(Math.random() * names.length)]; }
  while (name === lastCinemaPalette && names.length > 1);
  lastCinemaPalette = name;
  applyPalette(name);
};

function applyCinema(on) {
  viz.setCinematic(on);
  tuningCinema.classList.toggle("on", on);
  localStorage.setItem(CINEMA_KEY, on ? "1" : "0");
}

applyCinema(localStorage.getItem(CINEMA_KEY) === "1");
tuningCinema.addEventListener("click", () => applyCinema(!viz.cinematic));

// Reset all sliders to their HTML default values and clear persisted state.
tuningReset.addEventListener("click", () => {
  document.querySelectorAll("#tuning-panel input[type=range]").forEach((input) => {
    input.value = input.defaultValue;
    const v    = applyTransform(input, parseFloat(input.defaultValue));
    const valEl = input.parentElement.querySelector(".slider-val");
    valEl.textContent = v.toFixed(2);
    viz.setTuning(input.dataset.uniform, v);
    delete savedTuning[input.dataset.uniform];
  });
  localStorage.removeItem(TUNING_KEY);
});

// ── Stereo toggles ────────────────────────────────────────────────────────
// Three independent on/off switches for particle hemisphere split, floor
// channel split, and color divergence. Persist across reloads.
const STEREO_KEY = "voidpulse.stereo.v1";
const savedStereo = JSON.parse(localStorage.getItem(STEREO_KEY) || "{}");

// Push a single stereo toggle to its visual + viz state. Doesn't persist —
// callers batch the localStorage write so a preset load only writes once.
function setStereo(uniform, value) {
  const btn = document.querySelector(`.stereo-btn[data-stereo="${uniform}"]`);
  if (!btn) return;
  const next = value ? 1 : 0;
  btn.dataset.on = next;
  btn.textContent = next ? "stereo" : "mono";
  btn.classList.toggle("on", next === 1);
  viz.setTuning(uniform, next);
  savedStereo[uniform] = next;
}

document.querySelectorAll(".stereo-btn").forEach((btn) => {
  const uniform = btn.dataset.stereo;
  setStereo(uniform, savedStereo[uniform] === 1 ? 1 : 0);

  btn.addEventListener("click", () => {
    setStereo(uniform, btn.dataset.on === "1" ? 0 : 1);
    localStorage.setItem(STEREO_KEY, JSON.stringify(savedStereo));
  });
});

// ── Presets, save slots, URL-hash sharing ─────────────────────────────────
// Everything "preset-like" is captured in one state shape:
//   { sliders: { uniform → raw }, stereo: { uniform → 0|1 } }
// captureState() reads it from the live UI. applyState() pushes it back
// through dispatchEvent('input') so localStorage + display values + shader
// uniforms all stay in sync without re-implementing that wiring.
function captureState() {
  const sliders = {};
  document.querySelectorAll("#tuning-panel input[type=range]").forEach((input) => {
    sliders[input.dataset.uniform] = parseFloat(input.value);
  });
  const stereo = {};
  document.querySelectorAll(".stereo-btn").forEach((btn) => {
    stereo[btn.dataset.stereo] = parseInt(btn.dataset.on, 10) || 0;
  });
  return { sliders, stereo, shape: currentShape };
}

function applyState(state) {
  if (!state) return;
  if (state.shape) applyShape(state.shape);
  if (state.sliders) {
    document.querySelectorAll("#tuning-panel input[type=range]").forEach((input) => {
      const uniform = input.dataset.uniform;
      const raw = (uniform in state.sliders)
        ? state.sliders[uniform]
        : parseFloat(input.defaultValue);
      input.value = raw;
      input.dispatchEvent(new Event("input")); // updates display, viz, localStorage
    });
  }
  if (state.stereo) {
    document.querySelectorAll(".stereo-btn").forEach((btn) => {
      const uniform = btn.dataset.stereo;
      const val = (uniform in state.stereo) ? state.stereo[uniform] : 0;
      setStereo(uniform, val);
    });
    localStorage.setItem(STEREO_KEY, JSON.stringify(savedStereo));
  }
}

// Five curated presets, each with a distinct visual character. Missing
// slider/stereo keys fall back to HTML defaults / mono.
const PRESETS = {
  starfield: {
    shape: "sphere",
    sliders: { cAttrCount: 2, uAttrStr: 7.5, cAttrRadius: 55 },
    stereo: { uStereoParticles: 0, fStereoFloor: 0, eStereoColor: 0 },
  },
  heart: {
    shape: "heart",
    // Single slow attractor at tight radius so the cloud wraps into the heart.
    sliders: {
      uBreatheMin: 0.35, uBreatheMax: 2.50, uBreatheCurve: 2.35,
      uSizeMin:    0.14, uSizeMax:    2.15, uSizeCurve:    3.00,
      cBurstInterval: 0.5, cRotateSpeed: 0.06,
      fMaxH: 30, fScroll: 5, fScrollBass: 22, fDecay: 0.80, fHotCurve: 2.5,
      bStrength: 0.48, bRadius: 0.25, bThreshold: 0.38,
      eCycleSpeed: 0.05, eBassHue: 0.50, eTrebleHue: 0.10, eSatReact: 0.30, eBurstHue: 0.50,
      cAttrCount: 1, uAttrStr: 6.0, cAttrRadius: 35,
    },
    stereo: { uStereoParticles: 0, fStereoFloor: 0, eStereoColor: 0 },
  },
  nebula: {
    shape: "torus",
    // Black hole accretion disk. Torus ring = disk with naturally dark center
    // (event horizon). 3 tight-orbit attractors inside the ring radius create
    // dense gravitational streams. Fast spin + high turbulent flow simulate
    // orbital dynamics. Bloom is controlled — ring edge glows purple, center
    // stays black. Bass beats = tidal disruption bursts.
    sliders: {
      uBreatheMin: 0.85, uBreatheMax: 1.35, uBreatheCurve: 0.55,
      uSizeMin:    0.32, uSizeMax:    1.20, uSizeCurve:    2.60,
      cBurstInterval: 2.5, cRotateSpeed: 0.52,
      fMaxH: 28, fScroll: 5, fScrollBass: 20, fDecay: 0.80, fHotCurve: 2.5,
      bStrength: 0.38, bRadius: 0.42, bThreshold: 0.55,
      eCycleSpeed: 0.00, eBassHue: 0.05, eTrebleHue: 0.03, eSatReact: 0.15, eBurstHue: 0.12,
      eInnerHue: 0.78, eOuterHue: 0.82,
      cAttrCount: 9, uAttrStr: 22.0, cAttrRadius: 30,
      uFlowStrength: 2.40,
    },
    stereo: { uStereoParticles: 0, fStereoFloor: 0, eStereoColor: 0 },
  },
  storm: {
    shape: "torus",
    // Aggressive/snappy: a spinning donut torn by 4 attractors at max strength.
    // Fast bursts, fast spin, fast bass-scroll floor, sharp decay, all stereo
    // channels engaged.
    sliders: {
      uBreatheMin: 0.40, uBreatheMax: 2.20, uBreatheCurve: 0.80,
      uSizeMin:    0.18, uSizeMax:    1.50, uSizeCurve:    2.20,
      cBurstInterval: 0.8, cRotateSpeed: 0.32,
      fMaxH: 38, fScroll: 9, fScrollBass: 55, fDecay: 0.58, fHotCurve: 4.7,
      bStrength: 0.42, bRadius: 0.30, bThreshold: 0.55,
      eCycleSpeed: 0.015, eBassHue: 0.42, eTrebleHue: 0.18, eSatReact: 0.65, eBurstHue: 0.40,
      cAttrCount: 4, uAttrStr: 14.0, cAttrRadius: 65,
    },
    stereo: { uStereoParticles: 1, fStereoFloor: 1, eStereoColor: 1 },
  },
  vapor: {
    shape: "helix",
    // Slow + deep + drifting double-helix: long burst interval, deep
    // saturation, slow color cycle, stereo floor only. Two wells at mid
    // radius pull the strands gently apart and back.
    sliders: {
      uBreatheMin: 0.30, uBreatheMax: 1.60, uBreatheCurve: 2.60,
      uSizeMin:    0.45, uSizeMax:    1.90, uSizeCurve:    2.30,
      cBurstInterval: 6.0, cRotateSpeed: 0.05,
      fMaxH: 22, fScroll: 2.5, fScrollBass: 15, fDecay: 0.90, fHotCurve: 2.2,
      bStrength: 0.42, bRadius: 0.45, bThreshold: 0.50,
      eCycleSpeed: 0.025, eBassHue: 0.45, eTrebleHue: 0.06, eSatReact: 0.38, eBurstHue: 0.42,
      cAttrCount: 2, uAttrStr: 9.0, cAttrRadius: 50,
    },
    stereo: { uStereoParticles: 0, fStereoFloor: 1, eStereoColor: 0 },
  },
};

function applyPreset(name) {
  if (PRESETS[name]) applyState(PRESETS[name]);
}

document.querySelectorAll("#tuning-panel .preset-btn").forEach((btn) => {
  btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
});

// Color palettes — full visual mood swaps. Each touches base hues, the five
// color-reactivity sliders, bloom (strength/radius/threshold), and particle
// size character so palettes feel genuinely different — not just tinted.
// Stays off cloud dynamics (breathe, rotate, attractors, flow, beats) so
// you can layer any palette onto any scene preset without behavior change.
const PALETTES = {
  // Electric / sharp / 80s. Identity = brisk spin + tight flow holding the
  // shape, smallest particles. Low bloom keeps edges crisp on cube/helix.
  synthwave: {
    eInnerHue: 0.556, eOuterHue: 0.840,
    eCycleSpeed: 0.00, eBassHue: 0.10, eTrebleHue: 0.10, eSatReact: 0.25, eBurstHue: 0.44,
    bStrength: 0.395, bRadius: 0.39, bThreshold: 0.71,
    uSizeMin: 0.18, uSizeMax: 1.50, uSizeCurve: 2.80,
    cRotateSpeed: 0.18, uFlowStrength: 0.70,
  },
  // Hellfire / chaotic / fast. Identity = highest flow strength + fastest
  // spin + most frequent bursts. Bloom moderated; the chaos sells the heat.
  inferno: {
    eInnerHue: 0.10, eOuterHue: 0.97,
    eCycleSpeed: 0.02, eBassHue: 0.40, eTrebleHue: 0.18, eSatReact: 0.60, eBurstHue: 0.40,
    bStrength: 0.50, bRadius: 0.45, bThreshold: 0.40,
    uSizeMin: 0.18, uSizeMax: 1.30, uSizeCurve: 2.40,
    cRotateSpeed: 0.32, uFlowStrength: 1.80,
    uBreatheMin: 0.55, uBreatheMax: 2.20, cBurstInterval: 1.5,
  },
  // Glacial / still / crystalline. Identity = lowest flow + slowest spin +
  // rare bursts. Large soft particles, gentle breathe, minimal reactivity.
  arctic: {
    eInnerHue: 0.50, eOuterHue: 0.62,
    eCycleSpeed: 0.00, eBassHue: 0.06, eTrebleHue: 0.06, eSatReact: 0.15, eBurstHue: 0.20,
    bStrength: 0.45, bRadius: 0.55, bThreshold: 0.45,
    uSizeMin: 0.40, uSizeMax: 2.00, uSizeCurve: 1.50,
    cRotateSpeed: 0.04, uFlowStrength: 0.30,
    uBreatheMin: 0.80, uBreatheMax: 1.40, cBurstInterval: 6.0,
  },
  // Radioactive / squirming / alive. Identity = high flow + fast hue cycle
  // + max sat reactivity. Cloud writhes between greens and yellows.
  toxic: {
    eInnerHue: 0.33, eOuterHue: 0.17,
    eCycleSpeed: 0.06, eBassHue: 0.30, eTrebleHue: 0.25, eSatReact: 0.70, eBurstHue: 0.50,
    bStrength: 0.40, bRadius: 0.40, bThreshold: 0.55,
    uSizeMin: 0.22, uSizeMax: 1.50, uSizeCurve: 2.40,
    cRotateSpeed: 0.20, uFlowStrength: 2.00,
    uBreatheCurve: 0.80,
  },
  // Deep space / cosmic / drifting. Identity = slow continuous hue drift +
  // huge breathe curve (rare cosmic pulses) + slow spin. Large slow particles.
  void: {
    eInnerHue: 0.72, eOuterHue: 0.86,
    eCycleSpeed: 0.04, eBassHue: 0.45, eTrebleHue: 0.06, eSatReact: 0.40, eBurstHue: 0.30,
    bStrength: 0.48, bRadius: 0.50, bThreshold: 0.45,
    uSizeMin: 0.45, uSizeMax: 1.85, uSizeCurve: 1.80,
    cRotateSpeed: 0.06, uFlowStrength: 1.00,
    uBreatheMin: 0.45, uBreatheMax: 1.85, uBreatheCurve: 2.60, cBurstInterval: 5.0,
  },
  // Warm campfire / flickering / gentle. Identity = lowest spin + soft flow
  // + gentle breathe. Warmest bloom but moderated so amber stays visible.
  ember: {
    eInnerHue: 0.06, eOuterHue: 0.99,
    eCycleSpeed: 0.00, eBassHue: 0.15, eTrebleHue: 0.05, eSatReact: 0.20, eBurstHue: 0.30,
    bStrength: 0.55, bRadius: 0.45, bThreshold: 0.45,
    uSizeMin: 0.42, uSizeMax: 1.95, uSizeCurve: 2.00,
    cRotateSpeed: 0.06, uFlowStrength: 0.50,
    uBreatheMin: 0.65, uBreatheMax: 1.55, cBurstInterval: 5.0,
  },
  // Black hole — deep purple accretion ring, black center. Pinned to purple
  // (no hue drift), tight bloom so only the dense ring edge glows. Fast spin,
  // high turbulence. Pairs with the nebula preset.
  nebula: {
    eInnerHue: 0.78, eOuterHue: 0.82,
    eCycleSpeed: 0.00, eBassHue: 0.05, eTrebleHue: 0.03, eSatReact: 0.15, eBurstHue: 0.12,
    bStrength: 0.38, bRadius: 0.42, bThreshold: 0.55,
    uSizeMin: 0.14, uSizeMax: 1.10, uSizeCurve: 3.00,
    cRotateSpeed: 0.52, uFlowStrength: 2.40,
    uBreatheMin: 0.85, uBreatheMax: 1.35,
  },
};

// Drive --lyric-color and --lyric-glow CSS variables from the current outer
// palette hue so lyrics are always legible. Complement (hue + 0.5) maximises
// hue distance from the visualization; forced to high lightness (88%) so it
// reads on dark backgrounds. Dark text-shadow backstop in CSS handles
// legibility against bright particle clusters.
function updateLyricColor() {
  const outerH = (viz.eOuterHue ?? 0.84) * 360;
  const contrastH = ((viz.eOuterHue ?? 0.84) + 0.5) % 1.0 * 360;
  document.documentElement.style.setProperty(
    "--lyric-color", `hsl(${contrastH.toFixed(0)}, 100%, 88%)`);
  document.documentElement.style.setProperty(
    "--lyric-glow",  `hsla(${contrastH.toFixed(0)}, 100%, 70%, 0.55)`);
}

function applyPalette(name) {
  const p = PALETTES[name];
  if (!p) return;
  for (const [uniform, value] of Object.entries(p)) {
    const input = document.querySelector(`#tuning-panel input[data-uniform="${uniform}"]`);
    if (!input) continue;
    input.value = value;
    input.dispatchEvent(new Event("input"));
  }
  updateLyricColor();
}

document.querySelectorAll("#tuning-panel .palette-btn").forEach((btn) => {
  btn.addEventListener("click", () => applyPalette(btn.dataset.palette));
});

// Mobile panel — same preset/palette chips wired to the same handlers.
document.querySelectorAll("#mobile-panel .preset-btn").forEach((btn) => {
  btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
});
document.querySelectorAll("#mobile-panel .palette-btn").forEach((btn) => {
  btn.addEventListener("click", () => applyPalette(btn.dataset.palette));
});

// Map ReccoBeats track-level features → a palette name. The 2D space we
// care about is (valence × energy): valence ≈ how "positive" the track
// sounds, energy ≈ intensity. We pick one of the existing palettes by
// quadrant. Tracks not in ReccoBeats' catalog skip auto-palette entirely.
//
//   high val + high energy → toxic     (alive, bright, fast)
//   low  val + high energy → inferno   (dark, intense)
//   high val + low  energy → ember     (warm, gentle)
//   low  val + low  energy → arctic    (cool, still)
//   anything in the middle → synthwave (default neutral)
function paletteForMood(features) {
  if (!features || typeof features.valence !== "number" || typeof features.energy !== "number") {
    return null;
  }
  const v = features.valence;   // 0..1
  const e = features.energy;    // 0..1
  // Carve a "middle" band so songs that hover near neutral don't get
  // a strong palette identity they don't earn.
  const NEUTRAL = 0.15;         // dead-zone half-width around 0.5
  const lowV  = v < 0.5 - NEUTRAL,  highV = v > 0.5 + NEUTRAL;
  const lowE  = e < 0.5 - NEUTRAL,  highE = e > 0.5 + NEUTRAL;
  if (highV && highE) return "toxic";
  if (lowV  && highE) return "inferno";
  if (highV && lowE)  return "ember";
  if (lowV  && lowE)  return "arctic";
  return "synthwave";
}

// Shape selection. The visualizer drives the actual particle morph
// (smooth sphere↔target transition); this layer manages the active chip
// highlight + localStorage persistence. captureState/applyState also
// carry the shape field so presets and shared URLs restore it.
const SHAPE_KEY = "voidpulse.shape";
let currentShape = localStorage.getItem(SHAPE_KEY) || "sphere";

function applyShape(name, persist = true) {
  currentShape = name;
  viz.setShape(name);
  document.querySelectorAll(".shape-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.shape === name);
  });
  if (persist) localStorage.setItem(SHAPE_KEY, name);
}

document.querySelectorAll(".shape-btn").forEach((btn) => {
  btn.addEventListener("click", () => applyShape(btn.dataset.shape));
});

// Restore on load — if the saved shape isn't sphere, this triggers a smooth
// sphere→shape intro animation on first render.
applyShape(currentShape, false);
// On phone: lock to heart regardless of any saved shape preference.
if (IS_PHONE) applyShape("heart", false);

// User save slots: 4 chips, persisted as full state shapes in localStorage.
//   - Empty: plain click saves current state.
//   - Filled: plain click loads it. Shift+click overwrites with current.
//   - Right-click filled slot to clear it.
const SLOTS_KEY = "voidpulse.slots.v1";
const slots = JSON.parse(localStorage.getItem(SLOTS_KEY) || "{}");

function refreshSlotUI() {
  document.querySelectorAll(".slot-btn").forEach((btn) => {
    btn.classList.toggle("filled", !!slots[btn.dataset.slot]);
  });
}

document.querySelectorAll(".slot-btn").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    const id = btn.dataset.slot;
    if (slots[id] && !e.shiftKey) {
      applyState(slots[id]);
    } else {
      slots[id] = captureState();
      localStorage.setItem(SLOTS_KEY, JSON.stringify(slots));
      refreshSlotUI();
    }
  });
  btn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const id = btn.dataset.slot;
    if (slots[id]) {
      delete slots[id];
      localStorage.setItem(SLOTS_KEY, JSON.stringify(slots));
      refreshSlotUI();
    }
  });
});

refreshSlotUI();

// URL-hash sharing:
//   #presetName       → load a named preset
//   #c-<base64-json>  → load an arbitrary captured state
const shareBtn = document.getElementById("preset-share");

function loadFromHash() {
  const hash = location.hash.slice(1);
  if (!hash) return false;
  if (PRESETS[hash]) {
    applyPreset(hash);
    return true;
  }
  if (hash.startsWith("c-")) {
    try {
      applyState(JSON.parse(atob(hash.slice(2))));
      return true;
    } catch (err) {
      console.warn("[voidpulse] invalid state in URL hash:", err);
    }
  }
  return false;
}

shareBtn.addEventListener("click", () => {
  const encoded = btoa(JSON.stringify(captureState()));
  const url = `${location.origin}${location.pathname}#c-${encoded}`;
  const flash = () => {
    shareBtn.classList.add("copied");
    shareBtn.textContent = "✓ copied";
    setTimeout(() => {
      shareBtn.classList.remove("copied");
      shareBtn.textContent = "⎘ share";
    }, 1500);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(flash).catch(() => prompt("copy this URL:", url));
  } else {
    prompt("copy this URL:", url);
  }
});

window.addEventListener("hashchange", loadFromHash);
// Run after localStorage tuning/stereo init so hash takes precedence.
loadFromHash();

// Sensitivity transform: quadratic curve so the useful range (0.2–1.5)
// spans the first ~70% of the slider rather than the first 40%.
// raw 0→1 maps to displayed 0.20→3.00; default raw≈0.535 → displayed≈1.00.
function sensTform(raw) {
  return 0.2 + raw * raw * 2.8;
}

// Volume (file only) + Sensitivity (all modes) — both persist via localStorage.
const VOL_KEY  = "voidpulse.volume";
const SENS_KEY = "voidpulse.sensitivity.v2"; // v2: stores raw 0–1 position, not displayed value

const savedVol = parseFloat(localStorage.getItem(VOL_KEY));
if (!isNaN(savedVol)) { volSlider.value = savedVol; }
audio.setVolume(parseFloat(volSlider.value));
volSlider.addEventListener("input", () => {
  const v = parseFloat(volSlider.value);
  audio.setVolume(v);
  localStorage.setItem(VOL_KEY, v);
});

const savedSens = parseFloat(localStorage.getItem(SENS_KEY));
if (!isNaN(savedSens)) { sensSlider.value = savedSens; }
audio.setSensitivity(sensTform(parseFloat(sensSlider.value)));
sensSlider.addEventListener("input", () => {
  const raw = parseFloat(sensSlider.value);
  audio.setSensitivity(sensTform(raw));
  localStorage.setItem(SENS_KEY, raw);
});

// Click label to reset — same design language as tuning panel sliders.
const volLabel  = document.getElementById("vol-label");
const sensLabel = document.getElementById("sens-label");

volLabel.addEventListener("click", () => {
  volSlider.value = volSlider.defaultValue;
  audio.setVolume(parseFloat(volSlider.defaultValue));
  localStorage.removeItem(VOL_KEY);
});

sensLabel.addEventListener("click", () => {
  sensSlider.value = sensSlider.defaultValue;
  audio.setSensitivity(sensTform(parseFloat(sensSlider.defaultValue)));
  localStorage.removeItem(SENS_KEY);
});

// Zoom controls — + and − step the camera Z in increments of ZOOM_STEP. The
// visualizer lerps internally so each click eases in over ~0.5s. Percentage
// readout: 100% = closest (Z=zoomMin), 0% = farthest (Z=zoomMax).
const ZOOM_KEY = "voidpulse.zoom.v2"; // v2: stores a number, not a bool
const ZOOM_STEP = 15;

let currentZoom = parseFloat(localStorage.getItem(ZOOM_KEY));
if (!Number.isFinite(currentZoom)) currentZoom = viz.zoomDefault;
currentZoom = Math.max(viz.zoomMin, Math.min(viz.zoomMax, currentZoom));

function applyZoom() {
  viz.setZoom(currentZoom);
  const pct = Math.round(((viz.zoomMax - currentZoom) / (viz.zoomMax - viz.zoomMin)) * 100);
  zoomValue.textContent = `${pct}%`;
  zoomInBtn.disabled  = currentZoom <= viz.zoomMin;
  zoomOutBtn.disabled = currentZoom >= viz.zoomMax;
  localStorage.setItem(ZOOM_KEY, currentZoom);
}

zoomInBtn.addEventListener("click", () => {
  currentZoom = Math.max(viz.zoomMin, currentZoom - ZOOM_STEP);
  applyZoom();
});
zoomOutBtn.addEventListener("click", () => {
  currentZoom = Math.min(viz.zoomMax, currentZoom + ZOOM_STEP);
  applyZoom();
});

applyZoom();

// UI hide toggle — collapses everything except the nameplate and zoom control.
// The hide button lives inside the nameplate so it's reachable in both states.
// In hidden mode the button pulses neon pink so it's an obvious CTA to restore.
const uiHideBtn   = document.getElementById("ui-hide-btn");
const UI_HIDE_KEY = "voidpulse.ui-hidden";

function applyUiHidden(on) {
  document.body.classList.toggle("ui-hidden", on);
  uiHideBtn.textContent = on ? "⊕ show ui" : "⊘ hide ui";
  uiHideBtn.title = on
    ? "Show all UI controls"
    : "Hide all UI — only nameplate and zoom remain";
  // Close any open tooltips so they don't linger after hiding.
  if (on) {
    helpTooltip.hidden    = true;
    castTooltip.hidden    = true;
    spotifyTooltip.hidden = true;
  }
  localStorage.setItem(UI_HIDE_KEY, on ? "1" : "0");
}

applyUiHidden(localStorage.getItem(UI_HIDE_KEY) === "1");
uiHideBtn.addEventListener("click", () => applyUiHidden(!document.body.classList.contains("ui-hidden")));


spotifyDisconnect.addEventListener("click", (e) => {
  e.stopPropagation();
  spotify.stop();
  spotifyTooltip.hidden = true;
  refreshUi();
  updateNowPlaying();
});

helpBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  helpTooltip.hidden    = !helpTooltip.hidden;
  castTooltip.hidden    = true;
  streamTooltip.hidden  = true;
  spotifyTooltip.hidden = true;
});
castBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  castTooltip.hidden    = !castTooltip.hidden;
  helpTooltip.hidden    = true;
  streamTooltip.hidden  = true;
  spotifyTooltip.hidden = true;
});

// ── Stream button ────────────────────────────────────────────────────────
{
  const streamUrl     = `${location.origin}/?stream=1`;
  const urlDisplay    = document.getElementById("stream-url-display");
  const copyBtn       = document.getElementById("stream-copy-btn");
  const openLink      = document.getElementById("stream-open-link");
  if (urlDisplay) urlDisplay.textContent = streamUrl;
  if (openLink)   openLink.href = streamUrl;
  copyBtn && copyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(streamUrl).then(() => {
      copyBtn.textContent = "copied!";
      setTimeout(() => { copyBtn.textContent = "copy"; }, 2000);
    }).catch(() => {});
  });
  streamBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    streamTooltip.hidden  = !streamTooltip.hidden;
    helpTooltip.hidden    = true;
    castTooltip.hidden    = true;
    spotifyTooltip.hidden = true;
  });
}

document.addEventListener("click", () => {
  castTooltip.hidden    = true;
  helpTooltip.hidden    = true;
  streamTooltip.hidden  = true;
  spotifyTooltip.hidden = true;
});

// ── Mobile-only interactions ────────────────────────────────────────────
if (IS_PHONE) {
  // +/- zoom buttons.
  document.getElementById("mobile-zoom-in").addEventListener("click", () => {
    currentZoom = Math.max(viz.zoomMin, currentZoom - ZOOM_STEP);
    applyZoom();
  });
  document.getElementById("mobile-zoom-out").addEventListener("click", () => {
    currentZoom = Math.min(viz.zoomMax, currentZoom + ZOOM_STEP);
    applyZoom();
  });

  // Hide UI toggle — collapses panel/CTA/picker/status; button itself stays visible.
  const mobileHideBtn = document.getElementById("mobile-hide-btn");
  mobileHideBtn.addEventListener("click", () => {
    const hidden = document.body.classList.toggle("mobile-ui-hidden");
    mobileHideBtn.textContent = hidden ? "⊕ show ui" : "⊘ hide ui";
  });

  // Reset — sliders back to HTML defaults, shape stays heart.
  document.getElementById("mobile-reset-btn").addEventListener("click", () => {
    tuningReset.click();
    applyShape("heart", false);
  });


}

refreshUi();
updateLyricColor(); // set initial lyric color from default/restored palette
requestAnimationFrame(frame);
