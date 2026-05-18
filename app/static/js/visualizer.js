import * as THREE from "three";
import { EffectComposer }  from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass }      from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass }      from "three/addons/postprocessing/OutputPass.js";
import { OrbitControls }   from "three/addons/controls/OrbitControls.js";

let PARTICLE_COUNT = 60000;
const COLOR_BG     = 0x08001a;
const BASE_INNER_H = 0.556;
const BASE_OUTER_H = 0.840;

// Deformable grid constants. Depth & center are tuned so the front edge sits
// just behind the camera (Z=+300) at max zoom out (camera Z=250) — eliminates
// the black band that used to appear below the floor when zoomed all the way
// out. ROWS bumps proportionally so row spacing stays at ~12 units (preserves
// the original scroll cadence).
const GRID_COLS      = 64;   // frequency bins left→right
const GRID_ROWS      = 46;   // depth slices front→back
const GRID_WIDTH     = 900;
const GRID_DEPTH     = 560;
const GRID_Z_CENTER  = 20;   // world-Z of grid midpoint (front edge = +300)
// Floor tuning defaults — overridable via the tuning panel (fMaxH, fScroll, …).
const FLOOR_DEFAULTS = {
  fMaxH:       30,    // max vertex lift (units)
  fScroll:      5,    // base scroll speed toward camera
  fScrollBass: 22,    // extra scroll speed driven by bass
  fDecay:    0.80,    // peak fall rate (lower = faster decay)
  fHotCurve:  2.5,    // white-hot bleach curve (higher = harder to bleach)
};

// Named camera positions used by cinematic mode. Each is an absolute world-
// space (position, lookAt) pair; the render loop lerps the live camera
// toward whichever scene is active. "front" mirrors the default angle the
// app boots with so toggling cinematic off snaps cleanly back to it.
const CAMERA_SCENES = {
  front: { pos: [   0,  12, 135], look: [ 0,  -6, 0] },
  top:   { pos: [   0, 145,  35], look: [ 0,   0, 0] },
  side:  { pos: [ 145,   8,   0], look: [ 0,   0, 0] },
  tilt:  { pos: [ -95,  85,  95], look: [ 0,   0, 0] },
  close: { pos: [   0,   8,  72], look: [ 0,  -4, 0] },
  wide:  { pos: [   0,  28, 230], look: [ 0, -10, 0] },
};

