import {
  Crosshair,
  FileAudio,
  Mic2,
  Pause,
  Play,
  RadioTower,
  Sparkles,
  Square,
  Volume2,
  Waves,
  X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  AudioEngine,
  type AudioEngineState,
  type AudioMetrics,
  type AudioSourceKind,
} from "./audio";
import {
  NebvisRenderer,
  type NebvisRendererApi,
  type ObservationPaletteMode,
} from "./visualization";

const ZERO_METRICS: AudioMetrics = {
  bass: 0,
  mid: 0,
  treble: 0,
  onset: false,
};

const OBSERVATION_MODES = [
  {
    id: "event-horizon",
    index: "01",
    name: "EVENT HORIZON",
    wavelength: "656.3 NM",
  },
  {
    id: "false-color",
    index: "02",
    name: "FALSE COLOR",
    wavelength: "4.44 μM",
  },
  {
    id: "spectral",
    index: "03",
    name: "SPECTRAL",
    wavelength: "21 CM",
  },
] as const satisfies ReadonlyArray<{
  id: ObservationPaletteMode;
  index: string;
  name: string;
  wavelength: string;
}>;

const SOURCE_LABELS = {
  display: "SHARED TAB",
  microphone: "MICROPHONE",
  file: "LOCAL FILE",
} satisfies Record<AudioSourceKind, string>;

function useAudioState(engine: AudioEngine): AudioEngineState {
  const [state, setState] = useState<AudioEngineState>(() => engine.getState());

  useEffect(() => engine.subscribe(setState), [engine]);
  return state;
}

function formatSignal(value: number): string {
  return Math.round(Math.max(0, Math.min(1, value)) * 100)
    .toString()
    .padStart(2, "0");
}

