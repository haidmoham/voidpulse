# CLAUDE.md — Voidpulse Project Memory

Source of truth for context, decisions, and conventions. Read at the start of every session.

---

## What This Project Is

A web reimagining of the iTunes Magnetosphere visualizer. A GPU particle field that swirls, breathes, and reacts to live audio.

**Reference:** https://www.youtube.com/watch?v=X29DK0qYEcE

---

## Audio Sources (priority order)

1. **Tab / system audio** — `getDisplayMedia({ audio: true })`. Chrome/Edge only. The cool one — visualizer reacts to whatever's playing in the shared tab without a mic.
2. **Microphone** — `getUserMedia` with `echoCancellation/noiseSuppression/autoGainControl` all forced off so music passes through cleanly.
3. **File upload** — fallback. Connects via `MediaElementAudioSourceNode` and routes to `ctx.destination` so the file plays through speakers.

Live sources (mic + system) are NOT connected to `ctx.destination` — mic would feed back, tab audio would double-play (the source tab is still emitting it).

---

## Stack

| Layer | Choice |
|---|---|
| Backend | Flask (app factory) on Python 3.11+ |
| Static compression | flask-compress (gzips shaders/JS) |
| Frontend | Vanilla ES modules + three.js r160 via importmap CDN |
| Audio analysis | Web Audio API `AnalyserNode`, FFT size 1024 |
| Rendering | three.js `Points` + custom `ShaderMaterial`, additive blending |
| Hosting | Railway (gunicorn gthread, healthcheck at `/health`) |

No bundler, no npm — everything is served as-is.

---

## Project Structure

```
voidpulse/
├── app/
│   ├── __init__.py           # Flask app factory
│   ├── routes.py             # /, /health
│   ├── templates/
│   │   └── index.html        # Single-page visualizer
│   └── static/
│       ├── css/style.css
│       └── js/
│           ├── main.js       # UI wiring + render loop
│           ├── audio.js      # AudioEngine (mic / tab audio / file)
│           └── visualizer.js # three.js particle field + shaders
├── scripts/
│   ├── dev.sh                # venv + run local
│   ├── deploy.sh             # commit + push + tail logs
│   ├── logs.sh               # railway logs
│   └── check-env.sh          # verify Railway env vars
├── railway.toml
├── requirements.txt
├── run.py
├── .env.example
└── CLAUDE.md                 # This file
```

---

## Audio → Visual Mapping

Three smoothed bands feed the shader uniforms each frame:

| Band | FFT bins | Hz range | Drives |
|---|---|---|---|
| bass | 1–6 | ~40–260 Hz | Radial breathing, point-size scale, rotation speed |
| mid | 7–46 | ~300 Hz–2 kHz | Y-axis displacement per particle |
| treble | 47–255 | ~2 kHz–11 kHz | High-frequency jitter / sparkle |

