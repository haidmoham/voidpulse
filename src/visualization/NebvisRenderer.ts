import * as THREE from "three";

/** The deliberately finite palette avoids hue-cycling while still giving observations a character. */
export type ObservationPaletteMode = "event-horizon" | "false-color" | "spectral";

export interface NebvisFrameInput {
  /** Raw analyser magnitudes (0–255 or normalized). Any FFT length is accepted. */
  fft?: ArrayLike<number>;
  /** A discrete observation onset. Rising values trigger a light echo. */
  echoOnset?: number;
  /** Optional transient punctuation for the bipolar jets, from 0 to 1. */
  jetPulse?: number;
  /** Broad scene energy, from 0 to 1. Used when FFT data is absent. */
  intensity?: number;
}

export interface NebvisRendererOptions {
  canvas: HTMLCanvasElement;
  palette?: ObservationPaletteMode;
  /** Hard upper cap; the implementation applies a lower cap on small screens. */
  particleCount?: number;
  /** Caps device pixel ratio so a high-density display cannot exhaust the GPU. */
  dprCap?: number;
  /** Defaults to the OS preference. True renders a composed, non-animated frame. */
  reducedMotion?: boolean;
  /** Enables a transparent canvas for compositing into a React view. */
  transparent?: boolean;
}

export interface NebvisRendererApi {
  start(): void;
  stop(): void;
  update(input?: NebvisFrameInput): void;
  resize(): void;
  setPalette(palette: ObservationPaletteMode): void;
  setReducedMotion(reduced: boolean): void;
  renderStatic(): void;
  destroy(): void;
}

type Bands = { bass: number; mid: number; high: number; air: number };

const PALETTES = {
  "event-horizon": [0x08010f, 0xff2a6d, 0xff9a2e, 0xf9f4d2],
  "false-color": [0x05001a, 0x7a2cff, 0x00d6ff, 0xf7ef74],
  spectral: [0x020b12, 0x1df5b5, 0x00a8ff, 0xff4d8d],
} satisfies Record<ObservationPaletteMode, readonly [number, number, number, number]>;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const damp = (current: number, target: number, lambda: number, dt: number) =>
  THREE.MathUtils.damp(current, target, lambda, dt);

/**
 * Map FFT data by fractional frequency ranges rather than fixed bin indexes.
 * This makes the result invariant to AnalyserNode fftSize changes. RMS also keeps
 * a single hot bin from twitching the scene.
 */
export function mapFftBands(fft?: ArrayLike<number>): Bands {
  if (!fft || fft.length === 0) return { bass: 0, mid: 0, high: 0, air: 0 };
  const values = Array.from({ length: fft.length }, (_, index) => Number(fft[index]) || 0);
  const scale = values.some((value) => value > 1.5) ? 255 : 1;
  const rms = (from: number, to: number) => {
    const begin = Math.max(0, Math.floor(values.length * from));
    const end = Math.max(begin + 1, Math.ceil(values.length * to));
    let sum = 0;
    for (let index = begin; index < end; index += 1) {
      const value = values[index] ?? 0;
      sum += (value / scale) ** 2;
    }
    return clamp01(Math.sqrt(sum / (end - begin)));
  };
  return { bass: rms(0.005, 0.06), mid: rms(0.06, 0.24), high: rms(0.24, 0.58), air: rms(0.58, 0.98) };
}

const dustVertex = /* glsl */ `
  attribute float aSeed;
  attribute float aSize;
  uniform float uTime;
  uniform float uEnergy;
  uniform float uPixelRatio;
  varying float vGlow;
  void main() {
    vec3 pos = position;
    float swirl = atan(pos.z, pos.x) + uTime * (0.035 + aSeed * 0.025);
    float radius = length(pos.xz) * (1.0 + uEnergy * 0.10);
    pos.x = cos(swirl) * radius;
    pos.z = sin(swirl) * radius;
    pos.y += sin(uTime * 0.18 + aSeed * 13.0) * (1.5 + uEnergy * 4.0);
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uPixelRatio * (92.0 / max(1.0, -mv.z));
    vGlow = 0.38 + aSeed * 0.62;
  }
`;

const dustFragment = /* glsl */ `
  uniform vec3 uInner;
  uniform vec3 uOuter;
  uniform float uEnergy;
  varying float vGlow;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float halo = smoothstep(0.5, 0.0, length(uv));
    float core = pow(halo, 3.0);
    vec3 color = mix(uInner, uOuter, vGlow) * (0.38 + uEnergy * 1.3);
    gl_FragColor = vec4(color + uOuter * core * 0.35, halo * (0.20 + vGlow * 0.46));
  }
`;