// Bloom defaults — UnrealBloomPass.
// bStrength is pre-transformed: slider raw 0.395 → pow(0.395, 2.2) ≈ 0.13.
const BLOOM_DEFAULTS = {
  bStrength:  0.13,
  bRadius:    0.39,
  bThreshold: 0.71,
};

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uBass;
  uniform float uMid;
  uniform float uTreble;
  // Per-channel bands — used when uStereoParticles > 0 to drive the left
  // hemisphere of the cloud from the L channel and right from R.
  uniform float uBassL;
  uniform float uMidL;
  uniform float uTrebleL;
  uniform float uBassR;
  uniform float uMidR;
  uniform float uTrebleR;
  uniform float uStereoParticles;  // 0 = mono, 1 = full L/R hemisphere split
  uniform float uBurst;
  uniform float uEcho;
  uniform float uScatter;
  uniform float uPixelRatio;
  uniform float uBreatheMin;
  uniform float uBreatheMax;
  uniform float uBreatheCurve;
  uniform float uSizeMin;
  uniform float uSizeMax;
  uniform float uSizeCurve;
  uniform float uShapeMix;
  uniform float uFlowStrength;   // tuning panel multiplier for flow amplitude
  // Audio-reactive gravity wells — particles drift toward each active point.
  uniform vec3  uAttrPos0;
  uniform vec3  uAttrPos1;
  uniform vec3  uAttrPos2;
  uniform vec3  uAttrPos3;
  uniform vec3  uAttrPos4;
  uniform vec3  uAttrPos5;
  uniform vec3  uAttrPos6;
  uniform vec3  uAttrPos7;
  uniform vec3  uAttrPos8;
  uniform float uAttrCount;  // active well count (0–9)
  uniform float uAttrStr;    // global pull strength
  attribute float aSize;
  attribute float aLayer;        // 0 = inner shell, 1 = outer shell
  attribute vec3 aSeed;
  attribute vec3 aPositionTarget;
  varying float vRadial;
  varying float vBright;

  // 2-octave analytic-curl flow field — divergence-free-ish swirling currents.
  // Oct 1: large-scale organic drift. Oct 2: finer turbulence, faster evolution.
  vec3 curlFlow(vec3 p, float t) {
    vec3 q = p * 0.030;
    float dx = sin(q.y * 1.4 + t * 0.19 + q.z * 0.9) - sin(q.z * 1.1 + t * 0.15 + q.x * 0.7);
    float dy = sin(q.z * 1.3 + t * 0.17 + q.x * 0.8) - sin(q.x * 1.2 + t * 0.21 + q.y * 0.6);
    float dz = sin(q.x * 1.1 + t * 0.20 + q.y * 0.7) - sin(q.y * 1.3 + t * 0.16 + q.z * 0.8);
    vec3 q2 = p * 0.075;
    float dx2 = sin(q2.y * 1.2 + t * 0.43 + q2.z) - sin(q2.z * 0.9 + t * 0.38 + q2.x);
    float dy2 = sin(q2.z * 1.1 + t * 0.40 + q2.x) - sin(q2.x * 1.0 + t * 0.45 + q2.y);
    float dz2 = sin(q2.x * 0.9 + t * 0.41 + q2.y) - sin(q2.y * 1.1 + t * 0.36 + q2.z);
    return vec3(dx + dx2 * 0.40, dy + dy2 * 0.40, dz + dz2 * 0.40);
  }

  // Soft-falloff gravity pull toward dest. Tighter falloff (k=0.0035) makes
  // the wells form denser visible clusters: at d=50 force ≈ uAttrStr/9, but
  // close-in particles get pulled into a much tighter knot.
  vec3 attrPull(vec3 dest, vec3 here) {
    vec3  d    = dest - here;
    float dist = max(length(d), 0.001);
    return (d / dist) * uAttrStr / (dist * dist * 0.0035 + 1.0);
  }

  void main() {
    // Morph between base shapes (sphere ↔ heart, etc).
    vec3 basePos = mix(position, aPositionTarget, uShapeMix);
    float r = length(basePos);

    // Per-particle band values: blend mono with the channel matching this
    // particle's hemisphere (sign of basePos.x). At uStereoParticles=0 every
    // particle sees the mono bands; at 1.0 the left hemisphere reacts purely
    // to L, the right to R.
    float side = step(0.0, basePos.x); // 0 if left, 1 if right
    float bassChan   = mix(uBassL,   uBassR,   side);
    float midChan    = mix(uMidL,    uMidR,    side);
    float trebleChan = mix(uTrebleL, uTrebleR, side);
    float bassP   = mix(uBass,   bassChan,   uStereoParticles);
    float midP    = mix(uMid,    midChan,    uStereoParticles);
    float trebleP = mix(uTreble, trebleChan, uStereoParticles);

    // 2-octave curl flow — outer shell (aLayer=1) rides the field harder
    float flowAmp = (2.0 + midP * 2.5) * (1.0 + aLayer * 0.65) * uFlowStrength;
    vec3 pos = basePos + curlFlow(basePos, uTime) * flowAmp;

    // Swirl rotation — outer shell orbits fractionally faster
    float angle = uTime * (0.04 + aLayer * 0.016) + r * 0.012 + aSeed.x * 0.6;
    float c = cos(angle), s = sin(angle);
    pos = vec3(
      pos.x * c - pos.z * s,
      pos.y,
      pos.x * s + pos.z * c
    );

    // Non-linear breathe — uBreatheCurve > 1 means rare peaks (concentrates low bass near min)
    float bassCurved = pow(bassP, uBreatheCurve);
    float breathe = uBreatheMin + bassCurved * uBreatheMax;
    pos *= breathe;
    pos.y += aSeed.y * midP    * 6.5;
    pos   += aSeed   * trebleP * 1.8;

    // Beat burst + echo — two radial shockwaves, echo slightly smaller
    pos += normalize(basePos) * (uBurst * 28.0 + uEcho * 18.0);

    // Gravity wells — pull particles toward each active attractor.
    // Applied before scatter so the cloud "remembers" well positions as it reforms.
    if (uAttrCount > 0.5) pos += attrPull(uAttrPos0, pos);
    if (uAttrCount > 1.5) pos += attrPull(uAttrPos1, pos);
    if (uAttrCount > 2.5) pos += attrPull(uAttrPos2, pos);
    if (uAttrCount > 3.5) pos += attrPull(uAttrPos3, pos);
    if (uAttrCount > 4.5) pos += attrPull(uAttrPos4, pos);
    if (uAttrCount > 5.5) pos += attrPull(uAttrPos5, pos);
    if (uAttrCount > 6.5) pos += attrPull(uAttrPos6, pos);
    if (uAttrCount > 7.5) pos += attrPull(uAttrPos7, pos);
    if (uAttrCount > 8.5) pos += attrPull(uAttrPos8, pos);


    // Scatter — each particle flies to its own random chaos position, then reforms
    vec3 scatterTarget = aSeed * 50.0;
    pos = mix(pos, scatterTarget, uScatter);

    // Outer shell biased toward the outer (hot) color
    vRadial = clamp(r / 60.0 + aLayer * 0.18, 0.0, 1.0);
    vBright = 0.55 + bassP * 1.05 + trebleP * 0.45 + uBurst * 1.1 + uEcho * 0.7 + uScatter * 0.6;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    // Non-linear size — same curve story as breathe.
    float sizeCurved = pow(clamp(bassP, 0.0, 1.0), uSizeCurve);
    float size = aSize * (uSizeMin + sizeCurved * uSizeMax + uBurst * 0.9 + uScatter * 0.5);
    gl_PointSize = size * uPixelRatio * (220.0 / -mv.z);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColorInner;
  uniform vec3 uColorOuter;
  varying float vRadial;
  varying float vBright;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    if (d > 0.5) discard;

    float core  = pow(1.0 - d * 2.0, 3.0);
    float halo  = pow(1.0 - d * 2.0, 1.2) * 0.35;
    vec3  col   = mix(uColorInner, uColorOuter, vRadial) * vBright;
    float alpha = core + halo;
    col += uColorInner * core * 0.5 * vBright;

    gl_FragColor = vec4(col, alpha);
  }