export function App() {
  const engine = useMemo(() => new AudioEngine({
    analyser: {
      fftSize: 1_024,
      attackSeconds: 0.04,
      releaseSeconds: 0.3,
      onsetThreshold: 0.07,
      onsetCooldownSeconds: 0.17,
      sensitivity: 1.22,
    },
  }), []);
  const audioState = useAudioState(engine);
  const reducedMotion = useReducedMotion() ?? false;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<NebvisRendererApi | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [palette, setPalette] = useState<ObservationPaletteMode>("event-horizon");
  const [metrics, setMetrics] = useState<AudioMetrics>(ZERO_METRICS);
  const [demoActive, setDemoActive] = useState(true);
  const [signalPanelOpen, setSignalPanelOpen] = useState(true);
  const [webGlFailed, setWebGlFailed] = useState(false);
  const [volume, setVolume] = useState(0.72);
  const active = audioState.status === "active";
  const requesting = audioState.status === "requesting";
  const observing = active || demoActive;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    try {
      const renderer = new NebvisRenderer({
        canvas,
        palette,
        reducedMotion,
        particleCount: 38_000,
        dprCap: 1.75,
      });
      rendererRef.current = renderer;
      renderer.start();
      setWebGlFailed(false);

      return () => {
        renderer.destroy();
        rendererRef.current = null;
      };
    } catch {
      setWebGlFailed(true);
      rendererRef.current = null;
    }
  }, [reducedMotion]);

  useEffect(() => {
    rendererRef.current?.setPalette(palette);
  }, [palette]);

  useEffect(() => {
    return () => engine.stop();
  }, [engine]);

  useEffect(() => {
    let frameId = 0;
    let lastUiUpdate = 0;
    let previousDemoPulse = false;

    const tick = (now: number) => {
      let nextMetrics = ZERO_METRICS;
      let fft: Uint8Array<ArrayBuffer> | undefined;

      if (engine.isPlaying()) {
        nextMetrics = engine.bands();
        fft = engine.rawFrequencyData() ?? undefined;
      } else if (demoActive) {
        const seconds = now / 1_000;
        const beat = (seconds * 0.46) % 1;
        const pulse = Math.exp(-beat * 6.5);
        const onset = beat < 0.075 && !previousDemoPulse;
        previousDemoPulse = beat < 0.075;
        nextMetrics = {
          bass: 0.24 + pulse * 0.5 + Math.sin(seconds * 0.7) * 0.05,
          mid: 0.18 + (Math.sin(seconds * 1.3) + 1) * 0.11,
          treble: 0.11 + (Math.sin(seconds * 2.7) + 1) * 0.07,
          onset,
        };
      }

      rendererRef.current?.update({
        fft,
        intensity: nextMetrics.bass,
        echoOnset: nextMetrics.onset ? 1 : 0,
        jetPulse: nextMetrics.onset ? Math.max(nextMetrics.treble, 0.44) : 0,
      });

      if (now - lastUiUpdate > 72) {
        setMetrics(nextMetrics);
        lastUiUpdate = now;
      }
      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [demoActive, engine]);

  useEffect(() => {
    if (audioState.status === "active" || audioState.status === "paused") {
      setDemoActive(false);
      setSignalPanelOpen(false);
    }
  }, [audioState.status]);

  const startSource = useCallback(async (source: "display" | "microphone") => {
    try {
      if (source === "display") await engine.useDisplayAudio();
      else await engine.useMicrophone();
    } catch {
      setSignalPanelOpen(true);
    }
  }, [engine]);

  const handleFile = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await engine.loadFile(file);
      await engine.play();
    } catch {
      setSignalPanelOpen(true);
    } finally {
      event.target.value = "";
    }
  }, [engine]);

  const stopSource = useCallback(() => {
    engine.stop();
    setDemoActive(true);
    setSignalPanelOpen(true);
  }, [engine]);

  const toggleFilePlayback = useCallback(async () => {
    if (engine.isPlaying()) engine.pause();
    else await engine.play();
  }, [engine]);

  const changeVolume = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const nextVolume = Number(event.target.value);
    setVolume(nextVolume);
    engine.setVolume(nextVolume);
  }, [engine]);

  const activeSource = audioState.source ? SOURCE_LABELS[audioState.source] : "SYNTHETIC DEEP FIELD";
  const sourceDetail = audioState.label || (demoActive ? "SIMULATED PULSAR / NO AUDIO" : "AWAITING SIGNAL");
  const mode = OBSERVATION_MODES.find((item) => item.id === palette) ?? OBSERVATION_MODES[0];

  return (
    <main
      className="nebvis"
      data-observing={observing}
      data-palette={palette}
    >
      <canvas
        ref={canvasRef}
        className="cosmos"
        aria-label="Audio-reactive astrophysical visualization"
      />
      <div className="cosmos-fallback" data-visible={webGlFailed} aria-hidden="true" />
      <div className="noise" aria-hidden="true" />
      <div className="lens-grid" aria-hidden="true" />

      <header className="masthead">
        <button
          className="wordmark"
          type="button"
          onClick={() => setSignalPanelOpen(true)}
          aria-label="Open signal source selector"
        >
          <span className="wordmark-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>NEBVIS</span>
        </button>

        <div className="live-readout" data-live={active}>
          <span className="status-pip" />
          <span>{active ? "LIVE SIGNAL" : demoActive ? "DEEP FIELD SIM" : "NO SIGNAL"}</span>
          <span className="readout-coordinate">RA 17H 45M 40S</span>
        </div>

        <button
          type="button"
          className="signal-toggle"
          onClick={() => setSignalPanelOpen((open) => !open)}
          aria-label={signalPanelOpen ? "Close signal source selector" : "Open signal source selector"}
        >
          <RadioTower size={16} strokeWidth={2.4} />
          <span>{active ? "CHANGE SIGNAL" : "OPEN SIGNAL"}</span>
        </button>
      </header>

      <nav className="observation-modes" aria-label="Observation palette">
        <div className="mode-title">
          <Crosshair size={13} />
          OBSERVATION MODE
        </div>
        {OBSERVATION_MODES.map((item) => (
          <button
            key={item.id}
            type="button"
            className="mode-button"
            data-active={palette === item.id}
            onClick={() => setPalette(item.id)}
          >
            <span>{item.index}</span>
            <strong>{item.name}</strong>
            <small>{item.wavelength}</small>
          </button>
        ))}
      </nav>

      <motion.section
        className="hero"
        initial={reducedMotion ? false : { opacity: 0, transform: "translateY(18px)" }}
        animate={{
          opacity: observing ? 1 : 0.72,
          transform: observing ? "translateY(0px)" : "translateY(8px)",
        }}
        transition={{ duration: reducedMotion ? 0 : 0.65, ease: [0.23, 1, 0.32, 1] }}
      >
        <p className="hero-kicker">
          <Sparkles size={13} />
          AUDIO ASTRONOMY ARRAY / 001
        </p>
        <h1>
          TURN SOUND
          <span>INTO GRAVITY</span>
        </h1>
        <p className="hero-deck">
          A browser-born observatory for the invisible mass inside music.
        </p>
      </motion.section>

      <section className="spectral-telemetry" aria-label="Live spectral telemetry">
        <div className="telemetry-header">
          <span>RELATIVE FLUX</span>
          <span>LOCAL ANALYSIS</span>
        </div>
        <SignalBand label="LOW / MASS" value={metrics.bass} color="hot" />
        <SignalBand label="MID / DUST" value={metrics.mid} color="ion" />
        <SignalBand label="HIGH / LIGHT" value={metrics.treble} color="star" />
      </section>

      <section className="source-status" aria-live="polite">
        <span className="status-number">SIG.{active ? "01" : "00"}</span>
        <div>
          <small>{activeSource}</small>
          <strong>{sourceDetail}</strong>
        </div>
        {audioState.source === "file" && (
          <button
            type="button"
            className="icon-button"
            onClick={() => void toggleFilePlayback()}
            aria-label={engine.isPlaying() ? "Pause audio file" : "Play audio file"}
          >
            {engine.isPlaying() ? <Pause size={15} /> : <Play size={15} />}
          </button>
        )}
        {active && (
          <button
            type="button"
            className="icon-button"
            onClick={stopSource}
            aria-label="Stop audio capture"
          >
            <Square size={13} fill="currentColor" />
          </button>
        )}
      </section>

      <footer className="footer-note">
        <span>NO AUDIO LEAVES THIS BROWSER</span>
        <span>{mode.name} / {mode.wavelength}</span>
      </footer>

      <AnimatePresence>
        {signalPanelOpen && (
          <motion.aside
            className="signal-panel"
            initial={reducedMotion ? false : { opacity: 0, transform: "translateY(24px) scale(0.98)" }}
            animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
            exit={{ opacity: 0, transform: "translateY(12px) scale(0.985)" }}
            transition={{ duration: reducedMotion ? 0 : 0.24, ease: [0.23, 1, 0.32, 1] }}
            aria-labelledby="signal-heading"
          >
            <div className="panel-stripe" aria-hidden="true" />
            <div className="panel-heading">
              <div>
                <span>SIGNAL ACQUISITION</span>
                <h2 id="signal-heading">WHAT ARE<br />WE LISTENING TO?</h2>
              </div>
              <button
                type="button"
                className="panel-close"
                onClick={() => setSignalPanelOpen(false)}
                aria-label="Close source selector"
              >
                <X size={20} />
              </button>
            </div>

            <button
              type="button"
              className="source-primary"
              onClick={() => void startSource("display")}
              disabled={requesting}
            >
              <span className="source-icon"><RadioTower size={28} /></span>
              <span>
                <small>CHROME / EDGE</small>
                <strong>{requesting && audioState.source === "display" ? "OPENING PICKER…" : "SHARE A MUSIC TAB"}</strong>
                <em>Select a tab and enable “share tab audio.”</em>
              </span>
              <span className="source-arrow" aria-hidden="true">↗</span>
            </button>

            <div className="source-secondary">
              <button
                type="button"
                onClick={() => void startSource("microphone")}
                disabled={requesting}
              >
                <Mic2 size={19} />
                <span><strong>MICROPHONE</strong><small>ROOM SIGNAL</small></span>
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={requesting}
              >
                <FileAudio size={19} />
                <span><strong>AUDIO FILE</strong><small>LOCAL PLAYBACK</small></span>
              </button>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              hidden
              onChange={(event) => void handleFile(event)}
            />

            {audioState.source === "file" && (
              <label className="volume-control">
                <Volume2 size={15} />
                <span>OUTPUT</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={volume}
                  onChange={changeVolume}
                />
                <output>{Math.round(volume * 100)}</output>
              </label>
            )}

            {audioState.error && (
              <div className="signal-error" role="alert">
                <Waves size={17} />
                <span>{audioState.error.message}</span>
              </div>
            )}

            <button
              type="button"
              className="demo-button"
              onClick={() => {
                engine.stop();
                setDemoActive(true);
                setSignalPanelOpen(false);
              }}
            >
              <span>NO AUDIO YET?</span>
              ENTER THE SYNTHETIC DEEP FIELD
            </button>
          </motion.aside>
        )}
      </AnimatePresence>
    </main>
  );
}

function SignalBand({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: "hot" | "ion" | "star";
}) {
  return (
    <div className="signal-band" data-color={color}>
      <span>{label}</span>
      <div className="band-track">
        <i style={{ transform: `scaleX(${Math.max(0.025, Math.min(1, value))})` }} />
      </div>
      <output>{formatSignal(value)}</output>
    </div>
  );
}
