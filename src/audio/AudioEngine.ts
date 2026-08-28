import {
  analyzeSpectrum,
  createAnalyzerState,
  type AnalyzerState,
} from "./analyzer";
import type {
  AudioEngineOptions,
  AudioEngineState,
  AudioMetrics,
  AudioOnsetListener,
  AudioSourceKind,
  AudioStateListener,
} from "./types";

const MICROPHONE_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 2,
  },
  video: false,
};

/**
 * Chromium's picker needs a video constraint to expose the tab/window chooser.
 * The video track is stopped as soon as the stream arrives; it is never put in
 * the audio graph. `audio: true` deliberately leaves the browser's native
 * "share tab audio" checkbox and picker flow intact.
 */
const DISPLAY_CONSTRAINTS: DisplayMediaStreamOptions = {
  audio: true,
  video: { displaySurface: "browser" },
};

const IDLE_STATE: AudioEngineState = {
  status: "idle",
  source: null,
  label: "",
  error: null,
};

export class AudioEngineError extends Error {
  readonly code: "unsupported" | "cancelled" | "no-audio" | "failed";

  constructor(
    code: AudioEngineError["code"],
    message: string,
  ) {
    super(message);
    this.name = "AudioEngineError";
    this.code = code;
  }
}

/** Browser audio capture and analysis for NEBVIS. */
export class AudioEngine {
  private readonly options: AudioEngineOptions;
  private readonly stateListeners = new Set<AudioStateListener>();
  private readonly onsetListeners = new Set<AudioOnsetListener>();
  private readonly analyserOptions: NonNullable<AudioEngineOptions["analyser"]>;

  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserData: Uint8Array<ArrayBuffer> | null = null;
  private sourceNode: AudioNode | null = null;
  private outputGain: GainNode | null = null;
  private stream: MediaStream | null = null;
  private mediaElement: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private source: AudioSourceKind | null = null;
  private label = "";
  private volume = 0.7;
  private sensitivity = 1;
  private analyserState: AnalyzerState = createAnalyzerState();
  private metrics: AudioMetrics = { bass: 0, mid: 0, treble: 0, onset: false };
  private state: AudioEngineState = IDLE_STATE;
  private requestId = 0;

  constructor(options: AudioEngineOptions = {}) {
    this.options = options;
    this.analyserOptions = options.analyser ?? {};
  }

  /** The lazily-created context, useful when another subsystem phase-locks it. */
  get audioContext(): AudioContext | null {
    return this.context;
  }

  /** The current Web Audio source node, for optional beat-tracker consumers. */
  get audioSource(): AudioNode | null {
    return this.sourceNode;
  }

  getState(): AudioEngineState {
    return this.state;
  }

  /** Alias for React's `useSyncExternalStore` getSnapshot convention. */
  getSnapshot(): AudioEngineState {
    return this.state;
  }

  subscribe(listener: AudioStateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  subscribeOnset(listener: AudioOnsetListener): () => void {
    this.onsetListeners.add(listener);
    return () => this.onsetListeners.delete(listener);
  }

  async useMicrophone(): Promise<void> {
    const requestId = this.beginRequest("microphone");
    const mediaDevices = this.getMediaDevices();
    if (!mediaDevices?.getUserMedia) {
      throw this.fail(requestId, new AudioEngineError(
        "unsupported",
        "Microphone capture is not available in this browser.",
      ));
    }

    try {
      const stream = await mediaDevices.getUserMedia(MICROPHONE_CONSTRAINTS);
      if (!this.isCurrentRequest(requestId)) {
        stopTracks(stream);
        return;
      }
      await this.installLiveSource(requestId, stream, "microphone", "microphone");
    } catch (error) {
      if (this.isCurrentRequest(requestId)) this.teardownCurrent();
      throw this.fail(requestId, normalizeCaptureError(error instanceof Error ? error : null, "Microphone capture was not started."));
    }
  }

  /**
   * Open the browser-native tab/window picker. Call this directly from a user
   * gesture (for example, a button's click handler) so Chromium does not block
   * the picker. No captured mic/tab audio is connected to destination.
   */
  async useDisplayAudio(): Promise<void> {
    const requestId = this.beginRequest("display");
    const mediaDevices = this.getMediaDevices();
    if (!mediaDevices?.getDisplayMedia) {
      throw this.fail(requestId, new AudioEngineError(
        "unsupported",
        "Tab or window audio capture is not available in this browser. Try Chromium.",
      ));
    }

    try {
      const stream = await mediaDevices.getDisplayMedia(DISPLAY_CONSTRAINTS);
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        stopTracks(stream);
        throw new AudioEngineError(
          "no-audio",
          "The shared source has no audio. Enable tab audio in the browser picker and share a tab.",
        );
      }
      // We analyze audio only. Never attach a video track to the graph.
      for (const track of stream.getVideoTracks()) track.stop();
      if (!this.isCurrentRequest(requestId)) {
        stopTracks(stream);
        return;
      }
      await this.installLiveSource(requestId, stream, "display", audioTracks[0]?.label || "tab audio");
    } catch (error) {
      if (this.isCurrentRequest(requestId)) this.teardownCurrent();
      throw this.fail(requestId, normalizeCaptureError(error instanceof Error ? error : null, "Tab audio capture was not started."));
    }
  }