`;

export class Visualizer {
  constructor(canvas, { particleCount = 60000, pixelRatioLimit = 2, streamMode = false } = {}) {
    PARTICLE_COUNT = particleCount;
    this._pixelRatioLimit = pixelRatioLimit;
    this._streamMode = streamMode;
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: streamMode,            // transparent canvas for OBS compositing
      premultipliedAlpha: false,    // cleaner over arbitrary streamer backgrounds
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatioLimit));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.setClearColor(COLOR_BG, streamMode ? 0 : 1);

    this.scene = new THREE.Scene();
    // Stream mode: no fog so particles don't fade into a coloured background
    this.scene.fog = streamMode ? null : new THREE.FogExp2(0x1a0330, 0.0055);

    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 600);
    this.camera.position.set(0, 12, 135);
    this.camera.lookAt(0, -6, 0);

    // Zoom — _zoomTarget is the desired camera Z, _zoomCurrent lerps toward
    // it each frame for a smooth ~0.5s ease. Bounds are clamps used by setZoom.
    this._zoomMin     = 50;
    this._zoomMax     = 250;
    this._zoomDefault = 135;
    this._zoomCurrent = 135;
    this._zoomTarget  = 135;

    // Pre-allocated colours — zero GC per frame.
    this._cInner = new THREE.Color();
    this._cOuter = new THREE.Color();
    this._cGrid  = new THREE.Color();
    this._cFog   = new THREE.Color();

    // Cloud animation params (live-editable via setTuning, c* prefix).
    this.cBurstInterval = 5.0; // minimum seconds between bursts
    this.cRotateSpeed   = 0.14; // base Y-axis spin rate (rad/s)
    this._lastBurstT    = -Infinity;

    // Attractor gravity wells — orbit the cloud, driven by audio.
    // angSpeed is relative: positive = CCW when viewed from above, negative = CW.
    this._attrs = [
      { angle: 0,                       elev:  0.28, angSpeed:  1.00 },
      { angle: Math.PI,                 elev: -0.22, angSpeed: -0.70 },
      { angle: Math.PI / 2,             elev:  0.40, angSpeed:  0.55 },
      { angle: 3 * Math.PI / 2,         elev: -0.38, angSpeed: -0.90 },
      { angle: Math.PI / 4,             elev:  0.18, angSpeed:  0.80 },
      { angle: 5 * Math.PI / 4,         elev: -0.30, angSpeed: -0.60 },
      { angle: 3 * Math.PI / 4,         elev:  0.35, angSpeed:  0.45 },
      { angle: 7 * Math.PI / 4,         elev: -0.15, angSpeed: -1.10 },
      { angle: Math.PI / 6,             elev:  0.22, angSpeed:  0.70 },
    ];
    this.cAttrCount  = 2;   // active wells (0–9); tuning panel "count" slider
    this.cAttrRadius = 55;  // orbit radius; tuning panel "orbit radius" slider

    // Shape transition state — driven by setShape(). uShapeMix lerps to
    // _shapeMixTarget each frame; when it crosses below 0.05 with a pending
    // shape change queued, the target buffer is rebuilt and lerp resumes to 1.
    this._shapeCurrent   = "sphere";
    this._pendingShape   = null;
    this._shapeMixTarget = 0;
    this._shapeMixCurrent = 0;

    // Camera scene state. Camera position and lookAt always lerp toward
    // _camPosTarget / _camLookTarget. When not in cinematic mode, those
    // targets are updated each frame from the zoom slider (front view).
    // When cinematic is on, scenes auto-cycle every _sceneInterval seconds.
    this._camPos        = new THREE.Vector3(0, 12, 135);
    this._camLook       = new THREE.Vector3(0, -6,  0);
    this._camPosTarget  = new THREE.Vector3(0, 12, 135);
    this._camLookTarget = new THREE.Vector3(0, -6,  0);
    this._cinematic     = false;
    this._sceneName     = "front";
    this._sceneT0       = 0;
    this._sceneInterval = 14;
    this.onSceneTick    = null;   // optional (name) => void hook

    // Color entropy params (e* prefix).
    this.eCycleSpeed = 0.00;   // base hue drift rate (hue units/sec)
    this.eBassHue    = 0.10;   // bass energy → outer hue shift
    this.eTrebleHue  = 0.10;   // treble energy → inner hue shift
    this.eSatReact   = 0.25;   // treble → saturation + lightness reactivity
    this.eBurstHue   = 0.44;   // burst event → instant chromatic flash (inner/outer diverge)
    this.eStereoColor = 0;     // 0 = mono, 1 = inner reacts to L / outer to R
    this.eInnerHue   = BASE_INNER_H;  // base hue for the inner (core) color
    this.eOuterHue   = BASE_OUTER_H;  // base hue for the outer (halo) color

    // Floor tuning (live-editable via setTuning).
    Object.assign(this, FLOOR_DEFAULTS);
    this.fStereoFloor = 0;     // 0 = mono, 1 = left grid half = L / right = R

    this._buildGrid();
    this._buildParticles();
    this._buildComposer();
    this.clock = new THREE.Clock();

    // OrbitControls — left-drag to orbit in 3D, scroll to zoom.
    // Disabled during cinematic mode (lerp takes over).
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, -6, 0);
    this.controls.enableDamping  = true;
    this.controls.dampingFactor  = 0.06;
    this.controls.rotateSpeed    = 0.45;
    this.controls.enableZoom     = false;   // zoom buttons handle distance
    this.controls.enablePan      = false;   // keep cloud centred
    this.controls.minPolarAngle  = 0.15;    // ~9° — don't flip fully overhead
    this.controls.maxPolarAngle  = Math.PI - 0.15;

    window.addEventListener("resize", () => this._onResize());
  }

  // ── Post-processing ─────────────────────────────────────────────────────
  _buildComposer() {
    const w = window.innerWidth, h = window.innerHeight;
    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(Math.min(window.devicePixelRatio, this._pixelRatioLimit));
    this.composer.setSize(w, h);

    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(w, h),
      BLOOM_DEFAULTS.bStrength,
      BLOOM_DEFAULTS.bRadius,
      BLOOM_DEFAULTS.bThreshold,
    );
    this.composer.addPass(this.bloom);

    // sRGB conversion + tonemap.
    this.composer.addPass(new OutputPass());
  }

  // ── Deformable grid ──────────────────────────────────────────────────────
  // Custom LineSegments in the XZ plane. Vertex Y is updated each frame
  // from FFT data — each column of vertices maps to one frequency bin.

  _buildGrid() {
    const vertCount = GRID_COLS * GRID_ROWS;
    const posArr    = new Float32Array(vertCount * 3);
    const rowSpacing = GRID_DEPTH / (GRID_ROWS - 1);

    for (let row = 0; row < GRID_ROWS; row++) {
      for (let col = 0; col < GRID_COLS; col++) {
        const i = (row * GRID_COLS + col) * 3;
        posArr[i]     = (col / (GRID_COLS - 1) - 0.5) * GRID_WIDTH;
        posArr[i + 1] = 0; // Y = height, mutated per frame
        posArr[i + 2] = (row / (GRID_ROWS - 1) - 0.5) * GRID_DEPTH + GRID_Z_CENTER;
      }
    }

    // Line index pairs — horizontal runs + vertical runs, no diagonals.
    const idxs = [];
    for (let row = 0; row < GRID_ROWS; row++)
      for (let col = 0; col < GRID_COLS - 1; col++)
        idxs.push(row * GRID_COLS + col, row * GRID_COLS + col + 1);
    for (let col = 0; col < GRID_COLS; col++)
      for (let row = 0; row < GRID_ROWS - 1; row++)
        idxs.push(row * GRID_COLS + col, (row + 1) * GRID_COLS + col);

    // Colour buffer — dark violet at rest, driven to magenta/cyan/white on peaks.
    const colArr  = new Float32Array(vertCount * 3);
    for (let i = 0; i < vertCount; i++) {
      colArr[i * 3]     = 0.06;
      colArr[i * 3 + 1] = 0.02;
      colArr[i * 3 + 2] = 0.18;
    }

    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(posArr, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    const colAttr = new THREE.BufferAttribute(colArr, 3);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", posAttr);
    geo.setAttribute("color",    colAttr);
    geo.setIndex(idxs);

    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      fog: true,
    });

    const mesh = new THREE.LineSegments(geo, mat);
    mesh.position.y   = -48;
    mesh.renderOrder  = -1;
    mat.depthWrite    = false;
    this.grid            = mesh;
    this._gridColH       = new Float32Array(GRID_COLS).fill(0);
    this._gridRowSpacing = rowSpacing;
    this.scene.add(mesh);
  }

  _updateGrid(freqData, freqDataL, freqDataR) {
    const pos = this.grid.geometry.attributes.position;
    const col = this.grid.geometry.attributes.color;

    if (freqData) {
      const maxH     = this.fMaxH;
      const decay    = this.fDecay;
      const attack   = 1 - decay;
      const hotCurve = this.fHotCurve;
      const stereo   = this.fStereoFloor;
      const halfCol  = (GRID_COLS - 1) / 2;

      for (let c = 0; c < GRID_COLS; c++) {
        const t      = c / (GRID_COLS - 1);          // 0=bass … 1=treble
        const binIdx = Math.max(1, Math.round(Math.pow(220, t)));
        // Pick stereo channel by column position (left half = L, right = R).
        const channelData = c < halfCol ? freqDataL : freqDataR;
        const monoVal     = (freqData[binIdx]   || 0) / 255;
        const chanVal     = channelData
          ? (channelData[binIdx] || 0) / 255
          : monoVal;
        const raw    = monoVal * (1 - stereo) + chanVal * stereo;
        const target = raw * maxH;

        const h = this._gridColH;
        h[c] = target > h[c] ? target : h[c] * decay + target * attack;

        // Peak colour: magenta at bass end, cyan at treble end.
        const pr = 1.00 - t * 1.00;  // R: 1→0
        const pg = 0.24 + t * 0.70;  // G: 0.24→0.94
        const pb = 0.94 + t * 0.06;  // B: 0.94→1.00

        for (let r = 0; r < GRID_ROWS; r++) {
          const rowFade = r / (GRID_ROWS - 1);
          const vertH   = h[c] * (0.15 + 0.85 * rowFade);
          pos.setY(r * GRID_COLS + c, vertH);

          // Normalised height drives colour from base → peak → white-hot.
          const nH      = vertH / maxH;
          const white   = Math.pow(nH, hotCurve);      // higher curve = harder to bleach
          const fr = 0.06 + (pr + (1.0 - pr) * white - 0.06) * nH;
          const fg = 0.02 + (pg + (1.0 - pg) * white - 0.02) * nH;
          const fb = 0.18 + (pb + (1.0 - pb) * white - 0.18) * nH;

          col.setXYZ(r * GRID_COLS + c, fr, fg, fb);
        }
      }
    }

    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  // ── Particles ────────────────────────────────────────────────────────────

  // Sphere shell between rMin and rMax, weighted toward the outer edge.
  _sampleSphereRange(n, rMin, rMax) {
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u      = Math.random();
      const radius = rMin + Math.pow(u, 0.6) * (rMax - rMin);
      const theta  = Math.random() * Math.PI * 2;
      const phi    = Math.acos(2 * Math.random() - 1);
      const sinPhi = Math.sin(phi);
      out[i * 3]     = radius * sinPhi * Math.cos(theta);
      out[i * 3 + 1] = radius * Math.cos(phi);
      out[i * 3 + 2] = radius * sinPhi * Math.sin(theta);
    }
    return out;
  }

  // Heart: 2D implicit heart curve  (x² + y² − 1)³ − k·x²y³ = 0  extruded into Z.
  // k > 1 deepens the top cleft and sharpens the bottom point. Cleft at y = +1,
  // point at y ≈ −1, lobes spread along ±x. A puffy z-thickness gives it 3D depth.
  // scale controls size — inner shell uses a tighter heart, outer uses a larger one.
  _sampleHeart(n, scale = 36) {
    const out   = new Float32Array(n * 3);
    const k     = 1.55;   // cleft / point sharpness
    let i = 0;
    while (i < n) {
      const x = (Math.random() - 0.5) * 2.6;
      const y = (Math.random() - 0.5) * 2.6;
      const a = x * x + y * y - 1;
      const f = a * a * a - k * x * x * y * y * y;
      if (f >= 0) continue;
      // Puffy 3D thickness — scales with how deep inside the 2D heart we are.
      const thick = 0.55 * Math.sqrt(Math.max(0, -f / 0.4));
      const z     = (Math.random() * 2 - 1) * Math.min(thick, 0.7);
      out[i * 3]     = x * scale;            // world X = heart X (width / lobe axis)
      out[i * 3 + 1] = y * scale;            // world Y = heart Y (cleft up, point down)
      out[i * 3 + 2] = z * scale;            // world Z = thickness
      i++;
    }
    return out;
  }

  // Torus: clean donut, R = ring radius, r = tube radius (proportional).
  _sampleTorus(n, R) {
    const out = new Float32Array(n * 3);
    const r   = R * 0.32;
    for (let i = 0; i < n; i++) {
      const u = Math.random() * Math.PI * 2;
      const v = Math.random() * Math.PI * 2;
      const cu = Math.cos(u), su = Math.sin(u);
      const cv = Math.cos(v), sv = Math.sin(v);
      out[i * 3]     = (R + r * cv) * cu;
      out[i * 3 + 1] = r * sv;
      out[i * 3 + 2] = (R + r * cv) * su;
    }
    return out;
  }

  // Galaxy: 3-arm log-spiral disk. Particles weighted toward outer edge,
  // flattened on Y, with per-particle noise to thicken each spiral arm.
  _sampleGalaxy(n, R) {
    const out  = new Float32Array(n * 3);
    const arms = 3;
    for (let i = 0; i < n; i++) {
      const u    = Math.pow(Math.random(), 0.55);   // weight outward
      const r    = u * R;
      const arm  = (Math.floor(Math.random() * arms) / arms) * Math.PI * 2;
      const wind = u * Math.PI * 1.6;               // spiral tightness
      const fuzz = (Math.random() - 0.5) * 0.55 * (1 - u * 0.6); // arm spread
      const th   = arm + wind + fuzz;
      out[i * 3]     = Math.cos(th) * r;
      out[i * 3 + 1] = (Math.random() - 0.5) * R * 0.07;  // thin disk
      out[i * 3 + 2] = Math.sin(th) * r;
    }
    return out;
  }

  // Cube: particles on 6 faces. Random face pick, then 2D position on that face.
  _sampleCube(n, half) {
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const face = Math.floor(Math.random() * 6);
      const a = (Math.random() * 2 - 1) * half;
      const b = (Math.random() * 2 - 1) * half;
      let x = 0, y = 0, z = 0;
      switch (face) {
        case 0: x =  half; y = a;    z = b;    break;
        case 1: x = -half; y = a;    z = b;    break;
        case 2: x = a;     y =  half; z = b;   break;
        case 3: x = a;     y = -half; z = b;   break;
        case 4: x = a;     y = b;    z =  half; break;
        case 5: x = a;     y = b;    z = -half; break;
      }
      out[i * 3]     = x;
      out[i * 3 + 1] = y;
      out[i * 3 + 2] = z;
    }
    return out;
  }

  // Helix: two parallel strands wound around a vertical axis with visible thickness.
  _sampleHelix(n, scale) {
    const out    = new Float32Array(n * 3);
    const turns  = 3.5;
    const radius = scale * 0.40;
    const height = scale * 1.9;
    for (let i = 0; i < n; i++) {
      const strand = Math.floor(Math.random() * 2);
      const t      = Math.random();
      const baseAng = t * turns * Math.PI * 2 + strand * Math.PI;
      // Scatter perpendicular to the strand for visible thickness.
      const sR  = scale * 0.045 * Math.sqrt(Math.random());
      const sAn = Math.random() * Math.PI * 2;
      out[i * 3]     = Math.cos(baseAng) * radius + sR * Math.cos(sAn);
      out[i * 3 + 1] = (t - 0.5) * height;
      out[i * 3 + 2] = Math.sin(baseAng) * radius + sR * Math.sin(sAn);
    }
    return out;
  }

  // Sample any registered shape into a Float32Array of length n*3.
  // Scale is the rough overall radius/half-extent for that shape.
  _sampleShape(name, n, scale) {
    switch (name) {
      case "sphere": return this._sampleSphereRange(n, scale * 0.65, scale);
      case "heart":  return this._sampleHeart(n, scale);
      case "torus":  return this._sampleTorus(n, scale);
      case "galaxy": return this._sampleGalaxy(n, scale * 1.25);
      case "cube":   return this._sampleCube(n, scale * 0.85);
      case "helix":  return this._sampleHelix(n, scale * 1.05);
      default:       return this._sampleHeart(n, scale);
    }
  }

  // Rebuild the morph-target buffer with a new shape, in place. Inner shell
  // gets the tight version, outer gets the larger version. Cheap (~720KB write).
  _rebuildShapeTarget(name) {
    if (name === "sphere") return;  // no rebuild needed — uShapeMix → 0 hides target
    const INNER = this._innerCount;
    const OUTER = PARTICLE_COUNT - INNER;
    const innerTgt = this._sampleShape(name, INNER, 26);
    const outerTgt = this._sampleShape(name, OUTER, 46);
    const buf = this._targetAttr.array;
    buf.set(innerTgt, 0);
    buf.set(outerTgt, INNER * 3);
    this._targetAttr.needsUpdate = true;
  }

  // Public: switch to a new shape. Animation routes through sphere
  // (uShapeMix → 0, rebuild target, uShapeMix → 1) for a clean transition.
  setShape(name) {
    if (this._shapeCurrent === name && !this._pendingShape) return;
    this._pendingShape  = name;
    this._shapeMixTarget = 0;
  }

  _buildParticles() {
    // Two concentric shells: inner (bass-anchored core) + outer (flow-driven envelope).
    // Inner: 55% of particles, radii 18–36. Outer: 45%, radii 44–66.
    const INNER = Math.floor(PARTICLE_COUNT * 0.55);
    const OUTER = PARTICLE_COUNT - INNER;
    this._innerCount = INNER;

    const innerPos = this._sampleSphereRange(INNER, 18, 36);
    const outerPos = this._sampleSphereRange(OUTER, 44, 66);
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    positions.set(innerPos, 0);
    positions.set(outerPos, INNER * 3);

    // Heart targets: inner shell morphs to a tighter heart, outer to a larger one.
    const innerTgt = this._sampleHeart(INNER, 26);
    const outerTgt = this._sampleHeart(OUTER, 46);
    const targets  = new Float32Array(PARTICLE_COUNT * 3);
    targets.set(innerTgt, 0);
    targets.set(outerTgt, INNER * 3);

    const geo    = new THREE.BufferGeometry();
    const sizes  = new Float32Array(PARTICLE_COUNT);
    const seeds  = new Float32Array(PARTICLE_COUNT * 3);
    const layers = new Float32Array(PARTICLE_COUNT);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      sizes[i]         = 0.8 + Math.random() * 2.4;
      seeds[i * 3]     = (Math.random() - 0.5) * 2;
      seeds[i * 3 + 1] = (Math.random() - 0.5) * 2;
      seeds[i * 3 + 2] = (Math.random() - 0.5) * 2;
      layers[i]        = i < INNER ? 0.0 : 1.0;
    }

    // Target buffer must be dynamic — `setShape()` rewrites it on demand.
    const targetAttr = new THREE.BufferAttribute(targets, 3);
    targetAttr.setUsage(THREE.DynamicDrawUsage);
    this._targetAttr = targetAttr;

    geo.setAttribute("position",        new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aPositionTarget", targetAttr);
    geo.setAttribute("aSize",           new THREE.BufferAttribute(sizes,     1));
    geo.setAttribute("aSeed",           new THREE.BufferAttribute(seeds,     3));
    geo.setAttribute("aLayer",          new THREE.BufferAttribute(layers,    1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:         { value: 0 },
        uBass:         { value: 0 },
        uMid:          { value: 0 },
        uTreble:       { value: 0 },
        uBassL:        { value: 0 },
        uMidL:         { value: 0 },
        uTrebleL:      { value: 0 },
        uBassR:        { value: 0 },
        uMidR:         { value: 0 },
        uTrebleR:      { value: 0 },
        uStereoParticles: { value: 0 },
        uBurst:        { value: 0 },
        uEcho:         { value: 0 },
        uScatter:      { value: 0 },
        uPixelRatio:   { value: this.renderer.getPixelRatio() },
        uColorInner:   { value: new THREE.Color().setHSL(BASE_INNER_H, 1.0, 0.55) },
        uColorOuter:   { value: new THREE.Color().setHSL(BASE_OUTER_H, 1.0, 0.50) },
        uBreatheMin:   { value: 1.16 },
        uBreatheMax:   { value: 1.71 },
        uBreatheCurve: { value: 0.35 },
        uSizeMin:      { value: 0.24 },
        uSizeMax:      { value: 1.72 },
        uSizeCurve:    { value: 2.65 },
        uShapeMix:     { value: 0 },      // driven by setShape() transition system
        uFlowStrength: { value: 1.0  },   // curl-noise amplitude multiplier
        uAttrPos0:  { value: new THREE.Vector3( 55,  0,  0) },
        uAttrPos1:  { value: new THREE.Vector3(-55,  0,  0) },
        uAttrPos2:  { value: new THREE.Vector3(  0,  0, 55) },
        uAttrPos3:  { value: new THREE.Vector3(  0,  0,-55) },
        uAttrPos4:  { value: new THREE.Vector3( 39,  0, 39) },
        uAttrPos5:  { value: new THREE.Vector3(-39,  0,-39) },
        uAttrPos6:  { value: new THREE.Vector3(-39,  0, 39) },
        uAttrPos7:  { value: new THREE.Vector3( 39,  0,-39) },
        uAttrPos8:  { value: new THREE.Vector3(  0, 20,  0) },
        uAttrCount: { value: 2 },
        uAttrStr:   { value: 7.5 },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
    });

    this.particles = new THREE.Points(geo, mat);
    this.scene.add(this.particles);
  }

  // ── Attractors ───────────────────────────────────────────────────────────

  _updateAttractors(bands, dt) {
    const u   = this.particles.material.uniforms;
    // Mid drives orbit speed; bass expands the orbit radius momentarily.
    const speed = 0.06 + bands.mid * 0.22;
    const r     = this.cAttrRadius * (0.85 + bands.bass * 0.32);
    const pos = [
      u.uAttrPos0, u.uAttrPos1, u.uAttrPos2, u.uAttrPos3,
      u.uAttrPos4, u.uAttrPos5, u.uAttrPos6, u.uAttrPos7, u.uAttrPos8,
    ];

    this._attrs.forEach((a, i) => {
      a.angle += speed * a.angSpeed * dt;
      const cosE = Math.cos(a.elev);
      // Small vertical bob per attractor (different phase per index).
      const y = Math.sin(a.elev) * r * 0.45 + Math.sin(a.angle * 0.31 + i * 1.7) * 6;
      pos[i].value.set(
        Math.cos(a.angle) * r * cosE,
        y,
        Math.sin(a.angle) * r * cosE,
      );
    });

    u.uAttrCount.value = Math.min(9, Math.max(0, Math.round(this.cAttrCount)));
  }

  // ── Colours ──────────────────────────────────────────────────────────────

  _updateColors(bands, bandsL, bandsR, t, burst) {
    const cycle = (t * this.eCycleSpeed) % 1.0;

    // On a burst: inner and outer hues diverge in opposite directions,
    // creating a chromatic flash that decays with the burst envelope.
    const burstShift = burst * this.eBurstHue;

    // Stereo divergence — at eStereoColor=1, the inner color reacts purely to
    // L and the outer purely to R, so panning splits the palette.
    const stereo    = this.eStereoColor;
    const innerBass   = bands.bass   * (1 - stereo) + (bandsL ? bandsL.bass   : bands.bass)   * stereo;
    const innerTreble = bands.treble * (1 - stereo) + (bandsL ? bandsL.treble : bands.treble) * stereo;
    const outerBass   = bands.bass   * (1 - stereo) + (bandsR ? bandsR.bass   : bands.bass)   * stereo;

    const iH = (this.eInnerHue + cycle - innerTreble * this.eTrebleHue - burstShift + 1.0) % 1.0;
    const iS = 1.0 - innerTreble * this.eSatReact;
    const iL = 0.50 + innerTreble * this.eSatReact;

    const oH = (this.eOuterHue + cycle + outerBass * this.eBassHue + burstShift) % 1.0;
    const oL = 0.45 + outerBass * 0.42;

    this._cInner.setHSL(iH, iS, iL);
    this._cOuter.setHSL(oH, 1.0, oL);
    this._cFog.setHSL(oH, 0.75, 0.06 + outerBass * 0.05);

    this.particles.material.uniforms.uColorInner.value.copy(this._cInner);
    this.particles.material.uniforms.uColorOuter.value.copy(this._cOuter);
    if (this.scene.fog) this.scene.fog.color.copy(this._cFog);
  }

  // ── Resize ───────────────────────────────────────────────────────────────

  _onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.particles.material.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
    if (this.composer) this.composer.setSize(w, h);
    if (this.bloom)    this.bloom.setSize(w, h);
  }

  // ── Render ───────────────────────────────────────────────────────────────

  render(bands, freqData, beat, stereo) {
    const dt = this.clock.getDelta();
    const t  = this.clock.getElapsedTime();
    const u  = this.particles.material.uniforms;

    const bandsL    = stereo?.bandsL    || bands;
    const bandsR    = stereo?.bandsR    || bands;
    const freqDataL = stereo?.freqDataL || freqData;
    const freqDataR = stereo?.freqDataR || freqData;

    u.uTime.value    = t;
    u.uBass.value    = bands.bass;
    u.uMid.value     = bands.mid;
    u.uTreble.value  = bands.treble;
    u.uBassL.value   = bandsL.bass;
    u.uMidL.value    = bandsL.mid;
    u.uTrebleL.value = bandsL.treble;
    u.uBassR.value   = bandsR.bass;
    u.uMidR.value    = bandsR.mid;
    u.uTrebleR.value = bandsR.treble;

    // Beat burst: fast radial punch, echo 200ms later, scatter: reform ~1.5s
    // Cooldown: don't re-trigger while still reforming from last beat
    if (beat && (t - this._lastBurstT) > this.cBurstInterval && u.uScatter.value < 0.06) {
      this._lastBurstT = t;
      u.uBurst.value   = 1.0;
      u.uScatter.value = 1.0;
      clearTimeout(this._echoTimer);
      this._echoTimer = setTimeout(() => { u.uEcho.value = 0.7; }, 200);
    }
    u.uBurst.value   *= 0.82;
    u.uEcho.value    *= 0.82;
    u.uScatter.value *= 0.945;

    this._updateColors(bands, bandsL, bandsR, t, u.uBurst.value);
    this._updateGrid(freqData, freqDataL, freqDataR);
    this._updateAttractors(bands, dt);

    // Shape transition: lerp uShapeMix toward target. When a pending shape
    // is queued and the mix has nearly hit zero, rebuild the target buffer
    // and flip the target back to 1 — gives a clean "collapse → bloom" feel.
    this._shapeMixCurrent += (this._shapeMixTarget - this._shapeMixCurrent) * 0.07;
    u.uShapeMix.value = this._shapeMixCurrent;
    if (this._pendingShape && this._shapeMixCurrent < 0.05) {
      this._rebuildShapeTarget(this._pendingShape);
      this._shapeCurrent   = this._pendingShape;
      this._pendingShape   = null;
      this._shapeMixTarget = (this._shapeCurrent === "sphere") ? 0 : 1;
    }

    // Y-axis spin (podium rotation). Bass speeds it up.
    this.particles.rotation.y += dt * (this.cRotateSpeed + bands.bass * 0.46);
    // X-axis tumble — only active for sphere mode. When morphed toward another
    // shape, accumulation is gated and any existing tilt damps back to upright.
    const shapeMix = this._shapeMixCurrent;
    this.particles.rotation.x += dt * 0.018 * (1 - shapeMix);
    this.particles.rotation.x *= 1 - shapeMix * dt * 2.5;

    // Scroll grid toward camera; loop seamlessly every row-spacing.
    this.grid.position.z =
      (this.grid.position.z + dt * (this.fScroll + bands.bass * this.fScrollBass)) % this._gridRowSpacing;

    // Camera: cinematic mode lerps between named scenes; otherwise OrbitControls
    // lets the user drag to any angle. Zoom buttons adjust distance from target.
    if (this._cinematic) {
      this.controls.enabled = false;
      if (t - this._sceneT0 > this._sceneInterval) {
        this._sceneT0       = t;
        this._sceneInterval = 12 + Math.random() * 8;   // 12–20s between cuts
        this._cycleScene();
      }
      this._camPos.lerp(this._camPosTarget,  0.035);
      this._camLook.lerp(this._camLookTarget, 0.035);
      this.camera.position.copy(this._camPos);
      this.camera.position.y += Math.cos(t * 0.06) * 2.5;  // gentle bob
      this.camera.lookAt(this._camLook);
    } else {
      // Zoom: smoothly adjust distance from target along the current view axis.
      this._zoomCurrent += (this._zoomTarget - this._zoomCurrent) * 0.06;
      const dir = this.camera.position.clone().sub(this.controls.target);
      const curDist = dir.length();
      if (Math.abs(curDist - this._zoomCurrent) > 0.1) {
        this.camera.position.copy(
          dir.normalize().multiplyScalar(this._zoomCurrent).add(this.controls.target)
        );
      }
      if (!this.controls.enabled) {
        // Re-entering non-cinematic: sync controls to current camera state.
        this.controls.update();
        this.controls.enabled = true;
      }
      this.controls.update();
    }

    this.composer.render();
  }

  // Toggle cinematic mode. When on, the camera auto-cuts through named
  // scenes every 12–20s and fires onSceneTick(name) so callers can sync
  // palette swaps or other side-effects with each cut.
  setCinematic(on) {
    this._cinematic = !!on;
    if (this._cinematic && this.clock) {
      this._sceneT0       = this.clock.getElapsedTime();
      this._sceneInterval = 12 + Math.random() * 8;
      this.controls.enabled = false;
    } else {
      // Hand camera back to OrbitControls from wherever cinematic left it.
      this.controls.target.set(0, -6, 0);
      this.controls.update();
      this.controls.enabled = true;
    }
  }
  get cinematic() { return this._cinematic; }

  // Snap-to / lerp-toward a named camera scene immediately (used when
  // cinematic mode cycles, and exposed publicly for explicit cuts).
  setCameraScene(name) {
    const s = CAMERA_SCENES[name];
    if (!s) return;
    this._sceneName = name;
    this._camPosTarget.set(s.pos[0],  s.pos[1],  s.pos[2]);
    this._camLookTarget.set(s.look[0], s.look[1], s.look[2]);
  }

  _cycleScene() {
    const names = Object.keys(CAMERA_SCENES);
    let next;
    do { next = names[Math.floor(Math.random() * names.length)]; }
    while (next === this._sceneName && names.length > 1);
    this.setCameraScene(next);
    if (this.onSceneTick) this.onSceneTick(next);
  }

  // Zoom — set the target camera Z (any number, clamped to [zoomMin, zoomMax]).
  // The render loop lerps _zoomCurrent toward _zoomTarget for smooth transitions.
  setZoom(z) {
    this._zoomTarget = Math.max(this._zoomMin, Math.min(this._zoomMax, z));
  }
  get zoomMin()     { return this._zoomMin; }
  get zoomMax()     { return this._zoomMax; }
  get zoomDefault() { return this._zoomDefault; }
  get zoomTarget()  { return this._zoomTarget; }


  // Live-tuning hook for the debug panel.
  //   uX → shader uniform on the particle material
  //   fX → instance property used by the floor (grid) update
  //   bX → property on the UnrealBloomPass
  setTuning(name, value) {
    if (name.startsWith("u")) {
      const u = this.particles.material.uniforms;
      if (u[name]) u[name].value = value;
    } else if (name.startsWith("f") || name.startsWith("c") || name.startsWith("e")) {
      if (name in this) this[name] = value;
    } else if (name.startsWith("b") && this.bloom) {
      const map = { bStrength: "strength", bRadius: "radius", bThreshold: "threshold" };
      const k = map[name];
      if (k) this.bloom[k] = value;
    }
  }
}