const coreVertex = /* glsl */ `
  uniform float uTime;
  uniform float uEnergy;
  varying vec3 vNormal;
  void main() {
    vNormal = normal;
    vec3 p = position;
    float shear = sin(atan(p.z, p.x) * 5.0 - uTime * 0.45) * (0.7 + uEnergy * 1.8);
    p += normal * shear;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const coreFragment = /* glsl */ `
  uniform vec3 uHot;
  uniform vec3 uWhite;
  uniform float uEnergy;
  varying vec3 vNormal;
  void main() {
    float rim = pow(1.0 - abs(vNormal.z), 2.2);
    float glow = 0.35 + rim * (1.3 + uEnergy * 1.2);
    gl_FragColor = vec4(mix(uHot, uWhite, rim * 0.54) * glow, 1.0);
  }
`;

const makeRing = (inner: number, outer: number, color: number, opacity: number) => {
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(new THREE.RingGeometry(inner, outer, 96), material);
};

interface EchoState {
  readonly mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  readonly speed: number;
  startedAt: number;
}

/**
 * A direct, framework-neutral Three renderer. React should create it in an effect,
 * feed `update` from the audio loop, and call `destroy` in the effect cleanup.
 */
export class NebvisRenderer implements NebvisRendererApi {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(48, 1, 0.1, 900);

  private readonly canvas: HTMLCanvasElement;
  private readonly coreMaterial: THREE.ShaderMaterial;
  private readonly disk: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly photonRing: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly echoes: EchoState[] = [];
  private readonly jets: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>[] = [];
  private readonly fog: THREE.FogExp2;
  private readonly colorInner = new THREE.Color();
  private readonly colorOuter = new THREE.Color();
  private readonly colorHot = new THREE.Color();
  private readonly colorWhite = new THREE.Color();
  private readonly dustUniforms = {
    uTime: { value: 0 },
    uEnergy: { value: 0 },
    uPixelRatio: { value: 1 },
    uInner: { value: this.colorInner },
    uOuter: { value: this.colorOuter },
  };
  private readonly coreUniforms = {
    uTime: { value: 0 },
    uEnergy: { value: 0 },
    uHot: { value: this.colorHot },
    uWhite: { value: this.colorWhite },
  };
  private readonly resizeObserver: ResizeObserver;
  private readonly visibilityHandler: () => void;
  private frameId = 0;
  private wantsRun = false;
  private destroyed = false;
  private reducedMotion: boolean;
  private dprCap: number;
  private elapsed = 0;
  private lastFrameTime = 0;
  private echoCursor = 0;
  private lastEchoOnset = 0;
  private jetPulse = 0;
  private bands: Bands = { bass: 0, mid: 0, high: 0, air: 0 };
  private targetBands: Bands = { bass: 0, mid: 0, high: 0, air: 0 };

  constructor(options: NebvisRendererOptions) {
    this.canvas = options.canvas;
    this.dprCap = Math.max(1, Math.min(options.dprCap ?? 1.75, 2));
    this.reducedMotion = options.reducedMotion
      ?? window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      alpha: options.transparent ?? false,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(PALETTES[options.palette ?? "event-horizon"][0], options.transparent ? 0 : 1);
    this.camera.position.set(0, 22, 154);
    this.camera.lookAt(0, 0, 0);
    this.fog = new THREE.FogExp2(PALETTES[options.palette ?? "event-horizon"][0], 0.0045);
    this.scene.fog = this.fog;

    const dust = this.makeDust(options.particleCount);
    this.scene.add(dust);

    this.coreMaterial = new THREE.ShaderMaterial({
      uniforms: this.coreUniforms,
      vertexShader: coreVertex,
      fragmentShader: coreFragment,
      blending: THREE.AdditiveBlending,
    });
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(11, 3), this.coreMaterial);
    core.scale.set(1.12, 0.56, 1.12);
    this.scene.add(core);

    this.disk = makeRing(14, 48, 0xffffff, 0.52);
    this.disk.rotation.x = Math.PI / 2.48;
    this.disk.scale.y = 0.39;
    this.scene.add(this.disk);
    this.photonRing = makeRing(12.7, 14.1, 0xffffff, 0.88);
    this.photonRing.rotation.copy(this.disk.rotation);
    this.photonRing.scale.copy(this.disk.scale);
    this.scene.add(this.photonRing);

    for (let index = 0; index < 3; index += 1) {
      const echo = makeRing(0.96, 1, 0xffffff, 0);
      echo.rotation.x = Math.PI / 2;
      echo.visible = false;
      this.echoes.push({
        mesh: echo,
        speed: 24 + index * 8,
        startedAt: Number.NEGATIVE_INFINITY,
      });
      this.scene.add(echo);
    }

    for (const direction of [-1, 1]) {
      const material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      const jet = new THREE.Mesh(new THREE.ConeGeometry(5.5, 70, 16, 1, true), material);
      jet.position.y = direction * 36;
      if (direction < 0) jet.rotation.z = Math.PI;
      this.jets.push(jet);
      this.scene.add(jet);
    }

    this.setPalette(options.palette ?? "event-horizon");
    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
    this.visibilityHandler = () => {
      if (document.hidden) this.stopLoop();
      else if (this.wantsRun && !this.reducedMotion) this.startLoop();
      else this.renderStatic();
    };
    document.addEventListener("visibilitychange", this.visibilityHandler);
    this.renderStatic();
  }

  start(): void {
    this.wantsRun = true;
    if (!this.reducedMotion && !document.hidden) this.startLoop();
    else this.renderStatic();
  }

  stop(): void {
    this.wantsRun = false;
    this.stopLoop();
  }

  update(input: NebvisFrameInput = {}): void {
    this.targetBands = input.fft ? mapFftBands(input.fft) : {
      bass: clamp01(input.intensity ?? 0), mid: clamp01((input.intensity ?? 0) * 0.72), high: clamp01((input.intensity ?? 0) * 0.48), air: clamp01((input.intensity ?? 0) * 0.26),
    };
    if ((input.echoOnset ?? 0) > 0.72 && this.lastEchoOnset <= 0.72) this.triggerEcho();
    this.lastEchoOnset = input.echoOnset ?? 0;
    this.jetPulse = Math.max(this.jetPulse, clamp01(input.jetPulse ?? 0));
    // The internal loop owns animated time. A caller can also use the renderer
    // without `start()` for a useful, one-frame observation preview.
    if (this.reducedMotion || !this.wantsRun) {
      this.applyFrame(this.jetPulse, 0);
      this.renderStatic();
    }
  }

  resize(): void {
    const width = Math.max(1, this.canvas.clientWidth || this.canvas.width || 1);
    const height = Math.max(1, this.canvas.clientHeight || this.canvas.height || 1);
    const smallViewport = Math.min(window.innerWidth, window.innerHeight) < 700;
    const cap = smallViewport ? Math.min(this.dprCap, 1.5) : this.dprCap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.dustUniforms.uPixelRatio.value = this.renderer.getPixelRatio();
    this.renderStatic();
  }

  setPalette(palette: ObservationPaletteMode): void {
    const [background, inner, outer, white] = PALETTES[palette];
    this.colorInner.setHex(inner);
    this.colorOuter.setHex(outer);
    this.colorHot.setHex(inner).lerp(this.colorOuter, 0.45);
    this.colorWhite.setHex(white);
    this.renderer.setClearColor(background, this.renderer.getClearAlpha());
    this.fog.color.setHex(background);
    this.dustUniforms.uInner.value.copy(this.colorInner);
    this.dustUniforms.uOuter.value.copy(this.colorOuter);
    this.coreUniforms.uHot.value.copy(this.colorHot);
    this.coreUniforms.uWhite.value.copy(this.colorWhite);
    this.disk?.material.color.copy(this.colorHot);
    this.photonRing?.material.color.copy(this.colorWhite);
    this.echoes.forEach((echo) => echo.mesh.material.color.copy(this.colorOuter));
    this.jets.forEach((jet) => jet.material.color.copy(this.colorOuter));
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    if (reduced) this.stopLoop();
    else if (this.wantsRun && !document.hidden) this.startLoop();
    this.renderStatic();
  }

  renderStatic(): void {
    if (!this.destroyed) this.renderer.render(this.scene, this.camera);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopLoop();
    this.resizeObserver.disconnect();
    document.removeEventListener("visibilitychange", this.visibilityHandler);
    this.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      const { material } = object;
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
      else material?.dispose();
    });
    this.renderer.dispose();
  }

  private makeDust(requestedCount = 32_000): THREE.Points {
    const mobile = Math.min(window.innerWidth, window.innerHeight) < 700;
    const count = Math.max(4_000, Math.min(requestedCount, mobile ? 15_000 : 40_000));
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    const sizes = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      const arm = index % 5;
      const radius = 24 + Math.pow(Math.random(), 0.52) * 188;
      const angle = arm * (Math.PI * 2 / 5) + radius * 0.043 + (Math.random() - 0.5) * 0.95;
      positions[index * 3] = Math.cos(angle) * radius;
      positions[index * 3 + 1] = (Math.random() - 0.5) * (7 + radius * 0.19);
      positions[index * 3 + 2] = Math.sin(angle) * radius;
      seeds[index] = Math.random();
      sizes[index] = 1.4 + Math.random() * 3.8;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
    geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    const material = new THREE.ShaderMaterial({
      uniforms: this.dustUniforms,
      vertexShader: dustVertex,
      fragmentShader: dustFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    return new THREE.Points(geometry, material);
  }

  private triggerEcho(): void {
    const echo = this.echoes[this.echoCursor++ % this.echoes.length];
    if (!echo) return;
    echo.startedAt = this.elapsed;
    echo.mesh.visible = true;
  }

  private startLoop(): void {
    if (!this.frameId && !this.destroyed) {
      this.lastFrameTime = 0;
      this.frameId = requestAnimationFrame(this.tick);
    }
  }

  private stopLoop(): void {
    if (this.frameId) cancelAnimationFrame(this.frameId);
    this.frameId = 0;
  }

  private readonly tick = (time: number) => {
    this.frameId = 0;
    if (this.destroyed || !this.wantsRun || this.reducedMotion || document.hidden) return;
    const dt = this.lastFrameTime === 0
      ? 1 / 60
      : Math.min(Math.max((time - this.lastFrameTime) / 1_000, 0), 0.05);
    this.lastFrameTime = time;
    this.applyFrame(0, dt);
    this.renderer.render(this.scene, this.camera);
    this.frameId = requestAnimationFrame(this.tick);
  };

  private applyFrame(jetPulse: number, dt: number): void {
    this.elapsed += dt;
    this.bands = {
      bass: damp(this.bands.bass, this.targetBands.bass, this.targetBands.bass > this.bands.bass ? 18 : 4.5, dt),
      mid: damp(this.bands.mid, this.targetBands.mid, this.targetBands.mid > this.bands.mid ? 14 : 4, dt),
      high: damp(this.bands.high, this.targetBands.high, this.targetBands.high > this.bands.high ? 12 : 3.5, dt),
      air: damp(this.bands.air, this.targetBands.air, this.targetBands.air > this.bands.air ? 10 : 3, dt),
    };
    const energy = clamp01(this.bands.bass * 0.58 + this.bands.mid * 0.27 + this.bands.high * 0.15);
    this.dustUniforms.uTime.value = this.elapsed;
    this.dustUniforms.uEnergy.value = energy;
    this.coreUniforms.uTime.value = this.elapsed;
    this.coreUniforms.uEnergy.value = energy;
    this.disk.rotation.z = this.elapsed * (0.18 + energy * 0.12);
    this.photonRing.rotation.z = this.disk.rotation.z * 1.24;
    const diskScale = 1 + energy * 0.12;
    this.disk.scale.set(1.0 * diskScale, 0.39 * diskScale, 1.0 * diskScale);
    this.photonRing.scale.copy(this.disk.scale);
    this.camera.position.x = Math.sin(this.elapsed * 0.08) * (this.reducedMotion ? 0 : 3);
    this.camera.position.y = 22 + energy * 4;
    this.camera.lookAt(0, 0, 0);

    for (const echo of this.echoes) {
      const age = this.elapsed - echo.startedAt;
      if (age < 0 || age > 2.4) { echo.mesh.visible = false; continue; }
      const progress = age / 2.4;
      const radius = 18 + progress * echo.speed * 5.2;
      echo.mesh.scale.setScalar(radius);
      echo.mesh.material.opacity = (1 - progress) * (0.42 + this.bands.high * 0.38);
    }
    const jet = clamp01(jetPulse * 0.7 + this.bands.air * 0.32 + this.bands.high * 0.18);
    this.jets.forEach((mesh) => {
      mesh.material.opacity = jet * 0.68;
      mesh.scale.set(0.64 + jet * 0.88, 0.68 + jet * 1.65, 0.64 + jet * 0.88);
    });
    this.jetPulse = Math.max(0, jetPulse - dt * 1.8);
  }
}
