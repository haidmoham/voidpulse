// Web Audio engine. Supports three audio sources:
//   - microphone      (getUserMedia, music-friendly constraints)
//   - system / tab    (getDisplayMedia, Chrome/Edge only)
//   - file upload     (fallback, routes to ctx.destination)
//
// Spotify is NOT an audio source — it runs as a background metadata watcher
// in main.js alongside any of the above. See SpotifyWatcher in spotify.js.
//
// For live sources we deliberately do NOT connect to ctx.destination —
// mic would feed back, tab audio would double-play.

const MIC_CONSTRAINTS = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 2,
  },
  video: false,
};

const DISPLAY_CONSTRAINTS = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
  // Chrome requires a video track in the picker even though we discard it.
  video: { displaySurface: "browser" },
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.gainNode = null;
    this.splitter = null;
    this.analyserL = null;
    this.analyserR = null;
    this.source = null;
    this.mode = null; // "mic" | "system" | "file" | null
    this.audio = null;
    this.stream = null;
    this.freqData  = null;
    this.freqDataL = null;
    this.freqDataR = null;
    this.label = "";
    this._volume      = 0.7;   // file playback volume only
    this._sensitivity = 1.0;   // visualizer reactivity, all modes
    this._smoothed  = { bass: 0, mid: 0, treble: 0 };
    this._smoothedL = { bass: 0, mid: 0, treble: 0 };
    this._smoothedR = { bass: 0, mid: 0, treble: 0 };
    this._bassEnvFast = 0;  // short-window onset envelope  (~4-frame avg)
    this._bassEnvSlow = 0;  // long-window reference envelope (~20-frame avg)
    this._beatCd      = 0;  // refractory frame counter
    this._beat        = false;
  }

  _ensureContext() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: "interactive" });
    }
  }

  _buildAnalyser() {
    // Mono analyser — reads the summed signal, used for beat detection and the
    // primary {bass, mid, treble} band values that drive everything by default.
    const a = this.ctx.createAnalyser();
    a.fftSize = 1024;
    a.smoothingTimeConstant = 0.78;
    this.analyser = a;
    this.freqData = new Uint8Array(a.frequencyBinCount);

    // Stereo split — one AnalyserNode per channel, tapped in parallel via a
    // ChannelSplitterNode. Costs two extra FFTs per frame; fine at fftSize 1024.
    this.splitter = this.ctx.createChannelSplitter(2);

    const aL = this.ctx.createAnalyser();
    aL.fftSize = 1024;
    aL.smoothingTimeConstant = 0.78;
    this.analyserL = aL;
    this.freqDataL = new Uint8Array(aL.frequencyBinCount);
    this.splitter.connect(aL, 0);

    const aR = this.ctx.createAnalyser();
    aR.fftSize = 1024;
    aR.smoothingTimeConstant = 0.78;
    this.analyserR = aR;
    this.freqDataR = new Uint8Array(aR.frequencyBinCount);
    this.splitter.connect(aR, 1);
  }

  async _teardownCurrent() {
    if (this.audio) {
      this.audio.pause();
      try { URL.revokeObjectURL(this.audio.src); } catch {}
      this.audio = null;
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.source) {
      try { this.source.disconnect(); } catch {}
      this.source = null;
    }
    if (this.gainNode) {
      try { this.gainNode.disconnect(); } catch {}
      this.gainNode = null;
    }
    if (this.splitter) {
      try { this.splitter.disconnect(); } catch {}
      this.splitter = null;
    }
    if (this.analyserL) {
      try { this.analyserL.disconnect(); } catch {}
      this.analyserL = null;
    }
    if (this.analyserR) {
      try { this.analyserR.disconnect(); } catch {}
      this.analyserR = null;
    }
    if (this.analyser) {
      try { this.analyser.disconnect(); } catch {}
      this.analyser = null;
    }
    this.mode = null;
    this.label = "";
  }

  async useMicrophone() {
    this._ensureContext();
    await this._teardownCurrent();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone not available in this browser.");
    }
    const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    this.stream = stream;
    this.source = this.ctx.createMediaStreamSource(stream);
    this._buildAnalyser();
    this.source.connect(this.analyser);
    this.source.connect(this.splitter);
    // No connect to destination — would feed back.
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.mode = "mic";
    const track = stream.getAudioTracks()[0];
    this.label = track?.label || "microphone";
  }

  async useSystemAudio() {
    this._ensureContext();
    await this._teardownCurrent();
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("System / tab audio capture not supported in this browser. Try Chrome or Edge.");
    }
    const stream = await navigator.mediaDevices.getDisplayMedia(DISPLAY_CONSTRAINTS);
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      for (const t of stream.getTracks()) t.stop();
      throw new Error("No audio in the shared source. Tick 'Share tab audio' in the picker, and share a tab (not a window).");
    }
    // Discard the video track — we only want audio.
    for (const t of stream.getVideoTracks()) t.stop();

    this.stream = stream;
    this.source = this.ctx.createMediaStreamSource(stream);
    this._buildAnalyser();
    this.source.connect(this.analyser);
    this.source.connect(this.splitter);
    // No connect to destination — the source tab is still playing the audio out loud.

    // If the user clicks "Stop sharing" in the browser bar, drop the stream cleanly.
    audioTracks[0].addEventListener("ended", () => {
      if (this.mode === "system") this._teardownCurrent();
    });

    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.mode = "system";
    this.label = audioTracks[0].label || "tab audio";
  }

  async loadFile(file) {
    this._ensureContext();
    await this._teardownCurrent();
    const audio = new Audio();
    audio.crossOrigin = "anonymous";
    audio.src = URL.createObjectURL(file);
    this.audio = audio;
    this.source = this.ctx.createMediaElementSource(audio);
    this._buildAnalyser();
    // Chain: source → analyser → gainNode → destination
    // gainNode sits after the analyser so volume doesn't affect sensitivity.
    const g = this.ctx.createGain();
    g.gain.value = this._volume;
    this.gainNode = g;
    this.source.connect(this.analyser);
    this.source.connect(this.splitter);
    this.analyser.connect(this.gainNode);
    this.gainNode.connect(this.ctx.destination);
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.mode = "file";
    this.label = file.name;
  }

  /** Load a remote URL (e.g. Spotify preview CDN) as a file-equivalent source.
   *  Same graph as loadFile; loops by default so short previews play forever. */
  async loadUrl(url, label = "preview", { loop = true } = {}) {
    this._ensureContext();
    await this._teardownCurrent();
    const audio = new Audio();
    audio.crossOrigin = "anonymous";
    audio.loop = loop;
    audio.src  = url;
    this.audio = audio;
    this.source = this.ctx.createMediaElementSource(audio);
    this._buildAnalyser();
    const g = this.ctx.createGain();
    g.gain.value = this._volume;
    this.gainNode = g;
    this.source.connect(this.analyser);
    this.source.connect(this.splitter);
    this.analyser.connect(this.gainNode);
    this.gainNode.connect(this.ctx.destination);
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.mode  = "file";
    this.label = label;
  }

  setVolume(v) {
    this._volume = v;
    if (this.gainNode) this.gainNode.gain.value = v;
  }

  setSensitivity(v) {
    this._sensitivity = v;
  }

  async play() {
    if (this.mode === "file") await this.audio?.play();
  }

  pause() {
    if (this.mode === "file") this.audio?.pause();
  }

  isPlaying() {
    if (this.mode === "file") return !!this.audio && !this.audio.paused && !this.audio.ended;
    return this.mode === "mic" || this.mode === "system";
  }

  // Raw frequency arrays — call after bands*() so the buffers are fresh.
  rawFreq()  { return this.freqData;  }
  rawFreqL() { return this.freqDataL; }
  rawFreqR() { return this.freqDataR; }

  // Shared band extractor — reads a freq buffer into smoothed energy values.
  // Bin width at 44.1kHz / fftSize=1024 ≈ 43Hz.
  //   bass:   bins  1–6    (~40–260 Hz)
  //   mid:    bins  7–46   (~300 Hz–2 kHz)
  //   treble: bins 47–255  (~2 kHz–11 kHz)
  _computeBands(bins, smooth) {
    const sens = this._sensitivity;

    let bass = 0;
    for (let i = 1; i <= 6; i++) bass += bins[i];
    bass = Math.min(1, (bass / (6 * 255)) * sens);

    let mid = 0;
    for (let i = 7; i <= 46; i++) mid += bins[i];
    mid = Math.min(1, (mid / (40 * 255)) * sens);

    let treble = 0;
    for (let i = 47; i < 256; i++) treble += bins[i];
    treble = Math.min(1, (treble / (209 * 255)) * sens);

    // Asymmetric smoothing: snap up fast on hits, decay slow.
    smooth.bass   = bass   > smooth.bass   ? bass   : smooth.bass   * 0.88 + bass   * 0.12;
    smooth.mid    = mid    > smooth.mid    ? mid    : smooth.mid    * 0.82 + mid    * 0.18;
    smooth.treble = treble > smooth.treble ? treble : smooth.treble * 0.78 + treble * 0.22;

    return { bass: smooth.bass, mid: smooth.mid, treble: smooth.treble, _rawBass: bass };
  }

  bands() {
    if (!this.analyser) return { bass: 0, mid: 0, treble: 0 };
    this.analyser.getByteFrequencyData(this.freqData);
    const out = this._computeBands(this.freqData, this._smoothed);

    // Two-envelope onset: fires when rawBass spikes above both the recent
    // (fast) and running (slow) averages — robust to sustained-bass passages.
    // An 8-frame refractory period prevents re-fire on the same kick.
    this._bassEnvFast = this._bassEnvFast * 0.78 + out._rawBass * 0.22;
    this._bassEnvSlow = this._bassEnvSlow * 0.95 + out._rawBass * 0.05;
    const onset = out._rawBass > this._bassEnvFast * 1.12 &&
                  out._rawBass > this._bassEnvSlow * 1.20 &&
                  out._rawBass > 0.08;
    if (this._beatCd > 0) { this._beatCd--;  this._beat = false; }
    else if (onset)       { this._beat = true; this._beatCd = 8; }
    else                  { this._beat = false; }

    return { bass: out.bass, mid: out.mid, treble: out.treble };
  }

  bandsL() {
    if (!this.analyserL) return { bass: 0, mid: 0, treble: 0 };
    this.analyserL.getByteFrequencyData(this.freqDataL);
    const out = this._computeBands(this.freqDataL, this._smoothedL);
    return { bass: out.bass, mid: out.mid, treble: out.treble };
  }

  bandsR() {
    if (!this.analyserR) return { bass: 0, mid: 0, treble: 0 };
    this.analyserR.getByteFrequencyData(this.freqDataR);
    const out = this._computeBands(this.freqDataR, this._smoothedR);
    return { bass: out.bass, mid: out.mid, treble: out.treble };
  }

  beat() { return this._beat; }
}
