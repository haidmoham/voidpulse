# NEBVIS agent instructions

NEBVIS is a browser-first astrophysical music visualizer. Build one coherent,
runnable pass before asking for micro-decisions, then keep localhost available
for visual iteration.

## Product invariants

- Keep browser-native tab/window audio capture as the primary source flow.
- Tab capture must start from a direct user gesture through
  `getDisplayMedia()`; request audio and the Chromium-required video track,
  discard video after selection, and show a useful error when the chosen
  surface has no audio.
- Never connect microphone or captured tab audio to
  `AudioContext.destination`. File playback may connect through gain.
- Keep music response meaningful and stable: low frequencies alter structure,
  mids alter nebular density, highs alter starlight, and onsets reveal light
  echoes. Do not use flashing or rapid random hue cycling.
- Respect reduced motion, mobile safe areas, capped device pixel ratio,
  visibility pausing, WebGL failure, and browser autoplay rules.

## Stack and structure

- Vite + React + strict TypeScript.
- Three.js owns the ambient visual field; semantic controls and status stay in
  the DOM.
- Keep browser APIs behind typed boundaries in `src/audio/`.
- Keep renderer, shaders, and scene math in `src/visualization/`.
- Prefer focused modules and pure helpers over framework-wide abstractions.

## Design workflow

- Search prior art and the private design vocabulary before inventing.
- Treat Legos as abstract compositional blocks. Riff, mutate, layer, invert, or
  ablate them until they belong to NEBVIS; preserve useful invariants, not
  source aesthetics.
- The user owns taste and final art direction. Implement a bold first pass,
  verify it in a real browser, then respond literally to corrections.
- Keep controls crisp and immediate while the visual field carries the
  spectacle. No generic dashboard chrome.

## Verification

- Run `npm run typecheck`, `npm test`, `npm run build`, and the configured
  anti-slop Oxlint check.
- Browser QA must exercise the source-picker UI, demo fallback, resize/mobile
  layout, reduced-motion behavior, and console errors.
- A successful build is not proof of a successful visualizer.

## Deployment

- Vercel is the deployment target.
- Canonical public identity: **NEBVIS** at **nebvis.shin86.dev**.
- Keep secrets out of the repository.
