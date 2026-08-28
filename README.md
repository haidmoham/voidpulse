# NEBVIS

**Turn sound into gravity.**

NEBVIS is a real-time astrophysical music visualizer built with React,
TypeScript, Three.js, and the Web Audio API. Share an audio-playing browser tab,
use a microphone, or load a local track; NEBVIS maps the signal into a lensed
accretion field, nebular dust, light echoes, and bipolar jets.

## Run locally

```bash
npm install
npm run dev
```

Open the printed local URL in Chrome or Edge for tab-audio capture.

## Checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Audio privacy

Audio analysis happens locally in the browser. Captured audio is not uploaded.
NEBVIS discards the video track returned by the browser's native share picker
and never routes microphone or tab capture back to your speakers.
