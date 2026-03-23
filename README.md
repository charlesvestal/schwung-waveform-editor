# Wave Edit for Schwung

A full-featured audio waveform editor for your Ableton Move. Trim, gain adjust, normalize, copy/paste, and mute sections of WAV files directly on the device.

## Features

- Waveform display with zoom and minimap overview
- Start/end marker selection with jog and knobs
- Real-time gain adjustment and normalization
- Cut, copy, paste, and mute operations
- Hold-to-audition playback with loop mode
- Undo support for all destructive edits
- Export selection to new file

## Prerequisites

- [Schwung](https://github.com/charlesvestal/schwung) installed on your Ableton Move
- SSH access enabled: http://move.local/development/ssh

## Install

### Via Module Store (Recommended)

1. Launch Schwung on your Move
2. Select **Module Store** from the main menu
3. Navigate to **Tools** > **Wave Edit**
4. Select **Install**

### Build from Source

```bash
git clone https://github.com/charlesvestal/schwung-waveform-editor
cd schwung-waveform-editor
./scripts/build.sh
./scripts/install.sh
```

## Controls

| Control | Function |
|---------|----------|
| Jog wheel | Move selected marker |
| Jog click | Toggle start/end marker |
| Knob 1 | Move start marker |
| Knob 2 | Move end marker |
| Knob 3 | Zoom (Shift: vertical scale) |
| Knob 4 | Gain (Shift: normalize) |
| Any pad | Hold to audition (Shift: full file) |
| Mute | Zero out selection |
| Copy | Copy selection |
| Shift+Copy | Paste at cursor |
| Delete | Cut selection |
| Loop | Toggle loop mode |
| Capture | Save (overwrite) |
| Shift+Capture | Export selection |
| Undo | Undo last edit |
| Back | Exit (warns on unsaved) |

## Header Indicators

- `*` — unsaved changes
- `L` — loop mode enabled

## Credits

- **Schwung framework**: [Charles Vestal](https://github.com/charlesvestal/schwung)

## License

MIT License — See [LICENSE](LICENSE)

## AI Assistance Disclaimer

This module is part of Schwung and was developed with AI assistance, including Claude, Codex, and other AI assistants.

All architecture, implementation, and release decisions are reviewed by human maintainers.
AI-assisted content may still contain errors, so please validate functionality, security, and license compatibility before production use.
