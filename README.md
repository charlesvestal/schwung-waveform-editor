# Wave Edit for Move Everything

A full-featured audio waveform editor for your Ableton Move. Trim, gain adjust, normalize, copy/paste, and mute sections of WAV files directly on the device.

## Features

- Waveform display with zoom and minimap overview
- Start/end marker selection with knobs
- Jog wheel scrolls waveform view when zoomed in
- Real-time gain adjustment and normalization
- Cut, copy, paste, and mute operations
- Hold-to-audition playback with loop mode
- Undo support for all destructive edits
- Export selection to new file
- BPM-grid slicing and beat-aligned marker snapping

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

### Trim View

| Control | Function |
|---------|----------|
| Jog wheel | Scroll view when zoomed in (Shift: fine scroll) |
| Jog click | Edit menu: Copy, Cut, Truncate, Normalize Sel, BPM Step |
| Shift+Jog click | Paste/Export menu: Paste (insert), Paste (overwrite), Export |
| Knob 1 | Move start marker |
| Knob 2 | Move end marker |
| Knob 3 | Zoom |
| Knob 4 | Vertical scale |
| Knob 5 | Gain (Shift: normalize) |
| Any pad | Hold to audition (Shift: preview near end) |
| Mute | Zero out selection |
| Copy | Copy selection |
| Shift+Copy | Paste at cursor (insert) |
| Delete | Cut selection |
| Left/Right | Nudge selection by coarse step |
| Shift+L/R | Jump selection by one selection length |
| Loop | Toggle loop mode |
| Capture | Save (overwrite) |
| Shift+Capture | Export selection |
| Undo | Undo last edit |
| Back | Exit (warns on unsaved) |

### BPM Step Mode (via Jog click → BPM Step)

| Control | Function |
|---------|----------|
| Jog wheel | Scroll view when zoomed in |
| Jog click | Toggle active marker (Start/End) |
| Knob 1 | Move start marker (in beat steps) |
| Knob 2 | Move end marker (in beat steps) |
| Knob 3 | Zoom |
| Knob 5 | Set BPM (Shift: fine ±0.1) |
| Knob 6 | Set beat division (1/1–1/16) |
| Left/Right | Move active marker by one division |
| Back | Return to Trim view |

### Slice Mode

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
| Pads | Audition slice (hold) |

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