  /** Backwards-compatible name for callers that label this source "system". */
  useSystemAudio(): Promise<void> {
    return this.useDisplayAudio();
  }

  async loadFile(file: File): Promise<void> {
    const requestId = this.beginRequest("file");
    try {
      const context = this.ensureContext();
      const objectUrl = URL.createObjectURL(file);
      const element = new Audio();
      element.preload = "auto";
      element.src = objectUrl;
      const sourceNode = context.createMediaElementSource(element);
      if (!this.isCurrentRequest(requestId)) {
        sourceNode.disconnect();
        URL.revokeObjectURL(objectUrl);
        return;
      }
      this.installGraph(sourceNode, true);
      this.mediaElement = element;
      this.objectUrl = objectUrl;
      this.source = "file";
      this.label = file.name || "audio file";
      element.addEventListener("play", () => {
        if (this.source === "file" && this.mediaElement === element) this.setState({ status: "active" });
      });
      element.addEventListener("pause", () => {
        if (this.source === "file" && this.mediaElement === element) this.setState({ status: "paused" });
      });
      element.addEventListener("ended", () => {
        if (this.source === "file" && this.mediaElement === element) this.setState({ status: "paused" });
      });
      await resumeContext(context);
      element.load();
      this.setState({ status: "paused", source: "file", label: this.label });
    } catch (error) {
      if (this.isCurrentRequest(requestId)) this.teardownCurrent();
      throw this.fail(requestId, normalizeCaptureError(error instanceof Error ? error : null, "The audio file could not be loaded."));
    }
  }

  async play(): Promise<void> {
    if (this.source !== "file" || !this.mediaElement) return;
    await resumeContext(this.ensureContext());
    await this.mediaElement.play();
  }

  pause(): void {
    if (this.source === "file") this.mediaElement?.pause();
  }

  setVolume(value: number): void {
    this.volume = clamp(value);
    if (this.outputGain) this.outputGain.gain.value = this.volume;
  }

  setSensitivity(value: number): void {
    this.sensitivity = Math.max(0, value);
  }

  isPlaying(): boolean {
    if (this.source === "file") {
      return Boolean(this.mediaElement && !this.mediaElement.paused && !this.mediaElement.ended);
    }
    return this.source === "microphone" || this.source === "display";
  }

  /** Analyze the latest FFT frame. Call once per visualizer frame. */
  bands(): AudioMetrics {
    if (!this.analyser || !this.analyserData || !this.context) {
      this.metrics = { bass: 0, mid: 0, treble: 0, onset: false };
      return this.metrics;
    }
    this.analyser.getByteFrequencyData(this.analyserData);
    const analysis = analyzeSpectrum(
      this.analyserData,
      this.context.sampleRate,
      this.analyser.fftSize,
      this.analyserState,
      1 / 60,
      { ...this.analyserOptions, inputScale: "byte", sensitivity: this.sensitivity },
    );
    this.analyserState = analysis.nextState;
    this.metrics = analysis.metrics;
    if (analysis.metrics.onset) {
      for (const listener of this.onsetListeners) listener(analysis.metrics);
    }
    return this.metrics;
  }

  /** Last FFT byte frame, primarily for diagnostics and advanced visuals. */
  rawFrequencyData(): Uint8Array<ArrayBuffer> | null {
    return this.analyserData;
  }

  /** Stop capture/playback and disconnect every node owned by this engine. */
  stop(): void {
    this.requestId += 1;
    this.teardownCurrent();
  }

  private beginRequest(source: AudioSourceKind): number {
    const requestId = ++this.requestId;
    this.teardownCurrent(false);
    this.setState({ status: "requesting", source, label: "", error: null });
    return requestId;
  }

