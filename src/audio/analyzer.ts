import type { AudioMetrics, BandMetrics, AnalyserOptions } from "./types";

export interface AnalyzerState {
  readonly smoothed: BandMetrics;
  readonly fastBass: number;
  readonly slowBass: number;
  readonly cooldownSeconds: number;
}

export interface SpectrumAnalysis {
  readonly metrics: AudioMetrics;
  readonly nextState: AnalyzerState;
  /** Unsmoothened values, useful for diagnostics and tests. */
  readonly raw: BandMetrics;
}

const DEFAULT_OPTIONS: Required<Pick<
  AnalyserOptions,
  | "attackSeconds"
  | "releaseSeconds"
  | "onsetThreshold"
  | "onsetCooldownSeconds"
>> = {
  attackSeconds: 0.045,
  releaseSeconds: 0.24,
  onsetThreshold: 0.08,
  onsetCooldownSeconds: 0.13,
};

export const DEFAULT_BANDS = {
  bass: [20, 250],
  mid: [250, 4_000],
  treble: [4_000, 20_000],
} as const;

export function createAnalyzerState(): AnalyzerState {
  return {
    smoothed: { bass: 0, mid: 0, treble: 0 },
    fastBass: 0,
    slowBass: 0,
    cooldownSeconds: 0,
  };
}

function clamp(value: number, low = 0, high = 1): number {
  return Math.min(high, Math.max(low, value));
}

function exponentialFactor(seconds: number, deltaSeconds: number): number {
  if (seconds <= 0) return 1;
  return 1 - Math.exp(-Math.max(0, deltaSeconds) / seconds);
}

function smooth(previous: number, target: number, deltaSeconds: number, options: Required<
  Pick<AnalyserOptions, "attackSeconds" | "releaseSeconds">
>): number {
  const seconds = target >= previous ? options.attackSeconds : options.releaseSeconds;
  return previous + (target - previous) * exponentialFactor(seconds, deltaSeconds);
}

/**
 * Read one FFT frame into perceptual bands.
 *
 * FFT bins are linearly spaced, while hearing is approximately logarithmic.
 * Each bin is therefore weighted by its log-frequency width (the ratio of
 * adjacent bin frequencies), making low and high octaves contribute fairly
 * without requiring a second FFT. Input values can be byte FFT values (0..255)
 * or normalized magnitudes (0..1); both are normalized to 0..1 here.
 *
 * This function is pure: the caller supplies the previous state and receives a
 * new state. That keeps the browser engine thin and makes analysis deterministic
 * in unit tests.
 */
export function analyzeSpectrum(
  spectrum: ArrayLike<number>,
  sampleRate: number,
  fftSize: number,
  previous: AnalyzerState = createAnalyzerState(),
  deltaSeconds = 1 / 60,
  options: AnalyserOptions = {},
): SpectrumAnalysis {
  const settings = { ...DEFAULT_OPTIONS, ...options };
  const byteInput = options.inputScale === "byte"
    || (options.inputScale === undefined && spectrum instanceof Uint8Array);
  const nyquist = sampleRate / 2;
  const binWidth = sampleRate / Math.max(1, fftSize);
  const bandEnergy = (lowHz: number, highHz: number): number => {
    const lowBin = Math.max(1, Math.ceil(lowHz / binWidth));
    const highBin = Math.min(spectrum.length - 1, Math.floor(highHz / binWidth));
    if (highBin < lowBin || nyquist <= 0) return 0;

    // Integrate over log frequency. A bin's width in log-frequency is nearly
    // constant for high frequencies, but using the exact width also handles
    // the first and last partial bins correctly.
    let weightedEnergy = 0;
    let totalWeight = 0;
    for (let bin = lowBin; bin <= highBin; bin += 1) {
      const frequency = Math.min(nyquist, Math.max(bin * binWidth, Number.EPSILON));
      const nextFrequency = Math.min(nyquist, Math.max((bin + 1) * binWidth, frequency));
      const logWidth = Math.max(0, Math.log(nextFrequency / frequency));
      const value = spectrum[bin] ?? 0;
      // ByteFrequencyData is scaled to 0..255. Float input is conventionally
      // 0..1, so accepting both makes this helper convenient in tests.
      const normalized = byteInput ? clamp(value / 255) : clamp(value);
      // Squared magnitude represents energy and makes quiet bins contribute
      // less than loud bins. Keep a tiny floor to avoid zero-weight frames.
      weightedEnergy += normalized * normalized * logWidth;
      totalWeight += logWidth;
    }
    return totalWeight > 0 ? Math.sqrt(weightedEnergy / totalWeight) : 0;
  };

  const raw: BandMetrics = {
    bass: clamp(bandEnergy(...DEFAULT_BANDS.bass) * Math.max(0, options.sensitivity ?? 1)),
    mid: clamp(bandEnergy(...DEFAULT_BANDS.mid) * Math.max(0, options.sensitivity ?? 1)),
    treble: clamp(bandEnergy(...DEFAULT_BANDS.treble) * Math.max(0, options.sensitivity ?? 1)),
  };
  const smoothing = {
    attackSeconds: settings.attackSeconds,
    releaseSeconds: settings.releaseSeconds,
  };
  const smoothed: BandMetrics = {
    bass: smooth(previous.smoothed.bass, raw.bass, deltaSeconds, smoothing),
    mid: smooth(previous.smoothed.mid, raw.mid, deltaSeconds, smoothing),
    treble: smooth(previous.smoothed.treble, raw.treble, deltaSeconds, smoothing),
  };

  // Two envelopes distinguish an onset from a sustained bass note. The fast
  // envelope catches attacks; the slow envelope is the local noise floor.
  const fastBass = previous.fastBass + (raw.bass - previous.fastBass) * exponentialFactor(0.055, deltaSeconds);
  const slowBass = previous.slowBass + (raw.bass - previous.slowBass) * exponentialFactor(0.65, deltaSeconds);
  const cooldownSeconds = Math.max(0, previous.cooldownSeconds - Math.max(0, deltaSeconds));
  const onset = cooldownSeconds === 0
    && raw.bass >= settings.onsetThreshold
    && raw.bass > fastBass * 1.12
    && raw.bass > slowBass * 1.2;

  return {
    raw,
    metrics: { ...smoothed, onset },
    nextState: {
      smoothed,
      fastBass,
      slowBass,
      cooldownSeconds: onset ? settings.onsetCooldownSeconds : cooldownSeconds,
    },
  };
}
