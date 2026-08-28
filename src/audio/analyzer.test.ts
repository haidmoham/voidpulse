import { describe, expect, it } from "vitest";
import { analyzeSpectrum, createAnalyzerState } from "./analyzer";

function frame(fill: (frequencyHz: number) => number): Uint8Array {
  const fftSize = 1_024;
  const sampleRate = 48_000;
  const spectrum = new Uint8Array(fftSize / 2);
  for (let bin = 1; bin < spectrum.length; bin += 1) {
    spectrum[bin] = fill((bin * sampleRate) / fftSize);
  }
  return spectrum;
}

describe("analyzeSpectrum", () => {
  it("extracts bass, mid, and treble from logarithmic frequency bands", () => {
    const spectrum = frame((frequency) => {
      if (frequency < 250) return 255;
      if (frequency < 4_000) return 128;
      return 64;
    });
    const result = analyzeSpectrum(spectrum, 48_000, 1_024, createAnalyzerState(), 1);

    expect(result.raw.bass).toBeGreaterThan(0.98);
    expect(result.raw.mid).toBeGreaterThan(0.48);
    expect(result.raw.mid).toBeLessThan(0.53);
    expect(result.raw.treble).toBeGreaterThan(0.23);
    expect(result.raw.treble).toBeLessThan(0.27);
  });

  it("emits a single onset for a bass attack and observes cooldown", () => {
    const bassHit = frame((frequency) => (frequency < 250 ? 255 : 0));
    const quiet = frame(() => 0);
    const first = analyzeSpectrum(bassHit, 48_000, 1_024, createAnalyzerState(), 1 / 60);
    const second = analyzeSpectrum(quiet, 48_000, 1_024, first.nextState, 1 / 60);

    expect(first.metrics.onset).toBe(true);
    expect(second.metrics.onset).toBe(false);
    expect(second.nextState.cooldownSeconds).toBeGreaterThan(0);
  });
});