Smoothing is asymmetric: snap up fast on hits, decay slow (so a bass kick punches but doesn't strobe).

---

## Build Order

### Phase 1 — Particle field that breathes ✓
- Flask scaffold + Railway config
- Web Audio: mic, tab audio, file sources
- three.js 60k-particle sphere with custom shader
- Bass-driven radial breathing, mid/treble modulation

### Phase 2 — Flow + character ✓
- 2-octave curl-noise flow field (uFlowStrength uniform, tunable)
- Inner / outer shells (55% radii 18–36 / 45% radii 44–66, aLayer attribute)
- Two-envelope onset detector + 8-frame refractory → cleaner beat bursts

### Phase 3 — Glow ✓
- EffectComposer + UnrealBloomPass
- OutputPass (sRGB + tonemap)
- Color palette presets (synthwave/inferno/arctic/toxic/void/ember; hue-only swaps)

### Phase 4 — Magnetosphere proper ✓
- Audio-reactive attractors (mid orbit speed, bass radius pulse; 0–4 wells tunable)
- Scene transitions (cinematic mode: 6 named camera scenes + paired palette swaps every 12–20s)

### Phase 5 — Spotify beat-sync (faithful recreation goal)
The original iTunes Magnetosphere used iTunes' internal playback data — exact beat
positions, song structure, tempo — not raw FFT. That's what made it feel locked-in
to the music rather than just loudness-reactive. Phase 5 closes that gap.

**Architectural pivot (5.1 → 5.2):** the initial 5.1 implementation routed
playback *through the browser* via the Web Playback SDK so we could attach to
the audio. In 5.2 we dropped that entirely in favor of a **listening-along
watcher**: the user plays music in their normal Spotify client (desktop, phone,
speaker, anything) and we just poll `/v1/me/player` for what's playing +
position, then fetch `/v1/audio-analysis/{id}` for the beat timeline. The
visualizer reacts; no audio ever enters the browser. This matches how the
iTunes plugin worked, removes the Chrome sharing-bar problem, preserves
hardware playback controls, and works for free Spotify accounts (no Premium
streaming scope needed).

Spotify Audio Analysis API returns per-track: beat timestamps (sec), bar
positions, sections (verse/chorus/bridge), segments with pitch + timbre +
loudness envelopes, tempo, key, time signature, energy, valence.

**Architecture:**
- Flask: `/auth/spotify/{login,callback,token,status,logout}` with one scope
  (`user-read-playback-state`). Tokens in signed-cookie session.
- Frontend `SpotifyWatcher` (no SDK): polls `/v1/me/player` every 1.5s,
  extrapolates playhead between polls via `performance.now()` delta against
  the last `progress_ms` anchor, re-syncs on each poll to correct drift.
- On track change: fetches audio analysis, builds timeline, runs scheduler.
- `spotify.tick()` is called once per render frame; returns
  `{bands, beat, positionMs}` that main.js passes into viz.render() in
  place of the FFT-derived values.
- `bands` is *synthesized* from segment loudness envelopes (continuous energy
  signal between beats); `beat` is true when a beat timestamp crosses the
  estimated playhead this frame.
- Existing FFT pipeline stays in place for mic / tab / file sources.

**What Spotify drives:**
| Spotify data | Visualizer event |
|---|---|
| Beat timestamps (via Essentia) | Phase-lock for BPM pulse grid |
| Track valence + energy (ReccoBeats) | Auto-palette on track change |
| Tempo (ReccoBeats) | BPM pulse synth cadence |

Note: bar/section/segment data is unrecoverable — Spotify deprecated `/v1/audio-analysis` for post-Nov-2024 apps.

**Phase 5.1 — OAuth + playback foundation (done; superseded)**
- [x] Flask OAuth blueprint
- [x] Spotify source button (gated on server-side `configured` flag)
- [x] `audio.useSpotify()` stub mode

**Phase 5.2 — Listening-along watcher + beat scheduler (done; partly invalidated)**
- [x] Drop Web Playback SDK; rewrite as `SpotifyWatcher` (polling)
- [x] Reduce OAuth scope to `user-read-playback-state` only
- [x] Drift-corrected playhead estimator
- [x] Audio analysis fetch
- [x] Beat scheduler firing `uBurst` on beat timestamps
- [x] Synthesised bass/mid/treble from segment loudness envelope

**The Spotify deprecation problem (discovered post-5.2):**
On Nov 27 2024 Spotify deprecated `/v1/audio-analysis` AND `/v1/audio-features`
for any app created after the cutoff. Existing apps in extended quota mode
kept access; new apps lost it entirely. This visualizer's Spotify app is post-
cutoff, so the entire 5.2 analysis pipeline returns 403. The deprecation
removed per-beat / per-bar / per-section / per-segment data permanently —
no third-party service rebuilt that side. **Section/segment-level reactivity
is unrecoverable for new apps.**

**Phase 5.3 — ReccoBeats features + BPM-driven pulse (active)**
ReccoBeats (https://reccobeats.com) is a free public API that rebuilt the
deprecated `/audio-features` half: same field names + ranges (energy,
valence, tempo, key, danceability, etc.). No per-beat data. Lookup is
two-step: Spotify ID → ReccoBeats internal UUID → audio-features. Proxied
through Flask at `/auth/spotify/features/<spotify_id>` to handle CORS.
- [x] Drop the dead `/audio-analysis` fetch
- [x] Flask proxy `/auth/spotify/features/<id>` to ReccoBeats
- [x] `SpotifyWatcher._fetchFeatures()` on track change → `onFeaturesLoad`
- [x] Mood → palette mapping (valence × energy → toxic/inferno/ember/arctic/synthwave)
- [x] BPM pulse synth in `tick()`: tempo-driven beat + exponential energy decay
      between pulses. Cadence matches the song; downbeat alignment is random.

**Phase 5.4 — Essentia.js for real beat alignment (done)**
ReccoBeats gets us cadence but not phase. Essentia.js (WebAssembly port of
the Essentia C++ library) gives us `RhythmExtractor2013` — loaded lazily from
CDN (~2.4MB WASM baked into the ES module, cached after first use). Runs on
a rolling 6-second PCM buffer posted from an AudioWorklet.

Architecture:
- `beat-worklet.js`: AudioWorkletProcessor — ring-buffers PCM samples,
  posts a linearised 6-second Float32Array (transferred, zero-copy) every 2s.
- `beat-tracker.js`: `BeatTracker` class — loads Essentia lazily, runs
  `RhythmExtractor2013(signal, 208, 'multifeature', 40)` on each chunk,
  phase-anchors `_lastBeatMs` to the last detected tick, exposes `beat()`
  for the render loop and `onBeat` callback for Spotify phase-lock.
- `main.js`: `connectBeatTracker()` called after each mic/system/file
  activation; render loop uses `beatTracker.beat()` when `isReady`, falls
  back to `audio.beat()` (FFT onset) for the first ~6-8s.
- `spotify.js`: `phaseLock(posMs)` method snaps `_lastPulseMs` to the
  track position of an externally detected beat.

CDN imports (ES module, dynamic import inside beat-tracker.js):
  essentia.js-core.es.js — Essentia class (default export)
  essentia-wasm.es.js    — EssentiaWASM module (WASM inlined as base64)

- [x] Load essentia.js + WASM from CDN (no hosting needed)
- [x] AudioWorklet (`beat-worklet.js`) wrapping PCM collection
- [x] `BeatTracker` running `RhythmExtractor2013` with phase anchor
- [x] Replace FFT onset detector when Essentia is ready
- [x] `phaseLock()` on SpotifyWatcher for paired-source alignment

**Phase 5.5 — Paired Spotify + audio source mode (done)**
Spotify is now a background service, not an audio source mode. `audio.mode`
tracks only real audio (`mic|system|file|null`). Spotify watcher runs
independently and persists across audio source switches.

Render loop logic:
- `audio.analyser` present → FFT bands + Essentia beat (Spotify provides
  auto-palette in background; `beatTracker.onBeat` calls `spotify.phaseLock()`)
- No analyser, `spotify.isPlaying` → synthetic BPM bands from `spotify.tick()`
- Neither → zero bands

UX changes:
- Spotify button = connection toggle (click to link, click again to unlink)
- Spotify button shows `.active` when watcher is running (can be active
  alongside another source button simultaneously)
- Stop button disconnects audio source only; Spotify watcher keeps running
- Source label: `"tab audio · ♪ Track Name"` when both are active
- Removed `audio.useSpotify()` — Spotify never owned the audio pipeline
- Button hint: "background link · auto-palette · pairs with audio"

**Phase 5 ops notes:**
- Spotify dev dashboard: register `${BASE_URL}/auth/spotify/callback` as a
  redirect URI. Use 127.0.0.1 for local dev (Spotify blocks raw `localhost` on new apps).
- Required env vars on Railway: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`,
  `SPOTIFY_REDIRECT_URI=https://voidpulse.up.railway.app/auth/spotify/callback`
- Tokens live in Flask signed-cookie sessions (`PERMANENT_SESSION_LIFETIME=30d`).
- Polling cadence (1500ms) sits well under Spotify's ~180 req/min rate cap.

### Phase 6 — Mobile demo experience ✓

Goal: phone-first demo mode for screen recording + social sharing (Instagram, showing to people in person). Tablets included as phones.

**Detection:**
```js
function detectPhone() {
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const touch  = navigator.maxTouchPoints > 1;
  const ua     = /Mobi|Android|iPhone|iPod/i.test(navigator.userAgent);
  return (coarse && touch) || ua;
}
const IS_PHONE = detectPhone();
document.body.classList.toggle("is-phone", IS_PHONE);
```
Set before any DOM refs. The `is-phone` class on `<body>` drives all mobile overrides via CSS.

**Performance budget (targeting iPhone 13 Pro Max and newer):**
- 15,000 particles (down from 60,000 desktop)
- `pixelRatioLimit: 1.5` (iPhones have dpr=3; native bloom is 4× more expensive; capping to 1.5 makes it affordable)
- `Visualizer` constructor: `constructor(canvas, { particleCount = 60000, pixelRatioLimit = 2 } = {})`
- `let PARTICLE_COUNT` (was `const`) — mutated at constructor call time

**Mobile-locked behaviors:**
- Shape: heart, locked (reset re-applies heart)
- Audio source: microphone only (system/file/spotify buttons hidden)
- All desktop UI hidden via `.is-phone` CSS class (tuning panel, zoom row, help, cast, etc.)
- Custom cursor + trail hidden

**Mobile UI elements:**
- `#mobile-panel`: fixed at bottom, two horizontally-scrollable rows (presets + palettes) + actions row
  - Actions row: `↺ reset` · `↯ disrupt` · `− zoom +`
- `#mobile-hide-btn`: centered below nameplate, toggles `.mobile-ui-hidden` to collapse bottom UI for clean screen recording
- `#mobile-cta`: "more features on desktop" dim text above panel

**Disrupt on mobile:**
- `↯ disrupt` button in mobile panel actions row toggles `_cursorDisruptActive`
- `touchstart`/`touchmove` on canvas → `viz.screenToWorld(touch.clientX, touch.clientY)` → `viz.setCursorDisrupt(world, true)`
- `touchend`/`touchcancel` → `viz.setCursorDisrupt(null, false)`
- Uses `{ passive: false }` on touchstart/touchmove to allow `e.preventDefault()` (blocks scroll while disrupting)

**iOS safe area:**
- `viewport-fit=cover` in viewport meta
- All bottom-anchored elements use `calc(Npx + env(safe-area-inset-bottom, 0px))`

**Nameplate:**
- Credit section replaced with `add me on discord · fps_krow` (removed GitHub/LinkedIn/personal site links for semi-anonymous demo/social sharing use)

**Audio for screen recording:**
- Mobile mic captures ambient audio from environment; user asks someone nearby to play music on their device
- File upload intentionally left hidden on mobile (no use case for planned recordings that outweighs simplicity)
- Spotify watcher works on mobile but is hidden from the source picker UI

**Deployment ops (squash merge divergence):**
- Local git proxy returns HTTP 403 on pushes to `staging` and `main` — push to feature branches only
- All deploys: push feature branch → `mcp__github__create_pull_request` → `mcp__github__merge_pull_request` (squash)
- Squash merges cause divergence on every subsequent PR → merge conflicts
- Resolution: `git fetch origin staging && git merge origin/staging --no-edit`, then Python auto-resolve (always take HEAD):
  ```python
  re.sub(r'<<<<<<< HEAD\n(.*?)=======\n.*?>>>>>>> origin/staging\n',
         lambda m: m.group(1), text, flags=re.DOTALL)
  ```
- staging → main PRs also squash-merge; same conflict pattern applies (create temp branch from staging, merge origin/main, resolve, push, PR)

---

## Key Decisions Log

| Decision | Rationale |
|---|---|
| 80s synthwave aesthetic | Project-wide visual language: neon cyan + hot pink palette, deep purple background gradient, perspective grid floor, CRT scanlines, Orbitron + Share Tech Mono fonts. New UI elements should match this — no flat material-design defaults. |
| Spotify beat-sync over FFT-reactive | The original iTunes Magnetosphere used internal playback data (exact beat timestamps, song structure), not raw FFT. Phase 5 targets faithful recreation: Spotify Audio Analysis API provides beat/bar/section/segment data; the existing FFT pipeline stays as fallback for other sources. |
| Listening-along over in-browser playback | The Web Playback SDK approach (Phase 5.1) was dropped: routing audio through the browser added complexity (Chrome sharing-bar equivalents, volume routing, Premium requirement) without buying us anything beyond the analysis data we can fetch via the public Web API. The watcher just polls `/v1/me/player` for what's already playing on whatever device the user is using. Closer to how the original iTunes plugin actually worked. |
| Real-time audio over file upload | The "live reactivity to whatever's playing" is what makes a visualizer worth building. File upload kept as a fallback. |
| Tab audio (`getDisplayMedia`) over installing a system audio driver | Zero-install, browser-native. Chrome/Edge support is enough for a hobby project. |
| three.js over raw WebGL | Particles + camera + render loop boilerplate is solved; the interesting work is in the shader and audio mapping. |
| importmap CDN over npm | No bundler, no build step, faster iteration. |
| ShaderMaterial over PointsMaterial | Need per-particle audio-reactive deformation in the vertex shader. |
| No `connect(destination)` for live sources | Mic feedback, tab-audio doubling. |
| Asymmetric band smoothing | Bass kicks should punch, then decay — symmetric smoothing flattens transients. |
| Mobile: mic-only, no file/system/spotify | Simplicity. Screen recording use case just needs ambient mic. User asks someone nearby to play music — simpler than file upload or companion mode. |
| Mobile disrupt via touch not tap-to-toggle | Finger holds position → particles scatter while touching, restore on lift. Feels physical. |
| Nameplate credit → Discord only | Semi-anonymous for social sharing; keeps irl links off demo screenshots. |
| `pixelRatioLimit: 1.5` on mobile | iPhone native dpr=3 makes bloom 4× more expensive than at dpr=1.5. Biggest single mobile GPU win. |

---

## Notes for Claude Code

- Don't add a backend audio pipeline. All FFT happens in-browser. The Flask server only serves static files.
- The audio source picker is the primary UI. Anything that pushes mic/tab-audio off-screen is wrong.
- Browser autoplay rules: any audio source change requires a user click. Already handled.
- When debugging silence: open devtools, run `engine.bands()` — if all zeros, the graph isn't connected. If non-zero but stuck low, the source has gain/limiting.