  private isCurrentRequest(requestId: number): boolean {
    return requestId === this.requestId;
  }

  private getMediaDevices(): Pick<MediaDevices, "getUserMedia" | "getDisplayMedia"> | undefined {
    return this.options.mediaDevices ?? globalThis.navigator?.mediaDevices;
  }

  private ensureContext(): AudioContext {
    if (this.context) return this.context;
    if (this.options.audioContextFactory) {
      this.context = this.options.audioContextFactory();
      return this.context;
    }
    // SAFETY: Chromium exposes this legacy constructor under webkitAudioContext;
    // the value is checked immediately below before it is called.
    const Context = globalThis.AudioContext
      ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) throw new AudioEngineError("unsupported", "Web Audio is not available in this browser.");
    this.context = new Context({ latencyHint: "interactive" });
    return this.context;
  }

  private createAnalyser(context: AudioContext): AnalyserNode {
    const analyser = context.createAnalyser();
    analyser.fftSize = this.analyserOptions.fftSize ?? 1024;
    analyser.smoothingTimeConstant = 0;
    if (this.analyserOptions.minDecibels !== undefined) analyser.minDecibels = this.analyserOptions.minDecibels;
    if (this.analyserOptions.maxDecibels !== undefined) analyser.maxDecibels = this.analyserOptions.maxDecibels;
    return analyser;
  }

  private installGraph(sourceNode: AudioNode, outputToDestination: boolean): void {
    const context = this.ensureContext();
    this.analyser = this.createAnalyser(context);
    this.analyserData = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyserState = createAnalyzerState();
    this.sourceNode = sourceNode;
    sourceNode.connect(this.analyser);
    if (outputToDestination) {
      const gain = context.createGain();
      gain.gain.value = this.volume;
      this.outputGain = gain;
      // File playback is the only source intentionally routed to speakers.
      this.analyser.connect(gain);
      gain.connect(context.destination);
    }
  }

  private async installLiveSource(
    requestId: number,
    stream: MediaStream,
    source: AudioSourceKind,
    label: string,
  ): Promise<void> {
    try {
      const context = this.ensureContext();
      const sourceNode = context.createMediaStreamSource(stream);
      this.installGraph(sourceNode, false);
      this.stream = stream;
      this.source = source;
      this.label = label;
      const audioTracks = stream.getAudioTracks();
      for (const track of audioTracks) {
        track.addEventListener("ended", () => {
          if (this.requestId !== requestId || this.stream !== stream) return;
          this.stop();
        });
      }
      await resumeContext(context);
      if (!this.isCurrentRequest(requestId) || this.stream !== stream) {
        disconnect(sourceNode);
        stopTracks(stream);
        return;
      }
      this.setState({ status: "active", source, label });
    } catch (error) {
      stopTracks(stream);
      throw error;
    }
  }

  private teardownCurrent(notify = true): void {
    if (this.mediaElement) {
      this.mediaElement.pause();
      this.mediaElement.removeAttribute("src");
      this.mediaElement.load();
      this.mediaElement = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    if (this.stream) {
      stopTracks(this.stream);
      this.stream = null;
    }
    disconnect(this.sourceNode);
    disconnect(this.analyser);
    disconnect(this.outputGain);
    this.sourceNode = null;
    this.analyser = null;
    this.analyserData = null;
    this.outputGain = null;
    this.source = null;
    this.label = "";
    this.analyserState = createAnalyzerState();
    this.metrics = { bass: 0, mid: 0, treble: 0, onset: false };
    if (notify) this.setState(IDLE_STATE);
  }

  private fail(requestId: number, error: Error): Error {
    if (requestId === this.requestId) {
      this.setState({ status: "error", source: null, label: "", error });
    }
    return error;
  }

  private setState(patch: Partial<AudioEngineState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.stateListeners) listener(this.state);
  }
}

function disconnect(node: AudioNode | null): void {
  if (!node) return;
  try {
    node.disconnect();
  } catch {
    // A node may already have been disconnected by a browser during teardown.
  }
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

async function resumeContext(context: AudioContext): Promise<void> {
  if (context.state === "suspended") await context.resume();
}

function normalizeCaptureError(error: Error | null, fallback: string): Error {
  if (error instanceof AudioEngineError) return error;
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return new AudioEngineError("cancelled", "Audio capture was cancelled or permission was denied.");
  }
  if (error instanceof Error) return error;
  return new AudioEngineError("failed", fallback);
}
