/** The real audio sources understood by the visualizer. */
export type AudioSourceKind = "microphone" | "display" | "file";

export type AudioEngineStatus =
  | "idle"
  | "requesting"
  | "active"
  | "paused"
  | "error";

export interface AudioEngineState {
  readonly status: AudioEngineStatus;
  readonly source: AudioSourceKind | null;
  readonly label: string;
  readonly error: Error | null;
}

export interface BandMetrics {
  readonly bass: number;
  readonly mid: number;
  readonly treble: number;
}

export interface AudioMetrics extends BandMetrics {
  /** True for one analysis tick when a new low-frequency onset is detected. */
  readonly onset: boolean;
}

export type AudioStateListener = (state: AudioEngineState) => void;
export type AudioOnsetListener = (metrics: AudioMetrics) => void;

export interface AudioEngineOptions {
  /** Injected in tests; production code uses the browser's AudioContext. */
  readonly audioContextFactory?: () => AudioContext;
  /** Injected in tests; production code uses navigator.mediaDevices. */
  readonly mediaDevices?: Pick<MediaDevices, "getUserMedia" | "getDisplayMedia">;
  readonly analyser?: AnalyserOptions;
}

export interface AnalyserOptions {
  /** Spectrum representation; omitted auto-detects Uint8Array as byte data. */
  readonly inputScale?: "byte" | "normalized";
  readonly fftSize?: number;
  readonly minDecibels?: number;
  readonly maxDecibels?: number;
  /** Attack and release time constants for visual smoothing, in seconds. */
  readonly attackSeconds?: number;
  readonly releaseSeconds?: number;
  /** Minimum normalized bass energy required for an onset. */
  readonly onsetThreshold?: number;
  /** Refractory period after an onset, in seconds. */
  readonly onsetCooldownSeconds?: number;
  /** Multiplier applied after band extraction; useful for visual reactivity. */
  readonly sensitivity?: number;
}
