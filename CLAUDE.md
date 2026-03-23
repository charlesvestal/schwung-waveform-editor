# CLAUDE.md — Wave Edit Module

External tool module for Schwung. Full audio waveform editor with trim, gain, copy/paste, and normalize.

## Module Structure

```
src/
  module.json       # Module metadata (component_type: "tool", interactive)
  ui.js             # QuickJS UI (waveform display, markers, editing)
  dsp/plugin.c      # Audio DSP plugin source (cross-compiled to ARM64)
  help.json         # On-device help content
```

## Build & Deploy

```bash
./scripts/build.sh        # Cross-compile DSP + package to dist/waveform-editor/
./scripts/install.sh      # Deploy to Move device
```

Requires `aarch64-linux-gnu-gcc` cross-compiler (set `CROSS_PREFIX` to override).

## Release

1. Update version in `src/module.json`
2. `git commit -am "bump to vX.Y.Z"`
3. `git tag vX.Y.Z && git push --tags`
4. GitHub Actions builds and creates release

## How It Works

This is an interactive tool — the shadow UI loads the DSP and UI together.
- DSP handles WAV loading, playback, gain, normalize, copy/paste, undo
- UI renders waveform display, handles marker editing and input
- Knobs provide direct control of markers, zoom, and gain
- Pads trigger hold-to-audition playback
