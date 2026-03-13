# Wave Edit for Move Everything

A full-featured audio waveform editor for your Ableton Move. Trim, gain adjust, normalize, copy/paste, and mute sections of WAV files directly on the device.

## Features

- Waveform display with zoom and minimap overview
- Start/end marker selection with knobs
- Jog wheel scrolls waveform view when zoomed in
- Real-time gain adjustment and normalization
- Cut, copy, paste, and mute operations
- Hold-to-audition playback with loop mode
- Loop view: seam editor for seamless loops with zero-crossing snap
- Undo support for all destructive edits
- Export selection to new file
- BPM-grid slicing and beat-aligned marker snapping
- Record audio directly into the editor (New Recording in file browser)

## Prerequisites

- [Move Everything](https://github.com/charlesvestal/move-anything) installed on your Ableton Move
- SSH access enabled: http://move.local/development/ssh

## Install

### Via Module Store (Recommended)

1. Launch Move Everything on your Move
2. Select **Module Store** from the main menu
3. Navigate to **Tools** > **Wave Edit**
4. Select **Install**

### Build from Source

```bash
git clone https://github.com/charlesvestal/move-anything-waveform-editor
cd move-anything-waveform-editor
./scripts/build.sh
./scripts/install.sh
```

## Controls

### View Selection (Step Buttons)

| Step | View |
|------|------|
| Step 1 | Trim view |
| Step 2 | BPM Step mode |
| Step 3 | Slice mode |

### Trim View

| Control | Function |
|---------|----------|
| Jog wheel | Scroll view when zoomed in |
| Jog click | Edit menu: Copy, Cut, Truncate, Normalize Sel, BPM Step, Mute |
| Shift+Jog click | Paste/Export menu: Paste (insert), Paste (overwrite), Export |
| Knob 1 | Move start marker (Shift: fine movement) |
| Knob 2 | Move end marker (Shift: fine movement) |
| Knob 3 | Zoom |
| Knob 4 | Vertical scale |
| Knob 5 | Gain (Shift: normalize) |
| Knob 7 (touch+twist) | Toggle loop mode on/off |
| Knob 8 (touch+twist) | Snap markers to zero crossing |
| Any pad | Hold to audition (Shift: preview near end) |
| Mute | Mute (zero out) selection |
| Copy | Copy selection |
| Shift+Copy | Paste at cursor (insert) |
| Remove | Cut selection (copy + remove) |
| Left/Right | Nudge selection by coarse step |
| Shift+L/R | Jump selection by one selection length |
| Step 15 | Set start marker at playback position (while playing) |
| Step 16 | Set end marker at playback position (while playing) |
| Loop | Enter loop view (seam editor) |
| Shift+Loop | Toggle loop mode on/off |
| Sample | Open save menu (editable filename) |
| Shift+Capture | Export selection to new file |
| Undo | Undo last edit |
| Back | Hide (keeps DSP alive) |
| Shift+Back | Full exit (unload DSP) |

### BPM Step Mode (Step 2, or Jog click → BPM Step)

| Control | Function |
|---------|----------|
| Jog wheel | Scroll view when zoomed in |
| Jog click | Toggle active marker (Start/End) |
| Knob 1 | Move start marker (in beat steps) |
| Knob 2 | Move end marker (in beat steps) |
| Knob 3 | Zoom |
| Knob 5 | Set BPM (Shift: fine ±0.1) — snaps end marker to beat grid |
| Knob 6 | Set beat division (1/1–1/16) |
| Copy | Copy selection |
| Shift+Copy | Paste at cursor (insert) |
| Down | Read BPM from filename |
| Up | Estimate BPM from selection length (assumes 1 bar, 4/4) |
| Left/Right | Move active marker by one division |
| Shift+L/R | Move entire selection by one division |
| Step 15 | Set start marker at playback position (while playing) |
| Step 16 | Set end marker at playback position (while playing) |
| Shift+Loop | Toggle loop on/off |
| Back | Return to Trim view |

### Slice Mode (Step 3)

| Control | Function |
|---------|----------|
| Jog wheel | Cycle slice mode (Even / Auto / Lazy / BPM) |
| Knob 1 | Move slice start boundary |
| Knob 2 | Move slice end boundary |
| Knob 3 | Zoom |
| Knob 4 | Vertical scale |
| Knob 5 | Count (Even) / Threshold (Auto) / Chop-Play (Lazy) / BPM value (BPM) |
| Knob 6 | Beat division (BPM mode only) |
| Knob 8 | Select slice |
| Left/Right | Previous / next slice |
| Shift+Left/Right | Move selected slice left/right (swap with neighbour) |
| Up | Merge slice with previous |
| Down | Split slice at midpoint |
| Shift+Up/Down | Scroll pad bank (when >32 slices) |
| Copy | Copy selected slice to clipboard |
| Shift+Copy | Paste clipboard insert before selected slice |
| Remove | Cut selected slice (copy + remove from file) |
| Step 16 | Shuffle all slices randomly |
| Pads | Audition slice (hold) |
| Sample | Save slices / Drum Preset / REX Loop (if installed) |
| Shift+Capture | Export current selection to new file |
| Back | Hide (keeps DSP alive) |

## Header Indicators

- `*` — unsaved changes
- `L` — loop mode enabled

## Credits

- **Move Everything framework**: [Charles Vestal](https://github.com/charlesvestal/move-anything)

## License

MIT License — See [LICENSE](LICENSE)

## AI Assistance Disclaimer

This module is part of Move Everything and was developed with AI assistance, including Claude, Codex, and other AI assistants.

All architecture, implementation, and release decisions are reviewed by human maintainers.
AI-assisted content may still contain errors, so please validate functionality, security, and license compatibility before production use.
