# Voidpulse agent instructions

Voidpulse is a browser-first reimagining of the iTunes Magnetosphere visualizer. Preserve the fast, inspectable architecture and the audio-reactive behavior that makes the project distinct.

## Read first

- Read `README.md` and the relevant source before changing behavior.
- Prefer the smallest change that preserves the existing interaction model.
- Treat Git history as the archive for completed build phases and superseded approaches.

## Architecture

- Backend: Flask. It serves the app and Spotify auth/API proxy routes.
- Frontend: vanilla ES modules + three.js. Do not add a bundler or npm toolchain by default.
- Audio analysis stays in the browser.
- Primary real-audio sources are system/tab audio, microphone, and file input.
- Do not connect live microphone or system/tab capture to `AudioContext.destination`; that causes feedback or duplicate playback.
- Existing FFT analysis remains the fallback for real-audio sources.

## Beat and Spotify model

- Spotify is a background listening-along service, not an audio source.
- Do not restore in-browser Spotify playback.
- New Spotify apps cannot rely on the deprecated `/v1/audio-analysis` or `/v1/audio-features` endpoints.
- ReccoBeats provides tempo, energy, valence, and related track features.
- Essentia.js provides real beat alignment from captured PCM when real audio is available.
- `spotify.phaseLock()` may align the synthetic Spotify pulse to an externally detected beat.
- Keep synthetic BPM behavior as a fallback when Spotify is active but no analyzable audio source is present.

## Visual and mobile constraints

- Preserve the synthwave visual language and custom shader particle field.
- The audio source picker is primary UI. Do not bury it under secondary controls.
- Mobile targets roughly 15,000 particles with `pixelRatioLimit: 1.5`.
- Mobile keeps the heart shape, microphone-first UI, reduced controls, and touch-driven disrupt interaction.
- Respect iOS safe-area insets and browser autoplay rules.

## Debugging

- When audio appears silent, inspect `engine.bands()` first.
- All-zero bands usually mean the audio graph is not connected.
- Non-zero but weak/stuck bands usually indicate source gain, limiting, or analysis behavior rather than rendering failure.
- Verify changes in the browser with the actual source mode involved.

## Deployment

- Railway is the deployment target.
- Preserve current environment-variable and health-check behavior.
- Keep secrets in environment configuration, never in the repository.
- Use the repository's current Git/PR deployment path instead of inventing a new release system.

## Agent boundary

Use agents aggressively for implementation friction, debugging, API inspection, and repetitive edits. Keep product judgment, aesthetic direction, and interpretation of surprising behavior with the human unless explicitly delegated. Verify important claims against runtime behavior or primary documentation.
