/*
 * Wave Edit UI
 *
 * Trim, gain adjust, normalize, and edit audio files on the Move.
 * 128x64 1-bit monochrome display, QuickJS runtime.
 *
 * Views: Mode Menu, Editor, Confirm Exit, Confirm Normalize
 *
 * Header indicators: "*" = unsaved changes, "L" = loop enabled
 * Zoom minimap bar shows viewport position when zoomed in
 *
 * Encoder handling: The shadow UI framework batches encoder ticks
 * per-knob and delivers one synthetic CC per frame with accumulated
 * count. decodeDelta() returns the signed count for proportional response.
 *
 * Controls:
 *   Jog wheel    - Move selected marker  |  Menu: navigate
 *   Jog click    - Toggle start/end field |  Menu: select item
 *   E1 (Knob 1)  - Move start marker
 *   E2 (Knob 2)  - Move end marker
 *   E3 (Knob 3)  - Zoom in/out  |  Shift: vertical scale (1x-32x)
 *   E4 (Knob 4)  - Adjust gain  |  Shift: normalize (confirm overlay)
 *   Any pad      - Hold to audition selection, release to stop
 *   Mute         - Mute (zero out) selection
 *   Copy         - Copy selection to clipboard
 *   Shift+Copy   - Paste clipboard at cursor (insert)
 *   Delete       - Cut selection to clipboard (copy + remove)
 *   Shift+Capture- Export selection to new file
 *   Capture      - Save (overwrite confirmation)
 *   Undo         - Undo last destructive operation
 *   Loop         - Toggle loop mode
 *   Left/Right   - Nudge selection by one coarse step
 *   Shift+L/R    - Jump selection by one selection length
 *   Back         - Navigate back / exit
 */

import * as os from 'os';

/* Shared utilities - absolute path for module location independence */
import {
    MidiNoteOn, MidiCC,
    MoveShift, MoveMainKnob, MoveMainButton, MoveBack,
    MoveCapture, MoveRec, MoveSample, MoveUndo, MoveLoop, MoveCopy, MoveMute, MoveDelete,
    MoveLeft, MoveRight, MoveDown, MoveUp,
    MovePads,
    MoveKnob1, MoveKnob2, MoveKnob3, MoveKnob4, MoveKnob5, MoveKnob7, MoveKnob8,
    MoveKnob5Touch, MoveKnob7Touch, MoveKnob8Touch,
    White, Black, DarkGrey, LightGrey, BrightRed, DeepRed,
    WhiteLedOff, WhiteLedDim, WhiteLedMedium, WhiteLedBright
} from '/data/UserData/move-anything/shared/constants.mjs';

import {
    setLED, setButtonLED, decodeDelta
} from '/data/UserData/move-anything/shared/input_filter.mjs';

import {
    buildFilepathBrowserState,
    refreshFilepathBrowser,
    moveFilepathBrowserSelection,
    activateFilepathBrowserItem
} from '/data/UserData/move-anything/shared/filepath_browser.mjs';

import {
    announce
} from '/data/UserData/move-anything/shared/screen_reader.mjs';

import { log as uniLog } from '/data/UserData/move-anything/shared/logger.mjs';
function debugLog(msg) { uniLog("WaveEdit", msg); }

/* ============ Constants ============ */

/* Views */
var VIEW_MODE_MENU = 1;
var VIEW_TRIM = 2;
var VIEW_CONFIRM_EXIT = 4;
var VIEW_CONFIRM_NORMALIZE = 5;
var VIEW_LOOP = 6;
var VIEW_CONFIRM_SAVE = 7;
var VIEW_OPEN_FILE = 8;
var VIEW_SLICE = 9;

/* MIDI CCs — use shared constants */
var CC_JOG = MoveMainKnob;
var CC_JOG_CLICK = MoveMainButton;
var CC_E1 = MoveKnob1;
var CC_E2 = MoveKnob2;
var CC_E3 = MoveKnob3;
var CC_E4 = MoveKnob4;
var CC_E5 = MoveKnob5;
var CC_E7 = MoveKnob7;
var CC_E8 = MoveKnob8;
var CC_SHIFT = MoveShift;
var CC_BACK = MoveBack;
var CC_MUTE = MoveMute;
var CC_DELETE = MoveDelete;
var CC_COPY = MoveCopy;
var CC_UNDO = MoveUndo;
var CC_LOOP = MoveLoop;
var CC_CAPTURE = MoveCapture;
var CC_LEFT = MoveLeft;
var CC_RIGHT = MoveRight;
var CC_DOWN = MoveDown;
var CC_UP = MoveUp;
var CC_SAMPLE = MoveSample;
var CC_REC = MoveRec;

/* Pad note range */
var PAD_NOTE_MIN = MovePads[0];
var PAD_NOTE_MAX = MovePads[MovePads.length - 1];

/* Display geometry */
var SCREEN_W = 128;
var SCREEN_H = 64;
var WAVE_Y_TOP = 13;
var WAVE_Y_BOT = 50;
var WAVE_HEIGHT = WAVE_Y_BOT - WAVE_Y_TOP;
var WAVE_MID = WAVE_Y_TOP + Math.floor(WAVE_HEIGHT / 2);

/* Gain limits */
var GAIN_MIN = -60.0;
var GAIN_MAX = 24.0;
var GAIN_STEP = 0.5;

/* Zoom limits — float zoom, small step per encoder tick for smooth zooming */
var ZOOM_MAX = 12;
var ZOOM_STEP = 0.1;

/* Vertical scale: multiplier for waveform display amplitude */
var VSCALE_MIN = 1.0;
var VSCALE_MAX = 32.0;
var VSCALE_STEP = 0.25; /* multiplicative: scale *= 2^step per tick */

/* ============ State ============ */

var currentView = VIEW_TRIM;
var shiftHeld = false;

/* Twist-action knob state (touch + twist right = execute, twist left = cancel) */
var pendingTwistAction = null; /* { cc, action, prompt } or null */

/* File info */
var fileName = "";
var openedFilePath = ""; /* Full path of currently loaded file */
var fileDuration = 0;
var totalFrames = 0;
var sampleRate = 44100;

/* Marker state */
var startSample = 0;
var endSample = 0;
var selectedField = 0; /* 0=start, 1=end */

/* Zoom state */
var zoomLevel = 0;
var zoomCenter = 0;

/* Vertical scale state */
var vScale = 1.0;

/* Playback state — play/stop commands are queued and issued in tick()
 * to avoid being overwritten by encoder param updates (fire-and-forget
 * shared memory race). Pads always win. */
var playing = false;
var playPos = 0;
var pendingPlay = "";  /* "", "selection", "whole", or "stop" */
var activePadNote = -1; /* Which pad note owns current playback */

/* Gain state */
var gainDb = 0.0;
var peakDb = -100.0;

/* Waveform cache — only re-fetch when visible range changes */
var waveformData = null; /* Array of [min, max] pairs, length 128 */
var cachedVisStart = -1;
var cachedVisEnd = -1;
var waveformDirty = true; /* Force fetch on first draw */

/* Seam waveform cache (loop mode) */
var seamZoomLevel = 4;
var SEAM_ZOOM_STEP = 0.2;
var seamWaveformData = null;
var seamWaveformDirty = true;
var cachedSeamStart = -1;
var cachedSeamEnd = -1;
var cachedSeamHalf = -1;

/* Loop view selected field: 0=start (loop point), 1=end */
var loopSelectedField = 0;

/* Slice state */
var SLICE_MODE_EVEN = 0;
var SLICE_MODE_AUTO = 1;
var SLICE_MODE_LAZY = 2;
var sliceMode = SLICE_MODE_EVEN;

/* Lazy chop sub-modes */
var LAZY_SUB_CHOP = 0;
var LAZY_SUB_PLAY = 1;
var lazySub = LAZY_SUB_CHOP;
var lazyChopping = false;
var sliceCount = 1;
var sliceThreshold = 25.0;
var sliceBoundaries = [];
var selectedSlice = 0;
var sliceRegionStart = 0;
var sliceRegionEnd = 0;
var sliceMenuIndex = 0;
var sliceMenuEditing = false;
var slicePadOffset = 0;  /* pad bank offset (multiples of 32) */

/* Scratch file — all recordings go here, user "Save As" to keep */
var SCRATCH_DIR = "/data/UserData/UserLibrary/Samples/Move Everything/Recordings";
var SCRATCH_PATH = SCRATCH_DIR + "/.wave-edit-scratch.wav";
var SAVE_DIR = SCRATCH_DIR;  /* default destination for saved files */

/* Record state */
var isRecordedFile = false;      /* true if current file came from recording (unsaved) */
var recordState = "idle";        /* "idle" | "ready" | "recording" | "paused" | "stopping" */
var recordStoppingTicks = 0;     /* tick counter while waiting for sampler to finalize */
var recordFilePath = "";         /* auto-generated path */
var recordStartTime = 0;         /* Date.now() when recording started */
var recordPausedTotal = 0;       /* total ms spent paused (for elapsed display) */
var recordPauseStart = 0;        /* Date.now() when pause began */
var recordBrowserDir = "";       /* directory user was browsing */
var recordLedCounter = 0;        /* tick counter for LED flash */
var recordWaveform = null;       /* Array of peak values (0.0-1.0) for live display */
var recordWriteHead = 0;         /* Current write position in recordWaveform */
var RECORD_SCROLL_X = Math.floor(SCREEN_W * 0.90); /* Write head sticks here once reached */

/* REX encoder detection */
var REX_MODULE_PATH = "/data/UserData/move-anything/modules/sound_generators/rex";
var REX_ENCODE_BIN = REX_MODULE_PATH + "/rex-encode";
var REX_LOOPS_DIR = REX_MODULE_PATH + "/loops";

/* Mode menu */
var menuItems = ["Edit", "Loop", "Open File", "Close Session"];
var menuIndex = 0;

/* Open File browser state */
var openFileBrowserState = null;
var OPEN_FILE_FS = {
    readdir: function(path) {
        var entries = os.readdir(path) || [];
        if (Array.isArray(entries[0])) return entries[0];
        return Array.isArray(entries) ? entries : [];
    },
    stat: function(path) {
        return os.stat(path);
    }
};

/* Confirm exit menu */
var confirmItems = ["Save & Exit", "Discard", "Cancel"];
var confirmIndex = 0;

/* Confirm normalize overlay */
var normalizeItems = ["Normalize", "Cancel"];
var normalizeIndex = 0;

/* Confirm save overlay */
var saveName = "";               /* Editable filename (without .wav) shown at top */
var saveActions = [];            /* Action items below the filename */
var saveIndex = 0;               /* 0 = filename row, 1+ = action items */
var saveReturnView = VIEW_TRIM;  /* View to return to after save/cancel */

/**
 * Generate a timestamped recording filename.
 */
/**
 * Refresh the file browser and prepend "New Recording" action item.
 */
function refreshBrowserWithRecording() {
    refreshFilepathBrowser(openFileBrowserState, OPEN_FILE_FS);
    if (openFileBrowserState && openFileBrowserState.items) {
        /* Insert after ".." (up) entry if present, otherwise at top */
        var insertIdx = 0;
        if (openFileBrowserState.items.length > 0 && openFileBrowserState.items[0].kind === "up") {
            insertIdx = 1;
        }
        openFileBrowserState.items.splice(insertIdx, 0, {
            kind: "action",
            label: "+ New Recording",
            path: ""
        });
        /* Adjust selectedIndex if it was at or after the insert point */
        if (openFileBrowserState.selectedIndex >= insertIdx) {
            openFileBrowserState.selectedIndex++;
        }
    }
}

/**
 * Generate a timestamped recording filename.
 */
function generateRecordingPath() {
    /* Always record to scratch file — user does "Save As" to keep */
    if (typeof host_ensure_dir === "function") {
        host_ensure_dir(SCRATCH_DIR);
    }
    return SCRATCH_PATH;
}

function generateDefaultSaveName() {
    var d = new Date();
    var pad2 = function(n) { return n < 10 ? "0" + n : "" + n; };
    return "Recording_" + d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate())
        + "_" + pad2(d.getHours()) + "-" + pad2(d.getMinutes()) + "-" + pad2(d.getSeconds());
}

function isScratchFile() {
    return openedFilePath === SCRATCH_PATH;
}

function nameMatchesCurrent() {
    return ensureWavExt(saveName) === fileName;
}

function leafFolder(path) {
    if (!path) return "";
    var lastSlash = path.lastIndexOf("/");
    if (lastSlash <= 0) return path;
    var dir = path.substring(0, lastSlash);
    var leaf = dir.substring(dir.lastIndexOf("/") + 1);
    return leaf;
}

function ensureWavExt(name) {
    if (name.toLowerCase().indexOf(".wav") !== name.length - 4) {
        return name + ".wav";
    }
    return name;
}

function sanitizeForShell(s) {
    /* Replace single quotes with escaped version for sh -c '...' usage */
    return s.replace(/'/g, "'\\''");
}

function isRexAvailable() {
    return (typeof host_file_exists === "function") &&
        host_file_exists(REX_MODULE_PATH + "/module.json");
}

function getSliceActions() {
    if (isRexAvailable()) {
        return ["Slices", "Drum Preset", "REX Loop", "Cancel"];
    }
    return ["Slices", "Drum Preset", "Cancel"];
}

/**
 * Persist slice state to DSP so it survives hide/reconnect.
 */
function saveSliceState() {
    var state = JSON.stringify({
        mode: sliceMode,
        count: sliceCount,
        boundaries: sliceBoundaries,
        regionStart: sliceRegionStart,
        regionEnd: sliceRegionEnd,
        selected: selectedSlice,
        threshold: sliceThreshold,
        padOffset: slicePadOffset
    });
    host_module_set_param("slice_state", state);
}

/**
 * Restore slice state from DSP on reconnect.
 * Returns true if state was restored, false if no saved state.
 */
function restoreSliceState() {
    var raw = host_module_get_param("slice_state");
    if (!raw || raw.length < 2) return false;
    try {
        var s = JSON.parse(raw);
        if (!s.boundaries || s.boundaries.length < 2) return false;
        sliceMode = s.mode || SLICE_MODE_EVEN;
        sliceCount = s.count || 1;
        sliceBoundaries = s.boundaries;
        sliceRegionStart = s.regionStart || 0;
        sliceRegionEnd = s.regionEnd || totalFrames;
        selectedSlice = s.selected || 0;
        sliceThreshold = s.threshold || 25.0;
        slicePadOffset = s.padOffset || 0;
        return true;
    } catch (e) {
        return false;
    }
}

/* Loop state */
var loopEnabled = false;
var savedLoopState = false;

/* Undo state */
var hasUndo = false;

/* Clipboard state */
var hasClipboard = false;

/* Dirty flag */
var dirty = false;

/* Status message — two modes:
 * 1. Knob-held: persists while knob is touched, per-knob messages
 * 2. Timed: decays after N frames (for button actions like trim, save) */
var statusMsg = "";
var statusTimer = 0;

/* Knob touch tracking — notes 0-7 for knobs 1-8 */
var TOUCH_NOTE_MIN = 0;
var TOUCH_NOTE_MAX = 7;
var knobTouched = [false, false, false, false, false, false, false, false];
var knobStatusMsg = ["", "", "", "", "", "", "", ""];
var knobTouchOrder = []; /* Stack of touched knob indices, most recent last */

/* Jog "virtual touch" — no hardware touch note, so decay on a timer.
 * Each jog turn resets the timer. Participates in the same priority
 * system as knob touches via a special JOG_ID sentinel. */
var JOG_ID = -1;
var jogStatusMsg = "";
var jogHeldTimer = 0;
var JOG_HOLD_FRAMES = 30; /* ~1 second at 30fps */

/* ============ Encoder Helpers ============ */
/*
 * The shadow UI framework batches encoder CCs and delivers one synthetic
 * message per knob per frame. The CC value encodes the accumulated tick
 * count: CW = count (1-63), CCW = 128 - abs(count) (65-127).
 * decodeDelta() extracts the signed count for direct use as a multiplier.
 */

/* ============ LED Helpers ============ */

/* White LED brightness levels — use shared constants */
var LED_OFF = WhiteLedOff;
var LED_DIM = WhiteLedDim;
var LED_MED = WhiteLedMedium;
var LED_BRIGHT = WhiteLedBright;

/* RGB pad colors */
var PAD_COLOR_DIM = DarkGrey;
var PAD_COLOR_PLAY = White;

/* Progressive LED init state */
var ledInitPending = true;
var ledInitIndex = 0;
var LEDS_PER_FRAME = 8;

/**
 * Initialize LEDs progressively (avoid buffer overflow).
 * Lights up buttons with functions and pads for audition.
 */
function initLedsStep() {
    if (!ledInitPending) return;

    var commands = [];

    /* Button LEDs — dim to show they're active */
    commands.push(function() { setButtonLED(CC_MUTE, LED_DIM); });
    commands.push(function() { setButtonLED(CC_DELETE, LED_DIM); });
    commands.push(function() { setButtonLED(CC_COPY, LED_DIM); });
    commands.push(function() { setButtonLED(CC_UNDO, LED_DIM); });
    commands.push(function() { setButtonLED(CC_LOOP, LED_DIM); });
    commands.push(function() { setButtonLED(CC_CAPTURE, LED_DIM); });
    commands.push(function() { setButtonLED(CC_BACK, LED_DIM); });

    /* Pad LEDs — dim grey to show audition is available */
    for (var p = PAD_NOTE_MIN; p <= PAD_NOTE_MAX; p++) {
        commands.push((function(note) {
            return function() { setLED(note, PAD_COLOR_DIM); };
        })(p));
    }

    /* Send a batch per frame */
    var end = ledInitIndex + LEDS_PER_FRAME;
    if (end > commands.length) end = commands.length;
    for (var i = ledInitIndex; i < end; i++) {
        commands[i]();
    }
    ledInitIndex = end;

    if (ledInitIndex >= commands.length) {
        ledInitPending = false;
    }
}

/**
 * Update LEDs based on current state (call after state changes).
 */
function updateLeds() {
    if (ledInitPending) return; /* Don't send until init completes */
    setButtonLED(CC_LOOP, loopEnabled ? LED_BRIGHT : LED_DIM);
    setButtonLED(CC_UNDO, hasUndo ? LED_MED : LED_DIM);
    setButtonLED(CC_COPY, hasClipboard ? LED_MED : LED_DIM);
}

/* ============ Helpers ============ */

/* decodeDelta imported from shared/input_filter.mjs */

/**
 * Truncate a string with ".." suffix if it exceeds maxLen.
 */
function truncate(str, maxLen) {
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen - 2) + "..";
}

/**
 * Format a sample position as seconds string.
 */
function formatTime(samples) {
    if (totalFrames <= 0) return "0.000s";
    var secs = samples / sampleRate;
    return secs.toFixed(3) + "s";
}

/**
 * Format dB value for display.
 */
function formatDb(db) {
    if (db <= -100) return "-inf";
    var sign = db >= 0 ? "+" : "";
    return sign + db.toFixed(1) + "dB";
}

/**
 * Format selection duration for display.
 * Adaptive precision: 3 decimals for <1s, 2 for <10s, 1 for rest.
 */
function formatSelDuration() {
    var dur = Math.abs(endSample - startSample) / sampleRate;
    if (dur < 1) return dur.toFixed(3) + "s";
    if (dur < 10) return dur.toFixed(2) + "s";
    return dur.toFixed(1) + "s";
}

/**
 * Show a temporary status message for a given number of frames.
 * Used for action confirmations (trim, save, copy, etc.).
 */
function showStatus(msg, frames) {
    statusMsg = msg;
    statusTimer = (frames || 60) * 3;
    announce(msg);
}

/**
 * Return the current label+value string for a knob based on the active view.
 * Used to announce knob identity on touch before it is turned.
 */
function getKnobLabel(knobIndex) {
    if (knobIndex === 0) {
        if (currentView === VIEW_TRIM) return shiftHeld ? "S:" + startSample : "Start:" + formatTime(startSample);
        if (currentView === VIEW_LOOP) return shiftHeld ? "S:" + startSample : "Pt:" + formatTime(startSample);
        if (currentView === VIEW_SLICE) return "Start:" + formatTime(sliceBoundaries[selectedSlice]);
    } else if (knobIndex === 1) {
        if (currentView === VIEW_TRIM || currentView === VIEW_LOOP) return shiftHeld ? "E:" + endSample : "End:" + formatTime(endSample);
        if (currentView === VIEW_SLICE) return "End:" + formatTime(sliceBoundaries[selectedSlice + 1]);
    } else if (knobIndex === 2) {
        if (currentView === VIEW_TRIM || currentView === VIEW_SLICE) {
            if (zoomLevel <= 0) return "Zoom: Full";
            return "Zoom:" + Math.pow(2, zoomLevel).toFixed(1) + "x";
        }
        if (currentView === VIEW_LOOP) {
            return "Zoom:" + Math.pow(2, seamZoomLevel).toFixed(1) + "x";
        }
    } else if (knobIndex === 3) {
        return "Scale:" + vScale.toFixed(1) + "x";
    } else if (knobIndex === 4) {
        if (currentView === VIEW_SLICE && sliceMode === SLICE_MODE_AUTO) {
            return "T:" + sliceThreshold.toFixed(1);
        }
        if (currentView === VIEW_TRIM || currentView === VIEW_LOOP) {
            return shiftHeld ? "Normalize" : "Gain:" + formatDb(gainDb);
        }
    }
    return "";
}

/**
 * Set the status message for a specific knob (persists while touched).
 * knobIndex: 0-7 mapping to physical knobs 1-8.
 */
function showKnobStatus(knobIndex, msg) {
    if (knobIndex < 0 || knobIndex > 7) return;
    knobStatusMsg[knobIndex] = msg;
    /* Push this knob to most-recent in touch order */
    pushTouchOrder(knobIndex);
    announce(msg);
}

/**
 * Set the status message for the jog wheel (decays on timer).
 * Each call resets the hold timer and makes jog most-recent.
 */
function showJogStatus(msg) {
    jogStatusMsg = msg;
    jogHeldTimer = JOG_HOLD_FRAMES;
    pushTouchOrder(JOG_ID);
    announce(msg);
}

/**
 * Push an id (knob index or JOG_ID) to the most-recent position
 * in the touch order stack, removing any existing entry first.
 */
function pushTouchOrder(id) {
    for (var t = 0; t < knobTouchOrder.length; t++) {
        if (knobTouchOrder[t] === id) {
            knobTouchOrder.splice(t, 1);
            break;
        }
    }
    knobTouchOrder.push(id);
}

/**
 * Get the current status message to display.
 * Priority: timed message > most recently active control > nothing.
 * Controls are active if: knob is touched, or jog timer is running.
 */
function getActiveStatus() {
    /* Timed messages (action confirmations) take priority */
    if (statusTimer > 0) return statusMsg;
    /* Walk touch order from most recent to oldest */
    for (var i = knobTouchOrder.length - 1; i >= 0; i--) {
        var id = knobTouchOrder[i];
        if (id === JOG_ID) {
            if (jogHeldTimer > 0 && jogStatusMsg !== "") return jogStatusMsg;
        } else {
            if (knobTouched[id] && knobStatusMsg[id] !== "") return knobStatusMsg[id];
        }
    }
    return "";
}

/**
 * Get adaptive coarse step size based on zoom level and file length.
 * At zoom 0, step is large for quick navigation.
 * At higher zoom, step is finer for precision.
 */
function getCoarseStep() {
    if (totalFrames <= 0) return 1;
    var visibleRange = getVisibleEnd() - getVisibleStart();
    /* Step is 1 pixel worth of samples — minimum useful movement */
    var step = Math.floor(visibleRange / SCREEN_W);
    if (step < 1) step = 1;
    return step;
}

/**
 * Get the number of visible samples at the current zoom level.
 * Minimum 128 samples (1 sample per pixel).
 */
function getVisibleSamples() {
    if (zoomLevel <= 0 || totalFrames <= 0) return totalFrames;
    var vis = Math.floor(totalFrames / Math.pow(2, zoomLevel));
    if (vis < 128) vis = 128;
    return vis;
}

/**
 * Get the starting sample of the visible window based on zoom.
 */
function getVisibleStart() {
    if (zoomLevel <= 0 || totalFrames <= 0) return 0;
    var visibleSamples = getVisibleSamples();
    var center = zoomCenter;
    var start = center - Math.floor(visibleSamples / 2);
    if (start < 0) start = 0;
    if (start + visibleSamples > totalFrames) start = totalFrames - visibleSamples;
    if (start < 0) start = 0;
    return start;
}

/**
 * Get the ending sample of the visible window based on zoom.
 */
function getVisibleEnd() {
    if (zoomLevel <= 0 || totalFrames <= 0) return totalFrames;
    var visibleSamples = getVisibleSamples();
    var start = getVisibleStart();
    var end = start + visibleSamples;
    if (end > totalFrames) end = totalFrames;
    return end;
}

/**
 * Convert a sample position to a pixel x coordinate in the waveform area.
 * Returns -1 if the sample is outside the visible range.
 */
function sampleToPixel(sample) {
    var vStart = getVisibleStart();
    var vEnd = getVisibleEnd();
    var range = vEnd - vStart;
    if (range <= 0) return -1;
    var x = Math.floor(((sample - vStart) / range) * SCREEN_W);
    if (x < 0 || x >= SCREEN_W) return -1;
    return x;
}

/**
 * Adjust a marker (start=0, end=1) by deltaSamples. Clamps to valid range.
 * Ensures start <= end. Auto-scrolls view to keep the active marker visible.
 */
function adjustMarker(field, deltaSamples) {
    if (field === 0) {
        startSample += deltaSamples;
        if (startSample < 0) startSample = 0;
        if (startSample > endSample) startSample = endSample;
    } else {
        endSample += deltaSamples;
        if (endSample > totalFrames) endSample = totalFrames;
        if (endSample < startSample) endSample = startSample;
    }

    /* Auto-scroll: keep active marker within 10%-90% of visible window */
    if (zoomLevel > 0) {
        var markerPos = (field === 0) ? startSample : endSample;
        var vStart = getVisibleStart();
        var vEnd = getVisibleEnd();
        var vRange = vEnd - vStart;
        var margin = Math.floor(vRange * 0.10);

        if (markerPos < vStart + margin) {
            /* Marker near left edge — scroll left */
            zoomCenter = markerPos + Math.floor(vRange / 2) - margin;
        } else if (markerPos > vEnd - margin) {
            /* Marker near right edge — scroll right */
            zoomCenter = markerPos - Math.floor(vRange / 2) + margin;
        }
        /* Clamp zoomCenter */
        if (zoomCenter < 0) zoomCenter = 0;
        if (zoomCenter > totalFrames) zoomCenter = totalFrames;
    }

    syncMarkersToDs();
}

/**
 * Send current marker positions to DSP.
 * Combined into a single param to avoid fire-and-forget race
 * in overtake mode where rapid sequential calls overwrite each other.
 */
function syncMarkersToDs() {
    host_module_set_param("markers", startSample + "," + endSample);
}

/**
 * Sync zoom and refresh waveform.
 * Zoom params are encoded in the waveform GET request to avoid
 * fire-and-forget race (SET is lost when followed by GET).
 */
function syncZoomToDsp() {
    refreshWaveform();
}

/* ============ DSP Communication ============ */

/**
 * Fetch file info from DSP.
 */
function refreshFileInfo() {
    var raw = host_module_get_param("file_info");
    if (!raw) return;
    try {
        var info = JSON.parse(raw);
        fileName = info.name || "";
        if (isScratchFile()) fileName = "New Recording";
        fileDuration = info.duration || 0;
        totalFrames = info.frames || 0;
        startSample = info.start || 0;
        endSample = info.end || totalFrames;
        /* Fetch sample rate separately */
        var srRaw = host_module_get_param("sample_rate");
        if (srRaw) sampleRate = parseInt(srRaw, 10) || 44100;
    } catch (e) {
        /* ignore parse errors */
    }
}

/**
 * Fetch waveform data from DSP. Returns array of [min, max] pairs.
 * Only call when markers or zoom change, not every tick.
 */
function refreshWaveform() {
    var vStart = getVisibleStart();
    var vEnd = getVisibleEnd();

    /* Skip the expensive round-trip if visible range hasn't changed */
    if (!waveformDirty && vStart === cachedVisStart && vEnd === cachedVisEnd && waveformData) {
        return;
    }

    var raw = host_module_get_param("waveform:" + vStart + "," + vEnd);
    if (!raw) {
        waveformData = null;
        return;
    }
    try {
        waveformData = JSON.parse(raw);
        cachedVisStart = vStart;
        cachedVisEnd = vEnd;
        waveformDirty = false;
    } catch (e) {
        waveformData = null;
    }
}

/**
 * Load a WAV file into the editor via DSP. Uses blocking set_param to ensure
 * the file_path is delivered before querying file_info/waveform. In overtake
 * mode the normal set_param is fire-and-forget and rapid writes can overwrite
 * each other in the single shared-memory IPC slot.
 */
function loadFileIntoEditor(filePath) {
    if (typeof host_module_set_param_blocking === "function") {
        host_module_set_param_blocking("file_path", filePath, 2000);
    } else {
        host_module_set_param("file_path", filePath);
    }
    host_module_set_param("dirty", "1");
    refreshFileInfo();
    waveformDirty = true;
    refreshWaveform();
    refreshState();
}

/**
 * Mark waveform cache stale (call after destructive edits).
 */
function invalidateWaveform() {
    waveformDirty = true;
    seamWaveformDirty = true;
    refreshWaveform();
}

/**
 * Get the number of samples per half of the seam view (64 columns).
 */
function getSeamHalfSamples() {
    return Math.floor(64 * Math.pow(2, seamZoomLevel));
}

/**
 * Get coarse step for loop mode (1 pixel worth of seam samples).
 */
function getLoopCoarseStep() {
    var halfSamples = getSeamHalfSamples();
    var step = Math.floor(halfSamples / 64);
    if (step < 1) step = 1;
    return step;
}

/**
 * Fetch seam waveform data from DSP. Returns array of [min, max] pairs.
 * Only re-fetch when markers or seam zoom changes.
 */
function refreshSeamWaveform() {
    var halfSamples = getSeamHalfSamples();

    if (!seamWaveformDirty &&
        startSample === cachedSeamStart &&
        endSample === cachedSeamEnd &&
        halfSamples === cachedSeamHalf &&
        seamWaveformData) {
        return;
    }

    var raw = host_module_get_param("seam_waveform:" + startSample + "," + endSample + "," + halfSamples);
    if (!raw) {
        seamWaveformData = null;
        return;
    }
    try {
        seamWaveformData = JSON.parse(raw);
        cachedSeamStart = startSample;
        cachedSeamEnd = endSample;
        cachedSeamHalf = halfSamples;
        seamWaveformDirty = false;
    } catch (e) {
        seamWaveformData = null;
    }
}

/**
 * Mark seam waveform cache stale.
 */
function invalidateSeamWaveform() {
    seamWaveformDirty = true;
    refreshSeamWaveform();
}

/* ============ Slice Helpers ============ */

/**
 * Parse raw waveform JSON string into array of [min, max] pairs.
 */
function parseWaveformData(raw) {
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (e) {
        return null;
    }
}

/**
 * Recompute slice boundaries based on current mode.
 */
function recomputeSliceBoundaries() {
    if (sliceMode === SLICE_MODE_LAZY) {
        /* Lazy: keep existing boundaries; init single slice if empty */
        if (sliceBoundaries.length < 2) {
            sliceBoundaries = [sliceRegionStart, sliceRegionEnd];
            sliceCount = 1;
        }
    } else if (sliceMode === SLICE_MODE_EVEN) {
        var regionLen = sliceRegionEnd - sliceRegionStart;
        sliceBoundaries = [];
        for (var i = 0; i <= sliceCount; i++) {
            sliceBoundaries.push(sliceRegionStart + Math.round((regionLen * i) / sliceCount));
        }
    } else {
        /* Auto: transient detection */
        var onsets = detectTransients(sliceRegionStart, sliceRegionEnd, sliceThreshold);
        sliceBoundaries = [sliceRegionStart];
        for (var j = 0; j < onsets.length; j++) {
            sliceBoundaries.push(onsets[j]);
        }
        sliceBoundaries.push(sliceRegionEnd);
        sliceCount = sliceBoundaries.length - 1;
        if (sliceCount < 1) sliceCount = 1;
    }
    /* Clamp selected slice */
    if (selectedSlice >= sliceCount) selectedSlice = sliceCount - 1;
    if (selectedSlice < 0) selectedSlice = 0;
}

/**
 * Detect transients in waveform data using amplitude jumps.
 * Returns array of sample positions where onsets occur.
 */
function detectTransients(start, end, threshold) {
    var raw = host_module_get_param("waveform:" + start + "," + end);
    var data = parseWaveformData(raw);
    if (!data || data.length < 2) return [];

    var regionLen = end - start;
    var samplesPerBin = regionLen / data.length;
    var onsets = [];
    var thresh = threshold / 100.0;

    /* Compute per-bin amplitude */
    var amps = [];
    for (var i = 0; i < data.length; i++) {
        var amp = Math.max(Math.abs(data[i][0]), Math.abs(data[i][1]));
        amps.push(amp);
    }

    /* Detect amplitude jumps exceeding threshold */
    for (var i = 1; i < amps.length; i++) {
        var jump = amps[i] - amps[i - 1];
        if (jump > thresh) {
            var pos = start + Math.round(i * samplesPerBin);
            /* Minimum distance from previous onset: 4 bins */
            if (onsets.length === 0 || (pos - onsets[onsets.length - 1]) > samplesPerBin * 4) {
                onsets.push(pos);
            }
        }
    }

    /* Cap at 128 slices max */
    if (onsets.length > 127) onsets = onsets.slice(0, 127);
    return onsets;
}

/**
 * Select a slice by index. Updates start/end markers and syncs to DSP.
 */
function selectSlice(idx) {
    if (idx < 0 || idx >= sliceCount) return;
    selectedSlice = idx;
    startSample = sliceBoundaries[idx];
    endSample = sliceBoundaries[idx + 1];

    /* Auto-scroll: position slice start at 10% from left edge,
     * slice end at 90% — matching trim mode's margin style.
     * If the slice is wider than 80% of the view, prioritize start at 10%. */
    if (zoomLevel > 0) {
        var vStart = getVisibleStart();
        var vEnd = getVisibleEnd();
        var vRange = vEnd - vStart;
        var margin = Math.floor(vRange * 0.10);
        var sliceLen = endSample - startSample;

        if (startSample < vStart + margin || endSample > vEnd - margin) {
            if (sliceLen <= vRange - 2 * margin) {
                /* Slice fits within 10%-90% — place start at 10% */
                zoomCenter = startSample - margin + Math.floor(vRange / 2);
            } else {
                /* Slice wider than 80% of view — prioritize start at 10% */
                zoomCenter = startSample - margin + Math.floor(vRange / 2);
            }
            if (zoomCenter < 0) zoomCenter = 0;
            if (zoomCenter > totalFrames) zoomCenter = totalFrames;
        }
    }

    waveformDirty = true;
}

/**
 * Update pad LEDs for slice mode.
 */
function updateSlicePadLeds() {
    if (ledInitPending) return;
    if (sliceMode === SLICE_MODE_LAZY && lazySub === LAZY_SUB_CHOP) {
        updateLazyChopPadLeds();
        return;
    }
    for (var i = 0; i < 32; i++) {
        var padNote = PAD_NOTE_MIN + i;
        var sliceIdx = slicePadOffset + i;
        if (sliceIdx < sliceCount) {
            if (sliceIdx === selectedSlice) {
                setLED(padNote, White);
            } else {
                setLED(padNote, PAD_COLOR_DIM);
            }
        } else {
            setLED(padNote, Black);
        }
    }
    /* Persist slice state to DSP for reconnect */
    saveSliceState();
}

/**
 * Pad LEDs for lazy chop sub-mode.
 */
function updateLazyChopPadLeds() {
    for (var i = 0; i < 32; i++) {
        var padNote = PAD_NOTE_MIN + i;
        if (i === 0) {
            /* Pad 1 = red chop trigger */
            setLED(padNote, BrightRed);
        } else if (lazyChopping && i < sliceCount) {
            /* Completed slice pads */
            if (i === sliceCount - 1) {
                setLED(padNote, White); /* current active slice */
            } else {
                setLED(padNote, PAD_COLOR_DIM);
            }
        } else {
            setLED(padNote, Black);
        }
    }
}

/**
 * Refresh play state, undo, dirty flags from DSP.
 */
function refreshState() {
    var raw;

    raw = host_module_get_param("has_undo");
    hasUndo = (raw === "1" || raw === "true");

    raw = host_module_get_param("has_clipboard");
    hasClipboard = (raw === "1" || raw === "true");

    raw = host_module_get_param("dirty");
    dirty = (raw === "1" || raw === "true");

    raw = host_module_get_param("play_loop");
    loopEnabled = (raw === "1" || raw === "true");

    raw = host_module_get_param("gain_db");
    if (raw) { var v = parseFloat(raw); if (!isNaN(v)) gainDb = v; }

    raw = host_module_get_param("peak_db");
    if (raw) { var v2 = parseFloat(raw); if (!isNaN(v2)) peakDb = v2; }
}

/* ============ Drawing: Common ============ */

/**
 * Draw horizontal divider line.
 */
function drawDivider(y) {
    draw_line(0, y, SCREEN_W - 1, y, 1);
}

/**
 * Print text centered horizontally at the given y coordinate.
 */
function printCentered(y, text) {
    var tw = text.length * 6;
    var x = Math.floor((SCREEN_W - tw) / 2);
    if (x < 0) x = 0;
    print(x, y, text, 1);
}

/**
 * Build mode header string with indicators.
 * Format: "MODE*L" where * = dirty, L = loop enabled.
 */
function buildModeHeader(modeName) {
    var s = modeName;
    if (dirty) s += "*";
    if (loopEnabled) s += " L";
    return s;
}

/**
 * Draw the waveform in the waveform area.
 * In-selection region draws solid lines; outside-selection draws endpoints only.
 */
function drawWaveform() {
    if (!waveformData || waveformData.length === 0) {
        print(20, WAVE_MID - 3, "No waveform data", 1);
        return;
    }

    var vStart = getVisibleStart();
    var vEnd = getVisibleEnd();
    var vRange = vEnd - vStart;

    /* Compute selection pixel range */
    var selStartPx = -1;
    var selEndPx = SCREEN_W;
    if (vRange > 0) {
        selStartPx = Math.floor(((startSample - vStart) / vRange) * SCREEN_W);
        selEndPx = Math.floor(((endSample - vStart) / vRange) * SCREEN_W);
    }

    var halfH = WAVE_HEIGHT / 2;
    var gainLinear = (gainDb !== 0.0) ? Math.pow(10, gainDb / 20) : 1.0;

    for (var x = 0; x < SCREEN_W && x < waveformData.length; x++) {
        var pair = waveformData[x];
        var minVal = pair[0] * vScale * gainLinear; /* Apply vertical scale + gain */
        var maxVal = pair[1] * vScale * gainLinear;

        /* Clamp after scaling */
        if (minVal < -1) minVal = -1;
        if (minVal > 1) minVal = 1;
        if (maxVal < -1) maxVal = -1;
        if (maxVal > 1) maxVal = 1;

        /* Map -1..1 to pixel y range */
        var yMin = Math.round(WAVE_MID - maxVal * halfH);
        var yMax = Math.round(WAVE_MID - minVal * halfH);

        /* Clamp to waveform area */
        if (yMin < WAVE_Y_TOP) yMin = WAVE_Y_TOP;
        if (yMax > WAVE_Y_BOT - 1) yMax = WAVE_Y_BOT - 1;
        if (yMin > WAVE_Y_BOT - 1) yMin = WAVE_Y_BOT - 1;
        if (yMax < WAVE_Y_TOP) yMax = WAVE_Y_TOP;

        var inSelection = (x >= selStartPx && x <= selEndPx);

        if (inSelection) {
            /* Draw solid vertical line for in-selection */
            if (yMin === yMax) {
                set_pixel(x, yMin, 1);
            } else {
                draw_line(x, yMin, x, yMax, 1);
            }
        } else {
            /* Draw only top and bottom pixels for outside-selection (dimmed) */
            set_pixel(x, yMin, 1);
            if (yMax !== yMin) {
                set_pixel(x, yMax, 1);
            }
        }
    }

    /* Draw start marker */
    var startPx = sampleToPixel(startSample);
    if (startPx >= 0 && startPx < SCREEN_W) {
        for (var y = WAVE_Y_TOP; y < WAVE_Y_BOT; y += 2) {
            set_pixel(startPx, y, 1);
        }
    }

    /* Draw end marker */
    var endPx = sampleToPixel(endSample);
    if (endPx >= 0 && endPx < SCREEN_W) {
        for (var y = WAVE_Y_TOP; y < WAVE_Y_BOT; y += 2) {
            set_pixel(endPx, y, 1);
        }
    }

    /* Draw playhead */
    if (playing) {
        var playPx = sampleToPixel(playPos);
        if (playPx >= 0 && playPx < SCREEN_W) {
            for (var y = WAVE_Y_TOP; y < WAVE_Y_BOT; y++) {
                if (y % 3 !== 0) {
                    set_pixel(playPx, y, 1);
                }
            }
        }
    }

    /* Zoom minimap — thin bar at bottom of waveform showing viewport position */
    if (zoomLevel > 0 && totalFrames > 0) {
        var mapY = WAVE_Y_BOT;
        /* Base line showing full file extent */
        draw_line(0, mapY, SCREEN_W - 1, mapY, 1);
        /* Thick bar showing visible viewport within the file */
        var vpStartPx = Math.floor((vStart / totalFrames) * SCREEN_W);
        var vpEndPx = Math.floor((vEnd / totalFrames) * SCREEN_W);
        if (vpEndPx <= vpStartPx) vpEndPx = vpStartPx + 1;
        fill_rect(vpStartPx, mapY - 1, vpEndPx - vpStartPx, 3, 1);
    }
}

/* ============ Drawing: Trim View ============ */

function drawTrimView() {
    clear_screen();

    /* Record-ready state: empty waveform, waiting for REC press */
    if (recordState === "ready") {
        print(0, 0, "NEW RECORDING", 1);
        drawDivider(10);
        /* Empty waveform area with centered prompt */
        draw_line(0, WAVE_MID, SCREEN_W - 1, WAVE_MID, 1);
        printCentered(WAVE_MID - 10, "Press REC");
        printCentered(WAVE_MID + 4, "to record");
        drawDivider(WAVE_Y_BOT + 1);
        printCentered(54, "Back: cancel");
        return;
    }

    /* Stopping state: waiting for WAV to finalize */
    if (recordState === "stopping") {
        print(0, 0, "SAVING...", 1);
        drawDivider(10);
        draw_line(0, WAVE_MID, SCREEN_W - 1, WAVE_MID, 1);
        printCentered(WAVE_MID - 4, "Finalizing recording");
        drawDivider(WAVE_Y_BOT + 1);
        return;
    }

    /* Recording state: scrolling waveform + elapsed timer */
    if (recordState === "recording") {
        /* Sample VU peak and append to waveform buffer */
        var peak = 0;
        if (typeof shadow_get_overlay_state === "function") {
            var ov = shadow_get_overlay_state();
            if (ov && typeof ov.samplerVuPeak === "number") {
                peak = ov.samplerVuPeak / 32767.0;
            }
        }
        recordWaveform.push(peak);
        recordWriteHead++;

        /* Header: REC + elapsed time (excluding paused intervals) */
        var elapsed = (Date.now() - recordStartTime - recordPausedTotal) / 1000;
        var mins = Math.floor(elapsed / 60);
        var secs = elapsed % 60;
        var timeStr = mins + ":" + (secs < 10 ? "0" : "") + secs.toFixed(1);
        print(0, 0, "REC  " + timeStr, 1);
        drawDivider(10);

        /* Draw live waveform with write head.
         * Phase 1: head < RECORD_SCROLL_X — draw from x=0, head advances right.
         * Phase 2: head >= RECORD_SCROLL_X — head stays at RECORD_SCROLL_X,
         *          older data scrolls left behind it. */
        var halfH = WAVE_HEIGHT / 2;
        var dataLen = recordWaveform.length;
        var headX; /* screen x of write head */
        var dataOffset; /* index into recordWaveform for x=0 */

        if (dataLen <= RECORD_SCROLL_X) {
            /* Phase 1: filling in from left */
            headX = dataLen - 1;
            dataOffset = 0;
        } else {
            /* Phase 2: scrolling — head pinned at RECORD_SCROLL_X */
            headX = RECORD_SCROLL_X;
            dataOffset = dataLen - RECORD_SCROLL_X - 1;
        }

        for (var x = 0; x <= headX; x++) {
            var amp = recordWaveform[dataOffset + x];
            if (amp <= 0) continue;
            var h = Math.round(amp * halfH);
            if (h < 1) h = 1;
            draw_line(x, WAVE_MID - h, x, WAVE_MID + h, 1);
        }

        /* Draw write head cursor */
        draw_line(headX, WAVE_Y_TOP, headX, WAVE_Y_BOT, 1);

        drawDivider(WAVE_Y_BOT + 1);
        printCentered(54, "REC: stop  Sh+REC: pause");
        return;
    }

    /* Paused state: frozen waveform + PAUSED indicator */
    if (recordState === "paused") {
        var elapsed = (Date.now() - recordStartTime - recordPausedTotal - (Date.now() - recordPauseStart)) / 1000;
        var mins = Math.floor(elapsed / 60);
        var secs = elapsed % 60;
        var timeStr = mins + ":" + (secs < 10 ? "0" : "") + secs.toFixed(1);
        print(0, 0, "PAUSED  " + timeStr, 1);
        drawDivider(10);

        /* Draw frozen waveform (no new data appended) */
        if (recordWaveform && recordWaveform.length > 0) {
            var halfH = WAVE_HEIGHT / 2;
            var dataLen = recordWaveform.length;
            var headX;
            var dataOffset;

            if (dataLen <= RECORD_SCROLL_X) {
                headX = dataLen - 1;
                dataOffset = 0;
            } else {
                headX = RECORD_SCROLL_X;
                dataOffset = dataLen - RECORD_SCROLL_X - 1;
            }

            for (var x = 0; x <= headX; x++) {
                var amp = recordWaveform[dataOffset + x];
                if (amp <= 0) continue;
                var h = Math.round(amp * halfH);
                if (h < 1) h = 1;
                draw_line(x, WAVE_MID - h, x, WAVE_MID + h, 1);
            }

            /* Blinking write head cursor */
            recordLedCounter++;
            if (recordLedCounter % 30 < 15) {
                draw_line(headX, WAVE_Y_TOP, headX, WAVE_Y_BOT, 1);
            }
        } else {
            draw_line(0, WAVE_MID, SCREEN_W - 1, WAVE_MID, 1);
        }

        drawDivider(WAVE_Y_BOT + 1);
        printCentered(54, "REC: resume");
        return;
    }

    /* Header: MODE*L  filename.wav  1.2s */
    var modeStr = buildModeHeader("TRIM");
    print(0, 0, modeStr, 1);
    var nameX = (modeStr.length + 1) * 6;
    var maxNameChars = Math.floor((SCREEN_W - nameX - 36) / 6);
    if (maxNameChars < 4) maxNameChars = 4;
    var dispName = truncate(fileName, maxNameChars);
    print(nameX, 0, dispName, 1);
    var durStr = fileDuration > 0 ? fileDuration.toFixed(1) + "s" : "";
    var durX = SCREEN_W - durStr.length * 6;
    print(durX, 0, durStr, 1);

    /* Top divider */
    drawDivider(10);

    /* Waveform area */
    drawWaveform();

    /* Bottom divider */
    drawDivider(WAVE_Y_BOT + 1);

    /* Footer: active status (centered) or marker positions */
    var footerStatus = getActiveStatus();
    if (footerStatus !== "") {
        printCentered(54, footerStatus);
    } else {
        var startStr = "S:" + formatTime(startSample);
        var endStr = "E:" + formatTime(endSample);

        if (selectedField === 0) {
            print(0, 54, ">", 1);
            print(6, 54, startStr, 1);
            var ex = SCREEN_W - endStr.length * 6;
            if (ex < 70) ex = 70;
            print(ex, 54, endStr, 1);
        } else {
            print(0, 54, startStr, 1);
            var ex2 = SCREEN_W - (endStr.length + 1) * 6;
            if (ex2 < 60) ex2 = 60;
            print(ex2, 54, ">", 1);
            print(ex2 + 6, 54, endStr, 1);
        }
    }
}

/* ============ Drawing: Loop View ============ */

/**
 * Draw the seam waveform in the waveform area.
 * 128 columns: left 64 approach loop end, right 64 continue from loop start.
 * Center dashed line at x=64 marks the seam point.
 */
function drawSeamWaveform() {
    if (!seamWaveformData || seamWaveformData.length === 0) {
        print(20, WAVE_MID - 3, "No seam data", 1);
        return;
    }

    var halfH = WAVE_HEIGHT / 2;
    var gainLinear = (gainDb !== 0.0) ? Math.pow(10, gainDb / 20) : 1.0;

    for (var x = 0; x < SCREEN_W && x < seamWaveformData.length; x++) {
        var pair = seamWaveformData[x];
        var minVal = pair[0] * vScale * gainLinear;
        var maxVal = pair[1] * vScale * gainLinear;

        if (minVal < -1) minVal = -1;
        if (minVal > 1) minVal = 1;
        if (maxVal < -1) maxVal = -1;
        if (maxVal > 1) maxVal = 1;

        var yMin = Math.round(WAVE_MID - maxVal * halfH);
        var yMax = Math.round(WAVE_MID - minVal * halfH);

        if (yMin < WAVE_Y_TOP) yMin = WAVE_Y_TOP;
        if (yMax > WAVE_Y_BOT - 1) yMax = WAVE_Y_BOT - 1;
        if (yMin > WAVE_Y_BOT - 1) yMin = WAVE_Y_BOT - 1;
        if (yMax < WAVE_Y_TOP) yMax = WAVE_Y_TOP;

        if (yMin === yMax) {
            set_pixel(x, yMin, 1);
        } else {
            draw_line(x, yMin, x, yMax, 1);
        }
    }

    /* Dashed center line at x=64 (the seam junction) */
    for (var y = WAVE_Y_TOP; y < WAVE_Y_BOT; y += 2) {
        set_pixel(64, y, 1);
    }

    /* Draw playhead if playing */
    if (playing) {
        /* Map play position into seam view coordinates */
        var halfSamples = getSeamHalfSamples();
        var leftStart = endSample - halfSamples;
        if (leftStart < 0) leftStart = 0;
        var playPx = -1;

        /* Check if playhead is in the left half (approaching end) */
        if (playPos >= leftStart && playPos <= endSample) {
            var range = endSample - leftStart;
            if (range > 0) playPx = Math.floor(((playPos - leftStart) / range) * 64);
        }
        /* Check if playhead is in the right half (after loop start) */
        var rightEnd = startSample + halfSamples;
        if (rightEnd > totalFrames) rightEnd = totalFrames;
        if (playPos >= startSample && playPos <= rightEnd) {
            var range2 = rightEnd - startSample;
            if (range2 > 0) playPx = 64 + Math.floor(((playPos - startSample) / range2) * 64);
        }

        if (playPx >= 0 && playPx < SCREEN_W) {
            for (var y = WAVE_Y_TOP; y < WAVE_Y_BOT; y++) {
                if (y % 3 !== 0) {
                    set_pixel(playPx, y, 1);
                }
            }
        }
    }
}

/**
 * Draw the Loop mode view (Akai S1000-style seam view).
 */
function drawLoopView() {
    clear_screen();

    /* Header: LOOP*L  filename.wav  1.2s */
    var modeStr = buildModeHeader("LOOP");
    print(0, 0, modeStr, 1);
    var nameX = (modeStr.length + 1) * 6;
    var maxNameChars = Math.floor((SCREEN_W - nameX - 36) / 6);
    if (maxNameChars < 4) maxNameChars = 4;
    var dispName = truncate(fileName, maxNameChars);
    print(nameX, 0, dispName, 1);
    var durStr = fileDuration > 0 ? fileDuration.toFixed(1) + "s" : "";
    var durX = SCREEN_W - durStr.length * 6;
    print(durX, 0, durStr, 1);

    /* Top divider */
    drawDivider(10);

    /* Seam waveform area */
    refreshSeamWaveform();
    drawSeamWaveform();

    /* Bottom divider */
    drawDivider(WAVE_Y_BOT + 1);

    /* Footer: active status or loop point/length info */
    var footerStatus = getActiveStatus();
    if (footerStatus !== "") {
        printCentered(54, footerStatus);
    } else {
        var ptStr = "Pt:" + formatTime(startSample);
        var lenStr = "Len:" + formatSelDuration();

        if (loopSelectedField === 0) {
            print(0, 54, ">", 1);
            print(6, 54, ptStr, 1);
            var lx = SCREEN_W - lenStr.length * 6;
            if (lx < 70) lx = 70;
            print(lx, 54, lenStr, 1);
        } else {
            print(0, 54, ptStr, 1);
            var lx2 = SCREEN_W - (lenStr.length + 1) * 6;
            if (lx2 < 60) lx2 = 60;
            print(lx2, 54, ">", 1);
            print(lx2 + 6, 54, lenStr, 1);
        }
    }
}

/* ============ Drawing: Slice View ============ */

/**
 * Draw slice boundary lines on the waveform (dashed, every 3rd pixel).
 * Draws all boundaries. The outer edges (region start/end) are drawn
 * only when they don't belong to the currently selected slice (which
 * already has start/end markers from the normal marker drawing).
 */
function drawSliceBoundaryLines() {
    var vStart = getVisibleStart();
    var vEnd = getVisibleEnd();
    var vRange = vEnd - vStart;
    if (vRange <= 0) return;

    for (var i = 0; i < sliceBoundaries.length; i++) {
        /* Skip boundaries that are the selected slice's start/end —
         * those are already shown by the normal start/end markers. */
        if (i === selectedSlice || i === selectedSlice + 1) continue;

        var bx = Math.floor(((sliceBoundaries[i] - vStart) / vRange) * SCREEN_W);
        if (bx >= 0 && bx < SCREEN_W) {
            for (var y = WAVE_Y_TOP; y < WAVE_Y_BOT; y += 3) {
                set_pixel(bx, y, 1);
            }
        }
    }
}

/**
 * Draw the Slice mode view.
 */
function drawSliceView() {
    refreshWaveform();
    clear_screen();

    /* Header: SLICE*L  filename.wav  1.2s */
    var modeStr = buildModeHeader("SLICE");
    print(0, 0, modeStr, 1);
    var nameX = (modeStr.length + 1) * 6;
    var maxNameChars = Math.floor((SCREEN_W - nameX - 36) / 6);
    if (maxNameChars < 4) maxNameChars = 4;
    var dispName = truncate(fileName, maxNameChars);
    print(nameX, 0, dispName, 1);
    var durStr = fileDuration > 0 ? fileDuration.toFixed(1) + "s" : "";
    var durX = SCREEN_W - durStr.length * 6;
    print(durX, 0, durStr, 1);

    /* Top divider */
    drawDivider(10);

    /* Waveform area — show the whole sliced region */
    drawWaveform();

    /* Overlay slice boundary lines */
    drawSliceBoundaryLines();

    /* Bottom divider */
    drawDivider(WAVE_Y_BOT + 1);

    /* Footer: active status or slice info */
    var footerStatus = getActiveStatus();
    if (footerStatus !== "") {
        printCentered(54, footerStatus);
    } else {
        /* Build footer items based on slice menu */
        var modeLabel = sliceMode === SLICE_MODE_EVEN ? "Even" : (sliceMode === SLICE_MODE_AUTO ? "Auto" : "Lazy");
        var countLabel;
        if (sliceMode === SLICE_MODE_LAZY) {
            countLabel = lazySub === LAZY_SUB_CHOP ? "Chop" : "Play";
        } else if (sliceMode === SLICE_MODE_EVEN) {
            countLabel = "" + sliceCount;
        } else {
            countLabel = "T:" + sliceThreshold.toFixed(1);
        }
        var selLabel = (selectedSlice + 1) + "/" + sliceCount;
        if (sliceCount > 32) {
            var bankNum = Math.floor(slicePadOffset / 32) + 1;
            selLabel += " P" + bankNum;
        }
        var timeLabel = formatTime(startSample);

        /* Draw footer items with visual distinction:
         * - Focused (navigating): [brackets]
         * - Editing (active): inverse highlight (filled rect + dark text) */
        var labels = [modeLabel, countLabel, selLabel];
        var CHAR_W = 6; /* 5px char + 1px gap */
        var footerY = 54;
        var x = 0;
        for (var fi = 0; fi < 3; fi++) {
            var label = labels[fi];
            var isFocused = (fi === sliceMenuIndex);
            var isEditing = isFocused && sliceMenuEditing;
            if (isEditing) {
                /* Inverse: filled rect behind text */
                var tw = label.length * CHAR_W + 2;
                fill_rect(x, footerY - 1, tw, 9, 1);
                print(x + 1, footerY, label, 0);
                x += tw + 2;
            } else if (isFocused) {
                /* Brackets to show focus */
                print(x, footerY, "[" + label + "]", 1);
                x += (label.length + 2) * CHAR_W + 2;
            } else {
                print(x, footerY, label, 1);
                x += label.length * CHAR_W + 2;
            }
        }
        /* Append time label */
        print(x, footerY, timeLabel, 1);
    }
}

/* ============ Drawing: Mode Menu ============ */

function drawModeMenu() {
    clear_screen();

    /* Header */
    print(0, 0, "WAVEFORM EDITOR", 1);
    drawDivider(10);

    /* Menu items */
    var itemH = 12;
    var startY = 14;

    for (var i = 0; i < menuItems.length; i++) {
        var y = startY + i * itemH;
        if (y + itemH > SCREEN_H) break;

        if (i === menuIndex) {
            fill_rect(0, y, SCREEN_W, itemH, 1);
            print(4, y + 2, menuItems[i], 0);
        } else {
            print(4, y + 2, menuItems[i], 1);
        }
    }

    /* Footer hint */
    drawDivider(SCREEN_H - 9);
    print(2, SCREEN_H - 7, "Jog:select  Back:exit", 1);
}

/* ============ Drawing: Confirm Exit ============ */

function drawConfirmExit() {
    clear_screen();

    /* Title */
    print(16, 2, "Unsaved changes", 1);
    drawDivider(12);

    /* Options */
    var startY = 18;
    var itemH = 14;

    for (var i = 0; i < confirmItems.length; i++) {
        var y = startY + i * itemH;

        if (i === confirmIndex) {
            fill_rect(0, y, SCREEN_W, itemH, 1);
            print(8, y + 3, confirmItems[i], 0);
        } else {
            print(8, y + 3, confirmItems[i], 1);
        }
    }
}

/* ============ Drawing: Confirm Normalize ============ */

function drawConfirmNormalize() {
    clear_screen();

    /* Title */
    printCentered(2, "Normalize to -0.3dB?");
    drawDivider(12);

    /* Info: show current peak */
    var peakStr = "Peak: " + formatDb(peakDb);
    printCentered(18, peakStr);

    /* Options */
    var startY = 30;
    var itemH = 14;

    for (var i = 0; i < normalizeItems.length; i++) {
        var y = startY + i * itemH;

        if (i === normalizeIndex) {
            fill_rect(0, y, SCREEN_W, itemH, 1);
            print(8, y + 3, normalizeItems[i], 0);
        } else {
            print(8, y + 3, normalizeItems[i], 1);
        }
    }
}

/* ============ Drawing: Confirm Save ============ */

function drawConfirmSave() {
    clear_screen();

    /* Title */
    var title = (saveReturnView === VIEW_SLICE) ? "Export" : "Save";
    printCentered(2, title);
    drawDivider(12);

    /* Row 0: editable filename (left-justified) */
    var dispName = truncate(saveName, 20);
    var nameY = 16;
    var itemH = saveActions.length > 3 ? 9 : 11;
    if (saveIndex === 0) {
        fill_rect(0, nameY, SCREEN_W, itemH, 1);
        print(2, nameY + 1, dispName, 0);
    } else {
        print(2, nameY + 1, dispName, 1);
    }

    /* Action rows (indented) */
    var startY = nameY + itemH + 2;
    for (var i = 0; i < saveActions.length; i++) {
        var y = startY + i * itemH;
        if (saveIndex === i + 1) {
            fill_rect(0, y, SCREEN_W, itemH, 1);
            print(8, y + 1, saveActions[i], 0);
        } else {
            print(8, y + 1, saveActions[i], 1);
        }
    }
}

/* ============ Navigation & Actions ============ */

/**
 * Switch to a given view.
 */
function switchView(view) {
    currentView = view;
    if (view === VIEW_TRIM) {
        refreshState();
        refreshWaveform();
        updateLeds();
        announce("Edit, " + fileName);
    } else if (view === VIEW_LOOP) {
        /* Auto-enable loop when entering loop mode */
        if (!loopEnabled) {
            loopEnabled = true;
            host_module_set_param("play_loop", "1");
        }
        refreshState();
        invalidateSeamWaveform();
        updateLeds();
        announce("Loop, " + fileName);
    } else if (view === VIEW_SLICE) {
        /* Disable looping for slice audition */
        savedLoopState = loopEnabled;
        if (loopEnabled) {
            loopEnabled = false;
            host_module_set_param("play_loop", "0");
        }
        /* Capture current selection as slice region */
        sliceRegionStart = startSample;
        sliceRegionEnd = endSample;
        if (sliceRegionEnd <= sliceRegionStart) {
            sliceRegionEnd = totalFrames;
            sliceRegionStart = 0;
        }
        sliceCount = 1;
        selectedSlice = 0;
        slicePadOffset = 0;
        sliceMenuIndex = 0;
        sliceMenuEditing = false;
        lazyChopping = false;
        if (sliceMode === SLICE_MODE_LAZY) lazySub = LAZY_SUB_CHOP;
        recomputeSliceBoundaries();
        selectSlice(0);
        /* Zoom to fit the slice region with 10% margin on each side */
        var regionLen = sliceRegionEnd - sliceRegionStart;
        if (regionLen > 0 && regionLen < totalFrames) {
            /* Target visible range = regionLen / 0.80 (10% margin each side) */
            var targetRange = regionLen / 0.80;
            var newZoom = Math.log2(totalFrames / targetRange);
            if (newZoom < 0) newZoom = 0;
            if (newZoom > ZOOM_MAX) newZoom = ZOOM_MAX;
            zoomLevel = newZoom;
            zoomCenter = sliceRegionStart + Math.floor(regionLen / 2);
            if (zoomCenter < 0) zoomCenter = 0;
            if (zoomCenter > totalFrames) zoomCenter = totalFrames;
        }
        syncMarkersToDs();
        refreshState();
        refreshWaveform();
        updateSlicePadLeds();
        var sliceAnnounce = "Slice";
        if (sliceMode === SLICE_MODE_LAZY) sliceAnnounce += " Lazy Chop";
        else if (sliceMode === SLICE_MODE_AUTO) sliceAnnounce += " Auto";
        announce(sliceAnnounce + ", " + fileName);
    } else if (view === VIEW_MODE_MENU) {
        announce("Menu, " + menuItems[menuIndex]);
    } else if (view === VIEW_CONFIRM_EXIT) {
        announce("Unsaved changes, " + confirmItems[confirmIndex]);
    } else if (view === VIEW_CONFIRM_NORMALIZE) {
        announce("Normalize? " + normalizeItems[normalizeIndex]);
    } else if (view === VIEW_CONFIRM_SAVE) {
        var savePrompt = (saveReturnView === VIEW_SLICE) ? "Export, " : "Save, ";
        announce(savePrompt + saveName);
    }
}

/**
 * Handle mode menu selection.
 */
function menuSelect() {
    switch (menuIndex) {
        case 0: /* Edit */
            switchView(VIEW_TRIM);
            break;
        case 1: /* Loop */
            switchView(VIEW_LOOP);
            break;
        case 2: /* Open File */
            enterOpenFileBrowser();
            break;
        case 3: /* Close Session */
            attemptFullExit();
            break;
    }
}

function enterOpenFileBrowser() {
    var currentFile = host_module_get_param("file_path") || "";
    openFileBrowserState = buildFilepathBrowserState(
        { root: "/data/UserData/UserLibrary/Samples", filter: ".wav", name: "Open File" },
        currentFile
    );
    refreshBrowserWithRecording();
    currentView = VIEW_OPEN_FILE;
    var dir = openFileBrowserState.currentDir || "";
    var dirName = dir.substring(dir.lastIndexOf("/") + 1) || "Samples";
    var first = (openFileBrowserState.items && openFileBrowserState.items.length > 0)
        ? openFileBrowserState.items[0].label : "empty";
    announce("Open File, " + dirName + ", " + first);
}

function drawOpenFileBrowser() {
    clear_screen();

    var state = openFileBrowserState;
    if (!state) {
        print(0, 0, "OPEN FILE", 1);
        drawDivider(10);
        print(4, 28, "Browser unavailable", 1);
        return;
    }

    /* Header with directory name */
    var dir = state.currentDir || "";
    var dirName = dir.substring(dir.lastIndexOf("/") + 1) || "Samples";
    print(0, 0, dirName, 1);
    drawDivider(10);

    if (!state.items || state.items.length === 0) {
        print(4, 28, "No files found", 1);
        drawDivider(SCREEN_H - 9);
        print(2, SCREEN_H - 7, "Back: up", 1);
        return;
    }

    /* Draw file list */
    var itemH = 10;
    var startY = 14;
    var maxVisible = Math.floor((SCREEN_H - 9 - startY) / itemH);
    var startIdx = 0;
    if (state.selectedIndex > maxVisible - 2) {
        startIdx = state.selectedIndex - (maxVisible - 2);
    }
    var endIdx = Math.min(startIdx + maxVisible, state.items.length);

    for (var i = startIdx; i < endIdx; i++) {
        var y = startY + (i - startIdx) * itemH;
        var item = state.items[i];
        if (i === state.selectedIndex) {
            fill_rect(0, y, SCREEN_W, itemH, 1);
            print(4, y + 1, item.label, 0);
        } else {
            print(4, y + 1, item.label, 1);
        }
    }

    /* Scroll indicators */
    if (startIdx > 0) print(SCREEN_W - 6, startY, "^", 1);
    if (endIdx < state.items.length) print(SCREEN_W - 6, SCREEN_H - 12, "v", 1);

    drawDivider(SCREEN_H - 9);
    var sel = state.items[state.selectedIndex];
    var hint = sel && sel.kind === "file" ? "Push:load  Back:up" : "Push:open  Back:up";
    print(2, SCREEN_H - 7, hint, 1);
}

/**
 * Handle confirm exit selection.
 */
function confirmSelect() {
    switch (confirmIndex) {
        case 0: /* Save & Exit */
            if (isScratchFile()) {
                /* Scratch file — need Save As, then exit */
                doSaveAs(fullExit);
            } else {
                doSave();
                fullExit();
            }
            break;
        case 1: /* Discard */
            if (isScratchFile()) {
                /* Delete scratch file */
                if (typeof host_system_cmd === "function") {
                    host_system_cmd("rm -f '" + SCRATCH_PATH + "'");
                }
            } else if (isRecordedFile && recordFilePath) {
                /* Delete unsaved recording temp file */
                if (typeof host_system_cmd === "function") {
                    host_system_cmd("rm -f '" + recordFilePath + "'");
                }
            }
            fullExit();
            break;
        case 2: /* Cancel */
            switchView(VIEW_MODE_MENU);
            break;
    }
}

/**
 * Handle confirm normalize selection.
 */
function normalizeSelect() {
    switch (normalizeIndex) {
        case 0: /* Normalize */
            doNormalize();
            switchView(VIEW_TRIM);
            break;
        case 1: /* Cancel */
            switchView(VIEW_TRIM);
            break;
    }
}

/**
 * Ensure the current file is saved to a permanent path (not scratch).
 * If scratch, copies to SAVE_DIR/saveName.wav and updates openedFilePath.
 * Returns the permanent path, or "" on failure.
 */
function ensureSourceSaved() {
    var targetName = ensureWavExt(saveName);
    /* Scratch files go to SAVE_DIR; existing files stay in their folder */
    var destDir = isScratchFile()
        ? SAVE_DIR
        : openedFilePath.substring(0, openedFilePath.lastIndexOf("/"));
    var destPath = destDir + "/" + targetName;
    /* In trim/loop view, apply trim if markers don't span the full file */
    if ((saveReturnView === VIEW_TRIM || saveReturnView === VIEW_LOOP) &&
        (startSample > 0 || endSample < totalFrames)) {
        if (typeof host_module_set_param_blocking === "function") {
            host_module_set_param_blocking("trim", "1", 5000);
        } else {
            host_module_set_param("trim", "1");
            host_module_get_param("dirty"); /* sync barrier */
        }
        refreshFileInfo();
        invalidateWaveform();
    }
    /* Apply pending edits (gain etc) — use blocking call so gain is applied
     * before the save that follows */
    if (gainDb !== 0.0) {
        if (typeof host_module_set_param_blocking === "function") {
            host_module_set_param_blocking("apply_gain", "1", 5000);
        } else {
            host_module_set_param("apply_gain", "1");
            host_module_get_param("dirty"); /* sync barrier */
        }
    }
    if (isScratchFile() || openedFilePath !== destPath) {
        /* Name changed or scratch — use save_as to write directly to dest.
         * The DSP runs as root and chowns to ableton, so this avoids the
         * race condition of save + cp where cp can hit a root-owned file. */
        if (typeof host_ensure_dir === "function") {
            host_ensure_dir(destDir);
        }
        if (typeof host_module_set_param_blocking === "function") {
            host_module_set_param_blocking("save_as", destPath, 10000);
        } else {
            host_module_set_param("save_as", destPath);
            host_module_get_param("dirty"); /* sync barrier */
        }
        /* Verify the file was written */
        if (typeof host_file_exists === "function" && !host_file_exists(destPath)) {
            showStatus("Save failed: write error", 60);
            return "";
        }
        openedFilePath = destPath;
        host_module_set_param("file_path", destPath);
        refreshFileInfo();
        isRecordedFile = false;
        return destPath;
    }
    /* Same name, same path — save in place with sync barrier */
    if (typeof host_module_set_param_blocking === "function") {
        host_module_set_param_blocking("save", "1", 10000);
    } else {
        host_module_set_param("save", "1");
        host_module_get_param("dirty"); /* sync barrier */
    }
    isRecordedFile = false;
    refreshState();
    refreshFileInfo();
    invalidateWaveform();
    return destPath;
}

/**
 * Check if target save path exists and prompt for overwrite if needed.
 * Calls onConfirm() if OK to proceed, does nothing if user cancels.
 */
function checkOverwriteThenDo(action) {
    var targetName = ensureWavExt(saveName);
    /* Match destDir logic from ensureSourceSaved */
    var destDir = isScratchFile()
        ? SAVE_DIR
        : openedFilePath.substring(0, openedFilePath.lastIndexOf("/"));
    var destPath = destDir + "/" + targetName;
    /* If saving to same file we already have open, no overwrite prompt needed */
    if (destPath === openedFilePath) {
        action();
        return;
    }
    if (typeof host_file_exists === "function" && host_file_exists(destPath)) {
        /* Show overwrite confirmation via text entry trick:
         * We reuse the confirm mechanism — ask user */
        /* Simple approach: just warn and proceed, since we have limited UI */
        showStatus("Overwriting...", 30);
        action();
    } else {
        action();
    }
}

/**
 * Handle confirm save selection.
 */
function saveSelect() {
    if (saveIndex === 0) {
        /* Filename row — open keyboard to edit */
        if (typeof host_open_text_entry !== "function") {
            showStatus("No keyboard", 60);
            return;
        }
        host_open_text_entry({
            title: "Filename",
            initialText: saveName,
            onConfirm: function(name) {
                if (name && name.length > 0) {
                    saveName = name;
                }
            },
            onCancel: function() {}
        });
        return;
    }

    var action = saveActions[saveIndex - 1];
    if (action === "Save") {
        checkOverwriteThenDo(function() {
            var path = ensureSourceSaved();
            if (path) {
                var folder = leafFolder(path);
                showStatus("Saved to " + folder, 90);
                announce("Saved to " + folder);
            } else {
                showStatus("Save failed", 60);
            }
            returnToSaveView();
        });
    } else if (action === "Slices") {
        exportSlicedWavs(saveName);
        returnToSaveView();
    } else if (action === "Drum Preset") {
        checkOverwriteThenDo(function() {
            var wasScratch = isScratchFile();
            var nameChanged = !nameMatchesCurrent();
            var path = ensureSourceSaved();
            if (!path) { showStatus("Save failed", 60); returnToSaveView(); return; }
            saveDrumRackPreset(wasScratch || nameChanged);
            returnToSaveView();
        });
    } else if (action === "REX Loop") {
        exportRexLoop(saveName);
        returnToSaveView();
    } else {
        /* Cancel */
        returnToSaveView();
    }
}

/**
 * Return to the view we came from before the save dialog.
 * For slice mode, avoid switchView() which would reset slice state —
 * just restore the view and refresh display.
 */
function returnToSaveView() {
    if (saveReturnView === VIEW_SLICE) {
        currentView = VIEW_SLICE;
        selectSlice(selectedSlice);
        syncMarkersToDs();
        refreshWaveform();
        updateSlicePadLeds();
    } else {
        switchView(saveReturnView);
    }
}

/**
 * Save file (auto-apply gain if non-zero).
 */
function doSave() {
    if (gainDb !== 0.0) {
        if (typeof host_module_set_param_blocking === "function") {
            host_module_set_param_blocking("apply_gain", "1", 5000);
        } else {
            host_module_set_param("apply_gain", "1");
            host_module_get_param("dirty"); /* sync barrier */
        }
    }
    if (typeof host_module_set_param_blocking === "function") {
        host_module_set_param_blocking("save", "1", 10000);
    } else {
        host_module_set_param("save", "1");
        host_module_get_param("dirty"); /* sync barrier */
    }
    isRecordedFile = false;
    var folder = leafFolder(openedFilePath);
    showStatus("Saved to " + folder, 90);
    refreshState();
    refreshFileInfo();
    invalidateWaveform();
}

/**
 * Attempt to exit. If dirty, show confirm dialog; otherwise exit.
 */
function attemptExit() {
    refreshState();
    if (dirty || gainDb !== 0.0) {
        confirmIndex = 0;
        switchView(VIEW_CONFIRM_EXIT);
    } else {
        exitEditor();
    }
}

/**
 * Attempt full exit (unload DSP). If dirty, show confirm dialog; otherwise full exit.
 */
function attemptFullExit() {
    refreshState();
    if (dirty || gainDb !== 0.0) {
        confirmIndex = 0;
        switchView(VIEW_CONFIRM_EXIT);
    } else {
        fullExit();
    }
}

/**
 * Exit the editor. Signals intent to DSP. Actual exit happens via
 * the overtake exit mechanism (Shift+Vol+Jog Click) or host navigation.
 */
function exitEditor() {
    if (typeof host_hide_module === "function") {
        host_hide_module();
    } else if (typeof host_exit_module === "function") {
        host_exit_module();
    }
}

/**
 * Full exit — unloads DSP. Used from confirm dialog "Discard" or
 * "Close Session" menu when user explicitly wants to close.
 */
function fullExit() {
    if (typeof host_exit_module === "function") {
        host_exit_module();
    }
}

/**
 * Queue playback start. Actual set_param issued in tick() to avoid
 * fire-and-forget race with encoder param updates.
 */
function startPlayback() {
    pendingPlay = "selection";
    playing = true;
}

/**
 * Queue playback from an arbitrary frame position (plays to end_sample).
 */
function startPlaybackFrom(frame) {
    pendingPlay = "from:" + frame;
    playing = true;
}

/**
 * Queue playback stop.
 */
function stopPlayback() {
    pendingPlay = "stop";
    playing = false;
}

/**
 * Toggle loop mode.
 */
function toggleLoop() {
    loopEnabled = !loopEnabled;
    host_module_set_param("play_loop", loopEnabled ? "1" : "0");
    showStatus(loopEnabled ? "Loop ON" : "Loop OFF", 45);
    updateLeds();
}

function snapToZeroCrossing() {
    host_module_set_param("find_zero_crossing", "1");
    var newStart = host_module_get_param("start_sample");
    if (newStart) startSample = parseInt(newStart, 10) || 0;
    syncMarkersToDs();
    if (currentView === VIEW_LOOP) invalidateSeamWaveform();
    showStatus("Zero-X found", 60);
}

/**
 * Execute trim operation (discard audio outside markers).
 */
function doTrim() {
    host_module_set_param("trim", "1");
    showStatus("Trimmed", 60);
    refreshFileInfo();
    refreshState();
    invalidateWaveform();
    updateLeds();
}

/**
 * Copy selection to clipboard.
 */
function doCopy() {
    host_module_set_param("copy", "1");
    hasClipboard = true;
    showStatus("Copied", 60);
    updateLeds();
}

/**
 * Mute (zero out) selection.
 */
function doMute() {
    host_module_set_param("mute", "1");
    showStatus("Muted", 60);
    refreshFileInfo();
    refreshState();
    invalidateWaveform();
    updateLeds();
}

/**
 * Cut selection to clipboard (copy + remove).
 */
function doCut() {
    host_module_set_param("cut", "1");
    hasClipboard = true;
    showStatus("Cut", 60);
    refreshFileInfo();
    refreshState();
    invalidateWaveform();
    updateLeds();
}

/**
 * Paste clipboard at cursor (insert at start_sample).
 */
function doPaste() {
    refreshState();
    if (!hasClipboard) {
        showStatus("Nothing to paste", 45);
        return;
    }
    host_module_set_param("paste", "1");
    showStatus("Pasted", 60);
    refreshFileInfo();
    refreshState();
    invalidateWaveform();
    updateLeds();
}

/**
 * Save As — prompt for filename, copy file to permanent location.
 * Opens the text entry keyboard with a pre-filled timestamp name.
 */
function doSaveAs(onDone) {
    if (typeof host_open_text_entry !== "function") {
        showStatus("No keyboard", 60);
        return;
    }
    var defaultName = isScratchFile()
        ? generateDefaultSaveName()
        : fileName.replace(/\.wav$/i, "");
    host_open_text_entry({
        title: "Save As",
        initialText: defaultName,
        onConfirm: function(name) {
            if (!name || name.length === 0) {
                showStatus("Cancelled", 60);
                return;
            }
            var destName = ensureWavExt(name);
            var destDir = isScratchFile()
                ? SAVE_DIR
                : openedFilePath.substring(0, openedFilePath.lastIndexOf("/"));
            var destPath = destDir + "/" + destName;
            /* Apply pending edits before saving */
            if (gainDb !== 0.0) {
                if (typeof host_module_set_param_blocking === "function") {
                    host_module_set_param_blocking("apply_gain", "1", 5000);
                } else {
                    host_module_set_param("apply_gain", "1");
                    host_module_get_param("dirty"); /* sync barrier */
                }
            }
            /* Use save_as to write directly to dest (DSP runs as root + chowns).
             * Avoids race condition of save + cp. */
            if (typeof host_ensure_dir === "function") {
                host_ensure_dir(destDir);
            }
            if (typeof host_module_set_param_blocking === "function") {
                host_module_set_param_blocking("save_as", destPath, 10000);
            } else {
                host_module_set_param("save_as", destPath);
                host_module_get_param("dirty"); /* sync barrier */
            }
            if (typeof host_file_exists === "function" && !host_file_exists(destPath)) {
                showStatus("Save failed", 60);
            } else {
                openedFilePath = destPath;
                host_module_set_param("file_path", destPath);
                refreshFileInfo();
                isRecordedFile = false;
                var destFolder = leafFolder(destPath);
                showStatus("Saved to " + destFolder, 90);
                announce("Saved to " + destFolder);
                if (onDone) onDone();
            }
        },
        onCancel: function() {
            /* User cancelled — stay on current file */
        }
    });
}

function doExport() {
    host_module_set_param("export", "1");
    var result = host_module_get_param("copy_result");
    if (result && result !== "" && result !== "ERROR") {
        showStatus("Exported!", 60);
    } else {
        showStatus("Export failed", 60);
    }
}

/**
 * Export each slice as an individual WAV file into a subdirectory.
 * Output: <sampleDir>/<basename>-sliced/<basename>_s1.wav, _s2.wav, etc.
 * Uses the DSP export mechanism: set markers → sync → export → copy result → rename.
 */
function exportSlicedWavs(overrideName) {
    if (!openedFilePath || !fileName || totalFrames <= 0) {
        showStatus("No file", 60);
        return;
    }
    if (typeof host_system_cmd !== "function") {
        showStatus("No cmd API", 60);
        return;
    }

    var numSlices = sliceCount;
    if (numSlices < 1) {
        showStatus("No slices", 60);
        return;
    }

    announce("Exporting " + sliceCount + " slices");

    /* Derive paths — use overrideName for output naming if provided */
    var baseName = overrideName
        ? overrideName.replace(/\.wav$/i, "")
        : fileName.replace(/\.wav$/i, "");
    var sampleDir = isScratchFile()
        ? SAVE_DIR
        : openedFilePath.substring(0, openedFilePath.lastIndexOf("/"));
    var sliceDir = sampleDir + "/" + baseName + "-sliced";

    /* Create output directory */
    if (typeof host_ensure_dir === "function") {
        host_ensure_dir(sliceDir);
    }

    /* Save current markers so we can restore them */
    var savedStart = startSample;
    var savedEnd = endSample;

    var exported = 0;
    for (var i = 0; i < numSlices; i++) {
        /* Set markers to this slice's boundaries */
        startSample = sliceBoundaries[i];
        endSample = sliceBoundaries[i + 1];
        syncMarkersToDs();
        host_module_get_param("dirty"); /* sync barrier */

        /* Trigger export — DSP writes timestamped file, returns name in copy_result.
         * Use blocking call to ensure export completes before reading result. */
        if (typeof host_module_set_param_blocking === "function") {
            host_module_set_param_blocking("export", "1", 10000);
        } else {
            host_module_set_param("export", "1");
            host_module_get_param("dirty"); /* sync barrier */
        }
        var result = host_module_get_param("copy_result");

        if (!result || result === "ERROR") continue;

        /* copy_result is the basename of the exported file (e.g. "sample_edit_0309_0853.wav") */
        var editPath = sampleDir + "/" + result;
        var sliceName = baseName + "_s" + (i + 1) + ".wav";
        var targetPath = sliceDir + "/" + sliceName;

        /* Move exported file to final destination */
        var cpResult = host_system_cmd('mv "' + editPath + '" "' + targetPath + '"');
        if (cpResult === 0) {
            exported++;
        }
    }

    /* Restore original markers */
    startSample = savedStart;
    endSample = savedEnd;
    syncMarkersToDs();

    if (exported > 0) {
        var sliceDirLeaf = sliceDir.substring(sliceDir.lastIndexOf("/") + 1);
        var sliceParentPath = sliceDir.substring(0, sliceDir.lastIndexOf("/"));
        var sliceParent = sliceParentPath.substring(sliceParentPath.lastIndexOf("/") + 1);
        var sliceLocation = sliceParent + "/" + sliceDirLeaf;
        showStatus(exported + " slices to " + sliceLocation, 90);
        announce("Saved " + exported + " slices to " + sliceLocation);
    } else {
        showStatus("Export failed", 60);
    }
}

/**
 * Export slices as a REX2 loop file via the rex-encode CLI tool.
 * No slice count limit — REX supports arbitrary slices.
 * Output: <REX_LOOPS_DIR>/<baseName>.rx2
 */
function exportRexLoop(overrideName) {
    if (!openedFilePath || !fileName || totalFrames <= 0) {
        showStatus("No file", 60);
        return;
    }
    if (typeof host_system_cmd !== "function") {
        showStatus("No cmd API", 60);
        return;
    }
    if (sliceCount < 1) {
        showStatus("No slices", 60);
        return;
    }

    announce("Exporting REX loop");

    /* First, export the full slice region as a WAV file for rex-encode input */
    var savedStart = startSample;
    var savedEnd = endSample;

    startSample = sliceRegionStart;
    endSample = sliceRegionEnd;
    syncMarkersToDs();
    host_module_get_param("dirty"); /* sync barrier */
    /* Use blocking call to ensure export completes before reading result */
    if (typeof host_module_set_param_blocking === "function") {
        host_module_set_param_blocking("export", "1", 10000);
    } else {
        host_module_set_param("export", "1");
        host_module_get_param("dirty"); /* sync barrier */
    }
    var exportResult = host_module_get_param("copy_result");

    /* Restore markers */
    startSample = savedStart;
    endSample = savedEnd;
    syncMarkersToDs();

    if (!exportResult || exportResult === "ERROR") {
        showStatus("Export failed", 60);
        return;
    }

    var baseName = overrideName
        ? overrideName.replace(/\.wav$/i, "")
        : fileName.replace(/\.wav$/i, "");
    var sampleDir = isScratchFile()
        ? SAVE_DIR
        : openedFilePath.substring(0, openedFilePath.lastIndexOf("/"));
    var editPath = sampleDir + "/" + exportResult;
    var rx2Path = REX_LOOPS_DIR + "/" + baseName + ".rx2";

    /* Ensure loops directory exists */
    if (typeof host_ensure_dir === "function") {
        host_ensure_dir(REX_LOOPS_DIR);
    }

    /* Build boundaries string: sample positions relative to the exported region.
     * The exported WAV starts at 0, so offset all boundaries by -sliceRegionStart. */
    var parts = [];
    for (var i = 0; i <= sliceCount; i++) {
        parts.push("" + (sliceBoundaries[i] - sliceRegionStart));
    }
    var boundaries = parts.join(",");

    /* Call rex-encode */
    var cmd = 'sh -c "' + REX_ENCODE_BIN + ' \\"' + editPath + '\\" \\"' + rx2Path + '\\" \\"' + boundaries + '\\""';
    var result = host_system_cmd(cmd);

    /* Clean up temp WAV */
    host_system_cmd('rm -f "' + editPath + '"');

    if (result === 0) {
        var rexFolder = leafFolder(rx2Path);
        showStatus("Saved REX to " + rexFolder, 90);
        announce("Saved REX loop to " + rexFolder);
    } else {
        showStatus("REX failed", 60);
    }
}

/**
 * Build a default drumCell parameter block for a slice.
 */
function buildDrumCellParams(playbackStart, playbackLength) {
    return {
        "Effect_EightBitFilterDecay": 5.0,
        "Effect_EightBitResamplingRate": 14080.0,
        "Effect_FmAmount": 0.0,
        "Effect_FmFrequency": 1000.0,
        "Effect_LoopLength": 0.30000001192092896,
        "Effect_LoopOffset": 0.019999999552965164,
        "Effect_NoiseAmount": 0.0,
        "Effect_NoiseFrequency": 10000.0,
        "Effect_On": true,
        "Effect_PitchEnvelopeAmount": 0.0,
        "Effect_PitchEnvelopeDecay": 0.30000001192092896,
        "Effect_PunchAmount": 0.0,
        "Effect_PunchTime": 0.12015999853610992,
        "Effect_RingModAmount": 0.0,
        "Effect_RingModFrequency": 1000.0,
        "Effect_StretchFactor": 1.0,
        "Effect_StretchGrainSize": 0.10000000149011612,
        "Effect_SubOscAmount": 0.0,
        "Effect_SubOscFrequency": 60.0,
        "Effect_Type": "Stretch",
        "Enabled": true,
        "NotePitchBend": true,
        "Pan": 0.0,
        "Voice_Detune": 0.0,
        "Voice_Envelope_Attack": 0.00009999999747378752,
        "Voice_Envelope_Decay": 0.0010000000474974513,
        "Voice_Envelope_Hold": 60.0,
        "Voice_Envelope_Mode": "A-H-D",
        "Voice_Filter_Frequency": 22000.0,
        "Voice_Filter_On": true,
        "Voice_Filter_PeakGain": 1.0,
        "Voice_Filter_Resonance": 0.0,
        "Voice_Filter_Type": "Lowpass",
        "Voice_Gain": 1.0,
        "Voice_ModulationAmount": 0.0,
        "Voice_ModulationSource": "Velocity",
        "Voice_ModulationTarget": "Filter",
        "Voice_PitchToEnvelopeModulation": true,
        "Voice_PlaybackLength": playbackLength,
        "Voice_PlaybackStart": playbackStart,
        "Voice_Transpose": 0,
        "Voice_VelocityToVolume": 0.5,
        "Volume": -12.0
    };
}

/**
 * Save current slices as an Ableton Move drum rack preset (.ablpreset).
 * Up to 16 slices, each mapped to a pad (MIDI notes 36-51).
 */
function saveDrumRackPreset(savedSource) {
    if (!fileName || totalFrames <= 0) {
        showStatus("No file", 60);
        return;
    }

    /* Build sample URI from file path (URL-encode spaces) */
    var sampleUri;
    var userLibPrefix = "/data/UserData/UserLibrary/";
    var uriPath;
    if (openedFilePath && openedFilePath.indexOf(userLibPrefix) === 0) {
        uriPath = openedFilePath.substring(userLibPrefix.length);
    } else {
        uriPath = "Samples/" + fileName;
    }
    sampleUri = "ableton:/user-library/" + uriPath.split(" ").join("%20");

    var numSlices = Math.min(sliceCount, 16);

    /* Build drum rack chains — always 16 pads for Move compatibility.
     * Pads beyond the slice count get the last slice's sample region
     * with speaker off (muted) so the preset loads correctly. */
    var drumChains = [];
    for (var i = 0; i < 16; i++) {
        var hasSlice = (i < numSlices);
        var si = hasSlice ? i : numSlices - 1; /* fallback to last slice */
        var sliceStart = sliceBoundaries[si] / totalFrames;
        var sliceLen = (sliceBoundaries[si + 1] - sliceBoundaries[si]) / totalFrames;

        drumChains.push({
            "name": "",
            "color": 0,
            "devices": [{
                "presetUri": null,
                "kind": "drumCell",
                "name": "",
                "parameters": buildDrumCellParams(sliceStart, sliceLen),
                "deviceData": {
                    "sampleUri": sampleUri
                }
            }],
            "mixer": {
                "pan": 0.0,
                "solo-cue": false,
                "speakerOn": hasSlice,
                "volume": 0.0,
                "sends": [{ "isEnabled": true, "amount": -70.0 }]
            },
            "drumZoneSettings": {
                "receivingNote": 36 + i,
                "sendingNote": 60,
                "chokeGroup": 1
            }
        });
    }

    /* Build the preset name from the filename */
    var baseName = fileName.replace(/\.wav$/i, "");
    var presetName = baseName + " Kit";

    var preset = {
        "$schema": "http://tech.ableton.com/schema/song/1.8.2/devicePreset.json",
        "kind": "instrumentRack",
        "name": presetName,
        "parameters": {
            "Enabled": true,
            "Macro0": 0.0, "Macro1": 0.0, "Macro2": 0.0, "Macro3": 0.0,
            "Macro4": 0.0, "Macro5": 0.0, "Macro6": 0.0, "Macro7": 0.0
        },
        "chains": [{
            "name": "",
            "color": 0,
            "devices": [{
                "presetUri": null,
                "kind": "drumRack",
                "name": presetName,
                "parameters": {
                    "Enabled": true,
                    "Macro0": 0.0, "Macro1": 0.0, "Macro2": 0.0, "Macro3": 0.0,
                    "Macro4": 0.0, "Macro5": 0.0, "Macro6": 0.0, "Macro7": 0.0
                },
                "chains": drumChains,
                "returnChains": [{
                    "name": "",
                    "color": 0,
                    "devices": [{
                        "presetUri": null,
                        "kind": "reverb",
                        "name": "",
                        "parameters": {
                            "AllPassGain": 0.9219444394111633,
                            "AllPassSize": 0.7699999809265137,
                            "BandFreq": 402.4820251464844,
                            "BandHighOn": true,
                            "BandLowOn": true,
                            "BandWidth": 4.572916507720947,
                            "ChorusOn": false,
                            "CutOn": false,
                            "DecayTime": 3542.771728515625,
                            "DiffuseDelay": 0.2142857164144516,
                            "EarlyReflectModDepth": 3.2428934574127197,
                            "EarlyReflectModFreq": 0.1093868613243103,
                            "Enabled": true,
                            "FlatOn": false,
                            "FreezeOn": false,
                            "HighFilterType": "Shelf",
                            "MixDiffuse": 1.995300054550171,
                            "MixDirect": 1.0,
                            "MixReflect": 1.792531132698059,
                            "PreDelay": 7.023662090301514,
                            "RoomSize": 67.26939392089844,
                            "RoomType": "SuperEco",
                            "ShelfHiFreq": 1469.94873046875,
                            "ShelfHiGain": 0.8833333849906921,
                            "ShelfHighOn": true,
                            "ShelfLoFreq": 670.7686157226563,
                            "ShelfLoGain": 0.6166667342185974,
                            "ShelfLowOn": true,
                            "SizeModDepth": 0.15581557154655457,
                            "SizeModFreq": 2.3727688789367676,
                            "SizeSmoothing": "Fast",
                            "SpinOn": true,
                            "StereoSeparation": 107.62000274658203
                        },
                        "deviceData": {}
                    }],
                    "mixer": {
                        "pan": 0.0,
                        "solo-cue": false,
                        "speakerOn": true,
                        "volume": 0.0,
                        "sends": [{ "isEnabled": false, "amount": -70.0 }]
                    }
                }]
            }],
            "mixer": {
                "pan": 0.0,
                "solo-cue": false,
                "speakerOn": true,
                "volume": 0.0,
                "sends": []
            }
        }]
    };

    var presetJson = JSON.stringify(preset, null, 2);
    var presetDir = "/data/UserData/UserLibrary/Track Presets";
    var presetPath = presetDir + "/" + presetName + ".ablpreset";

    if (typeof host_write_file !== "function") {
        showStatus("No write API", 60);
        return;
    }
    if (typeof host_ensure_dir === "function") {
        host_ensure_dir(presetDir);
    }
    host_write_file(presetPath, presetJson);
    if (savedSource) {
        var sampleFolder = leafFolder(openedFilePath);
        showStatus("Drum Rack + Sample to " + sampleFolder, 90);
        announce("Saved Drum Rack Preset and sample to " + sampleFolder);
    } else {
        showStatus("Saved Drum Rack Preset", 90);
        announce("Saved Drum Rack Preset");
    }
}

/**
 * Undo last destructive operation.
 */
function doUndo() {
    refreshState();
    if (!hasUndo) {
        showStatus("Nothing to undo", 45);
        return;
    }
    host_module_set_param("undo", "1");
    showStatus("Undone", 60);
    refreshFileInfo();
    refreshState();
    invalidateWaveform();
    updateLeds();
}

/**
 * Apply gain permanently.
 */
function doApplyGain() {
    host_module_set_param("apply_gain", "1");
    showStatus("Gain applied", 60);
    refreshFileInfo();
    refreshState();
    invalidateWaveform();
    updateLeds();
}

/**
 * Normalize audio to -0.3dBFS.
 */
function doNormalize() {
    host_module_set_param("normalize", "1");
    showStatus("Normalized", 60);
    refreshFileInfo();
    refreshState();
    invalidateWaveform();
    updateLeds();
}

/* ============ MIDI Input Handling ============ */

/**
 * Handle CC messages.
 */
function handleCC(cc, value) {
    /* Shift tracking */
    if (cc === CC_SHIFT) {
        shiftHeld = (value === 127);
        return;
    }

    /* During record states, only allow Back, Rec, and Shift buttons */
    if (recordState !== "idle" && recordState !== "stopping" && cc !== CC_BACK && cc !== CC_REC && cc !== CC_SHIFT) {
        return;
    }

    /* Only handle presses (value > 0) for remaining CCs, except jog/encoders */
    var isEncoder = (cc === CC_JOG || cc === CC_E1 || cc === CC_E2 || cc === CC_E3 || cc === CC_E4 || cc === CC_E5 || cc === CC_E7 || cc === CC_E8);

    /* Back button */
    if (cc === CC_BACK && value > 0) {
        /* Shift+Back: full exit (unload DSP) for quick iteration */
        if (shiftHeld) {
            fullExit();
            return;
        }
        /* During recording/paused/record-ready, just hide — DSP keeps recording */
        if (recordState === "recording" || recordState === "ready" || recordState === "paused") {
            exitEditor();
            return;
        }
        switch (currentView) {
            case VIEW_TRIM:
            case VIEW_LOOP:
                exitEditor();
                break;
            case VIEW_SLICE:
                if (sliceMode === SLICE_MODE_LAZY && lazyChopping) {
                    /* End chop session early */
                    stopPlayback();
                    /* Trim last boundary to current playPos if mid-playback */
                    if (playPos > sliceBoundaries[sliceCount - 1] && playPos < sliceRegionEnd) {
                        sliceBoundaries[sliceCount] = playPos;
                    }
                    lazyChopping = false;
                    lazySub = LAZY_SUB_PLAY;
                    selectedSlice = 0;
                    selectSlice(0);
                    updateSlicePadLeds();
                    showStatus("Chop done, " + sliceCount + " slices", 30);
                } else {
                    /* Hide — persist slice state to DSP for reconnect */
                    saveSliceState();
                    exitEditor();
                }
                break;
            case VIEW_MODE_MENU:
                exitEditor();
                break;
            case VIEW_CONFIRM_EXIT:
                switchView(VIEW_TRIM);
                break;
            case VIEW_CONFIRM_NORMALIZE:
                switchView(VIEW_TRIM);
                break;
            case VIEW_CONFIRM_SAVE:
                switchView(saveReturnView);
                break;
            case VIEW_OPEN_FILE:
                if (openFileBrowserState && openFileBrowserState.currentDir !== openFileBrowserState.root) {
                    /* Navigate up one directory */
                    var dir = openFileBrowserState.currentDir;
                    var lastSlash = dir.lastIndexOf("/");
                    if (lastSlash > 0) {
                        openFileBrowserState.currentDir = dir.substring(0, lastSlash);
                        if (openFileBrowserState.currentDir.length < openFileBrowserState.root.length) {
                            openFileBrowserState.currentDir = openFileBrowserState.root;
                        }
                    } else {
                        openFileBrowserState.currentDir = openFileBrowserState.root;
                    }
                    openFileBrowserState.selectedIndex = 0;
                    openFileBrowserState.selectedPath = "";
                    refreshBrowserWithRecording();
                    var bDir = openFileBrowserState.currentDir || "";
                    var bDirName = bDir.substring(bDir.lastIndexOf("/") + 1) || "Samples";
                    var bFirst = (openFileBrowserState.items && openFileBrowserState.items.length > 0)
                        ? openFileBrowserState.items[0].label : "empty";
                    announce(bDirName + ", " + bFirst);
                } else {
                    openFileBrowserState = null;
                    currentView = VIEW_MODE_MENU;
                    announce("Menu, " + menuItems[menuIndex]);
                }
                break;
        }
        return;
    }

    /* Mute button — zero out selection */
    if (cc === CC_MUTE && value > 0) {
        if (currentView === VIEW_TRIM || currentView === VIEW_LOOP) {
            doMute();
            if (currentView === VIEW_LOOP) invalidateSeamWaveform();
        }
        return;
    }

    /* Delete button — cut selection to clipboard */
    if (cc === CC_DELETE && value > 0) {
        if (currentView === VIEW_TRIM || currentView === VIEW_LOOP) {
            doCut();
            if (currentView === VIEW_LOOP) invalidateSeamWaveform();
        }
        return;
    }

    /* Copy button: normal = copy to clipboard, shift = paste */
    if (cc === CC_COPY && value > 0) {
        if (currentView === VIEW_TRIM || currentView === VIEW_LOOP) {
            if (shiftHeld) {
                doPaste();
                if (currentView === VIEW_LOOP) invalidateSeamWaveform();
            } else {
                doCopy();
            }
        }
        return;
    }

    /* Undo button */
    if (cc === CC_UNDO && value > 0) {
        if (currentView === VIEW_TRIM || currentView === VIEW_LOOP) {
            doUndo();
            if (currentView === VIEW_LOOP) invalidateSeamWaveform();
        }
        return;
    }

    /* Loop button */
    if (cc === CC_LOOP && value > 0) {
        if (currentView === VIEW_LOOP) {
            if (shiftHeld) {
                /* Shift+Loop: find zero crossing */
                host_module_set_param("find_zero_crossing", "1");
                var newStart = host_module_get_param("start_sample");
                if (newStart) startSample = parseInt(newStart, 10) || 0;
                syncMarkersToDs();
                invalidateSeamWaveform();
                showStatus("Zero-X found", 60);
            } else {
                /* Loop button in loop view: return to trim */
                switchView(VIEW_TRIM);
            }
        } else if (currentView === VIEW_TRIM) {
            if (shiftHeld) {
                /* Shift+Loop in trim view: toggle loop on/off */
                toggleLoop();
            } else {
                /* Loop button in trim view: enter loop view */
                switchView(VIEW_LOOP);
            }
        }
        return;
    }

    /* REC button — start/stop/resume recording; Shift+REC = pause/start */
    if (cc === CC_REC && value > 0) {
        if (recordState === "ready") {
            /* Start recording (both plain Rec and Shift+Rec) */
            if (typeof host_ensure_dir === "function") {
                host_ensure_dir(recordBrowserDir);
            }
            host_sampler_start(recordFilePath);
            if (typeof host_sampler_set_external_stop === "function") {
                host_sampler_set_external_stop(1);
            }
            recordStartTime = Date.now();
            recordPausedTotal = 0;
            recordPauseStart = 0;
            recordState = "recording";
            recordWaveform = [];
            recordWriteHead = 0;
            setButtonLED(CC_REC, BrightRed);
            announce("Recording");
        } else if (recordState === "recording" && shiftHeld) {
            /* Shift+Rec while recording = pause */
            host_sampler_pause();
            recordPauseStart = Date.now();
            recordState = "paused";
            recordLedCounter = 0;
            setButtonLED(CC_REC, LED_OFF);
            announce("Recording paused");
        } else if (recordState === "recording") {
            /* Rec while recording = stop */
            if (typeof host_sampler_set_external_stop === "function") {
                host_sampler_set_external_stop(0);
            }
            host_sampler_stop();
            recordState = "stopping";
            recordStoppingTicks = 0;
            recordWaveform = null;
            setButtonLED(CC_REC, LED_OFF);
            showStatus("Saving...", 90);
        } else if (recordState === "paused") {
            /* Rec (or Shift+Rec) while paused = resume */
            host_sampler_resume();
            recordPausedTotal += (Date.now() - recordPauseStart);
            recordPauseStart = 0;
            recordState = "recording";
            setButtonLED(CC_REC, BrightRed);
            announce("Recording resumed");
        }
        return;
    }

    /* Capture button — toggle between Trim and Slice mode.
     * Shift+Capture: export selection to new file. */
    if (cc === CC_CAPTURE && value > 0) {
        if (shiftHeld) {
            if (currentView === VIEW_TRIM || currentView === VIEW_LOOP || currentView === VIEW_SLICE) {
                doExport();
            }
        } else {
            if (currentView === VIEW_TRIM || currentView === VIEW_LOOP) {
                switchView(VIEW_SLICE);
            } else if (currentView === VIEW_SLICE) {
                if (lazyChopping) {
                    stopPlayback();
                    lazyChopping = false;
                    announce("Chop stopped");
                }
                /* Restore loop state and selection spanning all slices */
                if (savedLoopState) {
                    loopEnabled = true;
                    host_module_set_param("play_loop", "1");
                }
                startSample = sliceBoundaries[0];
                endSample = sliceBoundaries[sliceCount];
                syncMarkersToDs();
                /* Clear persisted slice state — user explicitly left slice mode */
                host_module_set_param("slice_state", "");
                switchView(VIEW_TRIM);
            }
        }
        return;
    }

    /* Sample button — save menu.
     * Shows editable filename at top + action items below.
     * Trim/Loop: Save + Cancel.  Slice: Slices + Drum Preset + REX + Cancel. */
    if (cc === CC_SAMPLE && value > 0) {
        if (currentView === VIEW_TRIM || currentView === VIEW_LOOP) {
            saveName = isScratchFile()
                ? generateDefaultSaveName()
                : fileName.replace(/\.wav$/i, "");
            saveActions = ["Save", "Cancel"];
            saveIndex = 0;
            saveReturnView = currentView;
            switchView(VIEW_CONFIRM_SAVE);
        } else if (currentView === VIEW_SLICE) {
            saveName = isScratchFile()
                ? generateDefaultSaveName()
                : fileName.replace(/\.wav$/i, "");
            saveActions = getSliceActions();
            saveIndex = 0;
            saveReturnView = VIEW_SLICE;
            switchView(VIEW_CONFIRM_SAVE);
        }
        return;
    }

    /* Left/Right arrows — nudge selection or jump by selection length */
    if ((cc === CC_LEFT || cc === CC_RIGHT) && value > 0) {
        if (currentView === VIEW_TRIM) {
            var selLen = endSample - startSample;
            var dir = (cc === CC_LEFT) ? -1 : 1;

            if (shiftHeld) {
                /* Shift: jump by exactly one selection length */
                if (dir > 0) {
                    /* Right: next region starts where current ends */
                    startSample = endSample;
                    endSample = startSample + selLen;
                    if (endSample > totalFrames) {
                        endSample = totalFrames;
                        startSample = endSample - selLen;
                        if (startSample < 0) startSample = 0;
                    }
                } else {
                    /* Left: previous region ends where current starts */
                    endSample = startSample;
                    startSample = endSample - selLen;
                    if (startSample < 0) {
                        startSample = 0;
                        endSample = startSample + selLen;
                        if (endSample > totalFrames) endSample = totalFrames;
                    }
                }
            } else {
                /* Normal: nudge both markers by one coarse step */
                var step = getCoarseStep() * dir;
                var newStart = startSample + step;
                var newEnd = endSample + step;
                if (newStart < 0) {
                    newStart = 0;
                    newEnd = newStart + selLen;
                }
                if (newEnd > totalFrames) {
                    newEnd = totalFrames;
                    newStart = newEnd - selLen;
                }
                if (newStart < 0) newStart = 0;
                startSample = newStart;
                endSample = newEnd;
            }
            syncMarkersToDs();
            refreshWaveform();
            announce("Start:" + formatTime(startSample));
        } else if (currentView === VIEW_SLICE) {
            /* Left/Right: select prev/next slice (wraps) */
            var sliceDir = (cc === CC_LEFT) ? -1 : 1;
            var newIdx = selectedSlice + sliceDir;
            if (newIdx < 0) newIdx = sliceCount - 1;
            if (newIdx >= sliceCount) newIdx = 0;
            selectSlice(newIdx);
            /* Auto-scroll pad bank if selected slice is outside visible range */
            if (selectedSlice < slicePadOffset) {
                slicePadOffset = Math.floor(selectedSlice / 32) * 32;
            } else if (selectedSlice >= slicePadOffset + 32) {
                slicePadOffset = Math.floor(selectedSlice / 32) * 32;
            }
            syncMarkersToDs();
            updateSlicePadLeds();
            announce("Slice " + (selectedSlice + 1) + "/" + sliceCount);
        }
        return;
    }

    /* Up/Down arrows in slice mode */
    if ((cc === CC_UP || cc === CC_DOWN) && value > 0) {
        if (currentView === VIEW_SLICE) {
            if (shiftHeld && sliceCount > 32) {
                /* Shift+Up/Down: pad bank scrolling (>32 slices) */
                if (cc === CC_DOWN) {
                    slicePadOffset = Math.max(0, slicePadOffset - 32);
                } else {
                    slicePadOffset = Math.min(Math.floor((sliceCount - 1) / 32) * 32, slicePadOffset + 32);
                }
                updateSlicePadLeds();
                var bankNum = Math.floor(slicePadOffset / 32) + 1;
                var totalBanks = Math.floor((sliceCount - 1) / 32) + 1;
                announce("Pad bank " + bankNum + " of " + totalBanks);
            } else if (cc === CC_DOWN) {
                /* Down: split current slice at midpoint */
                var splitStart = sliceBoundaries[selectedSlice];
                var splitEnd = sliceBoundaries[selectedSlice + 1];
                var mid = splitStart + Math.floor((splitEnd - splitStart) / 2);
                if (mid > splitStart && mid < splitEnd) {
                    sliceBoundaries.splice(selectedSlice + 1, 0, mid);
                    sliceCount = sliceBoundaries.length - 1;
                    selectSlice(selectedSlice);
                    syncMarkersToDs();
                    updateSlicePadLeds();
                    showStatus("Split " + (selectedSlice + 1), 30);
                    announce("Split slice " + (selectedSlice + 1) + ", " + sliceCount + " total");
                }
            } else if (cc === CC_UP) {
                /* Up: merge current slice with previous (remove start boundary) */
                if (selectedSlice > 0) {
                    sliceBoundaries.splice(selectedSlice, 1);
                    sliceCount = sliceBoundaries.length - 1;
                    selectedSlice--;
                    selectSlice(selectedSlice);
                    syncMarkersToDs();
                    updateSlicePadLeds();
                    showStatus("Merge " + (selectedSlice + 1), 30);
                    announce("Merged, slice " + (selectedSlice + 1) + " of " + sliceCount);
                }
            }
        }
        return;
    }

    /* Jog wheel turn */
    if (cc === CC_JOG) {
        var delta = decodeDelta(value);
        if (delta === 0) return;

        switch (currentView) {
            case VIEW_MODE_MENU:
                menuIndex += delta;
                if (menuIndex < 0) menuIndex = 0;
                if (menuIndex >= menuItems.length) menuIndex = menuItems.length - 1;
                announce(menuItems[menuIndex]);
                break;

            case VIEW_OPEN_FILE:
                if (openFileBrowserState) {
                    moveFilepathBrowserSelection(openFileBrowserState, delta);
                    var bsel = openFileBrowserState.items[openFileBrowserState.selectedIndex];
                    if (bsel) announce(bsel.label);
                }
                break;

            case VIEW_CONFIRM_EXIT:
                confirmIndex += delta;
                if (confirmIndex < 0) confirmIndex = 0;
                if (confirmIndex >= confirmItems.length) confirmIndex = confirmItems.length - 1;
                announce(confirmItems[confirmIndex]);
                break;

            case VIEW_CONFIRM_NORMALIZE:
                normalizeIndex += (delta > 0 ? 1 : -1);
                if (normalizeIndex < 0) normalizeIndex = 0;
                if (normalizeIndex >= normalizeItems.length) normalizeIndex = normalizeItems.length - 1;
                announce(normalizeItems[normalizeIndex]);
                break;

            case VIEW_CONFIRM_SAVE:
                saveIndex += (delta > 0 ? 1 : -1);
                if (saveIndex < 0) saveIndex = 0;
                var maxSaveIdx = saveActions.length; /* 0=filename, 1..N=actions */
                if (saveIndex > maxSaveIdx) saveIndex = maxSaveIdx;
                announce(saveIndex === 0 ? saveName : saveActions[saveIndex - 1]);
                break;

            case VIEW_TRIM:
                /* Adjust selected marker: shift = 1 sample, normal = coarse */
                adjustMarker(selectedField, shiftHeld ? delta : delta * getCoarseStep());
                showJogStatus((selectedField === 0 ? "Start:" : "End:") + formatTime(selectedField === 0 ? startSample : endSample));
                refreshWaveform();
                break;

            case VIEW_LOOP:
                /* Adjust selected marker: shift = 1 sample, normal = coarse */
                adjustMarker(loopSelectedField, shiftHeld ? delta : delta * getLoopCoarseStep());
                seamWaveformDirty = true;
                showJogStatus(loopSelectedField === 0 ? "Pt:" + formatTime(startSample) : "End:" + formatTime(endSample));
                break;

            case VIEW_SLICE:
                if (lazyChopping) break; /* No jog edits while chopping */
                if (sliceMenuEditing) {
                    /* Editing the focused parameter */
                    if (sliceMenuIndex === 0) {
                        /* Toggle mode */
                        /* Cycle: Even -> Auto -> Lazy -> Even */
                        if (delta > 0) {
                            if (sliceMode === SLICE_MODE_EVEN) sliceMode = SLICE_MODE_AUTO;
                            else if (sliceMode === SLICE_MODE_AUTO) sliceMode = SLICE_MODE_LAZY;
                            else sliceMode = SLICE_MODE_EVEN;
                        } else {
                            if (sliceMode === SLICE_MODE_EVEN) sliceMode = SLICE_MODE_LAZY;
                            else if (sliceMode === SLICE_MODE_LAZY) sliceMode = SLICE_MODE_AUTO;
                            else sliceMode = SLICE_MODE_EVEN;
                        }
                        if (sliceMode === SLICE_MODE_LAZY) {
                            lazySub = LAZY_SUB_CHOP;
                            lazyChopping = false;
                        }
                        /* Reset to full region when switching modes */
                        sliceCount = 1;
                        selectedSlice = 0;
                        sliceBoundaries = [];
                        slicePadOffset = 0;
                        recomputeSliceBoundaries();
                        selectSlice(0);
                        syncMarkersToDs();
                        updateSlicePadLeds();
                        var modeAnnounce = sliceMode === SLICE_MODE_LAZY ? "Lazy, press Pad 1" : (sliceMode === SLICE_MODE_AUTO ? "Auto" : "Even");
                        announce(modeAnnounce);
                    } else if (sliceMenuIndex === 1) {
                        if (sliceMode === SLICE_MODE_LAZY) {
                            /* Toggle Chop / Play sub-mode */
                            lazySub = (lazySub === LAZY_SUB_CHOP) ? LAZY_SUB_PLAY : LAZY_SUB_CHOP;
                            lazyChopping = false;
                            updateSlicePadLeds();
                            announce(lazySub === LAZY_SUB_CHOP ? "Chop, press Pad 1" : "Play");
                        } else if (sliceMode === SLICE_MODE_EVEN) {
                            /* Adjust slice count */
                            sliceCount += (delta > 0 ? 1 : -1);
                            if (sliceCount < 1) sliceCount = 1;
                            if (sliceCount > 128) sliceCount = 128;
                            recomputeSliceBoundaries();
                            selectSlice(selectedSlice);
                            syncMarkersToDs();
                            updateSlicePadLeds();
                            announce("Slices:" + sliceCount);
                        } else {
                            /* Adjust auto threshold (jog = fine 0.1 steps) */
                            sliceThreshold += delta * 0.1;
                            sliceThreshold = Math.round(sliceThreshold * 10) / 10;
                            if (sliceThreshold < 0.1) sliceThreshold = 0.1;
                            if (sliceThreshold > 100) sliceThreshold = 100;
                            recomputeSliceBoundaries();
                            selectSlice(selectedSlice);
                            syncMarkersToDs();
                            updateSlicePadLeds();
                            announce("Thresh:" + sliceThreshold.toFixed(1));
                        }
                    } else if (sliceMenuIndex === 2) {
                        /* Cycle selected slice */
                        var newIdx = selectedSlice + (delta > 0 ? 1 : -1);
                        if (newIdx < 0) newIdx = sliceCount - 1;
                        if (newIdx >= sliceCount) newIdx = 0;
                        selectSlice(newIdx);
                        /* Auto-scroll pad bank */
                        if (selectedSlice < slicePadOffset) {
                            slicePadOffset = Math.floor(selectedSlice / 32) * 32;
                        } else if (selectedSlice >= slicePadOffset + 32) {
                            slicePadOffset = Math.floor(selectedSlice / 32) * 32;
                        }
                        syncMarkersToDs();
                        updateSlicePadLeds();
                        announce("Slice " + (selectedSlice + 1) + "/" + sliceCount);
                    }
                } else {
                    /* Navigate between menu items */
                    sliceMenuIndex += (delta > 0 ? 1 : -1);
                    if (sliceMenuIndex < 0) sliceMenuIndex = 0;
                    if (sliceMenuIndex > 2) sliceMenuIndex = 2;
                    var param2Name = sliceMode === SLICE_MODE_LAZY ? "Sub-mode" : (sliceMode === SLICE_MODE_EVEN ? "Count" : "Thresh");
                    var itemNames = ["Mode", param2Name, "Select"];
                    announce(itemNames[sliceMenuIndex]);
                }
                break;
        }
        return;
    }

    /* Jog click */
    if (cc === CC_JOG_CLICK && value > 0) {
        switch (currentView) {
            case VIEW_MODE_MENU:
                menuSelect();
                break;

            case VIEW_CONFIRM_EXIT:
                confirmSelect();
                break;

            case VIEW_CONFIRM_NORMALIZE:
                normalizeSelect();
                break;

            case VIEW_CONFIRM_SAVE:
                saveSelect();
                break;

            case VIEW_TRIM:
                /* Toggle selected field */
                selectedField = selectedField === 0 ? 1 : 0;
                showStatus(selectedField === 0 ? "Start" : "End", 30);
                break;

            case VIEW_LOOP:
                /* Toggle loop point / end field */
                loopSelectedField = loopSelectedField === 0 ? 1 : 0;
                showStatus(loopSelectedField === 0 ? "Loop Point" : "Loop End", 30);
                break;

            case VIEW_SLICE:
                /* Toggle editing of current menu item */
                sliceMenuEditing = !sliceMenuEditing;
                if (sliceMenuEditing) {
                    var edit2Name = sliceMode === SLICE_MODE_LAZY ? "Sub-mode" : (sliceMode === SLICE_MODE_EVEN ? "Count" : "Threshold");
                    var editNames = ["Editing Mode", "Editing " + edit2Name, "Editing Slice"];
                    announce(editNames[sliceMenuIndex]);
                } else {
                    announce("Navigate");
                }
                break;

            case VIEW_OPEN_FILE:
                if (openFileBrowserState) {
                    /* Check for "New Recording" action item */
                    var selItem = openFileBrowserState.items[openFileBrowserState.selectedIndex];
                    if (selItem && selItem.kind === "action") {
                        recordBrowserDir = openFileBrowserState.currentDir;
                        recordFilePath = generateRecordingPath();
                        recordState = "ready";
                        recordLedCounter = 0;
                        openFileBrowserState = null;
                        switchView(VIEW_TRIM);
                        announce("New Recording, press REC to record");
                        break;
                    }
                    var result = activateFilepathBrowserItem(openFileBrowserState);
                    if (result.action === "open") {
                        refreshBrowserWithRecording();
                        var oDir = openFileBrowserState.currentDir || "";
                        var oDirName = oDir.substring(oDir.lastIndexOf("/") + 1) || "Samples";
                        var oFirst = (openFileBrowserState.items && openFileBrowserState.items.length > 0)
                            ? openFileBrowserState.items[0].label : "empty";
                        announce(oDirName + ", " + oFirst);
                    } else if (result.action === "select") {
                        openedFilePath = result.value;
                        loadFileIntoEditor(result.value);
                        openFileBrowserState = null;
                        announce("Loaded " + fileName);
                        switchView(VIEW_TRIM);
                    }
                }
                break;
        }
        return;
    }

    /* E1 turn: adjust start marker */
    if (cc === CC_E1) {
        var delta = decodeDelta(value);
        if (delta === 0) return;

        if (currentView === VIEW_TRIM) {
            var step = shiftHeld ? 1 : getCoarseStep();
            adjustMarker(0, delta * step);
            showKnobStatus(0, shiftHeld ? "S:" + startSample : "Start:" + formatTime(startSample));
            refreshWaveform();
        } else if (currentView === VIEW_LOOP) {
            var step = shiftHeld ? 1 : getLoopCoarseStep();
            adjustMarker(0, delta * step);
            seamWaveformDirty = true;
            showKnobStatus(0, shiftHeld ? "S:" + startSample : "Pt:" + formatTime(startSample));
        } else if (currentView === VIEW_SLICE && !lazyChopping) {
            /* E1: Move slice start boundary */
            var step = shiftHeld ? 1 : getCoarseStep();
            var bIdx = selectedSlice; /* boundary index for start of selected slice */
            var newVal = sliceBoundaries[bIdx] + delta * step;
            /* Constrain: >= previous slice start (or region start for slice 0) */
            var minVal = (bIdx > 0) ? sliceBoundaries[bIdx - 1] : sliceRegionStart;
            /* Constrain: < slice end */
            var maxVal = sliceBoundaries[bIdx + 1] - 1;
            if (newVal < minVal) newVal = minVal;
            if (newVal > maxVal) newVal = maxVal;
            sliceBoundaries[bIdx] = newVal;
            selectSlice(selectedSlice);
            /* Auto-scroll to keep start marker visible with 10% margin */
            if (zoomLevel > 0) {
                var vStart = getVisibleStart();
                var vEnd = getVisibleEnd();
                var vRange = vEnd - vStart;
                var margin = Math.floor(vRange * 0.10);
                if (newVal < vStart + margin) {
                    zoomCenter = newVal + Math.floor(vRange / 2) - margin;
                } else if (newVal > vEnd - margin) {
                    zoomCenter = newVal - Math.floor(vRange / 2) + margin;
                }
                if (zoomCenter < 0) zoomCenter = 0;
                if (zoomCenter > totalFrames) zoomCenter = totalFrames;
            }
            syncMarkersToDs();
            showKnobStatus(0, "Start:" + formatTime(sliceBoundaries[bIdx]));
        }
        return;
    }

    /* E2 turn: adjust end marker */
    if (cc === CC_E2) {
        var delta = decodeDelta(value);
        if (delta === 0) return;

        if (currentView === VIEW_TRIM) {
            var step = shiftHeld ? 1 : getCoarseStep();
            adjustMarker(1, delta * step);
            showKnobStatus(1, shiftHeld ? "E:" + endSample : "End:" + formatTime(endSample));
            refreshWaveform();
        } else if (currentView === VIEW_LOOP) {
            var step = shiftHeld ? 1 : getLoopCoarseStep();
            adjustMarker(1, delta * step);
            seamWaveformDirty = true;
            showKnobStatus(1, shiftHeld ? "E:" + endSample : "End:" + formatTime(endSample));
        } else if (currentView === VIEW_SLICE && !lazyChopping) {
            /* E2: Move slice end boundary */
            var step = shiftHeld ? 1 : getCoarseStep();
            var bIdx = selectedSlice + 1; /* boundary index for end of selected slice */
            var newVal = sliceBoundaries[bIdx] + delta * step;
            /* Constrain: > slice start */
            var minVal = sliceBoundaries[bIdx - 1] + 1;
            /* Constrain: <= next slice end (or region end for last slice) */
            var maxVal = (bIdx < sliceBoundaries.length - 1) ? sliceBoundaries[bIdx + 1] : sliceRegionEnd;
            if (newVal < minVal) newVal = minVal;
            if (newVal > maxVal) newVal = maxVal;
            sliceBoundaries[bIdx] = newVal;
            selectSlice(selectedSlice);
            /* Auto-scroll to keep end marker visible with 10% margin */
            if (zoomLevel > 0) {
                var vStart = getVisibleStart();
                var vEnd = getVisibleEnd();
                var vRange = vEnd - vStart;
                var margin = Math.floor(vRange * 0.10);
                if (newVal > vEnd - margin) {
                    zoomCenter = newVal - Math.floor(vRange / 2) + margin;
                } else if (newVal < vStart + margin) {
                    zoomCenter = newVal + Math.floor(vRange / 2) - margin;
                }
                if (zoomCenter < 0) zoomCenter = 0;
                if (zoomCenter > totalFrames) zoomCenter = totalFrames;
            }
            syncMarkersToDs();
            showKnobStatus(1, "End:" + formatTime(sliceBoundaries[bIdx]));
        }
        return;
    }

    /* E3 turn: zoom */
    if (cc === CC_E3) {
        var delta = decodeDelta(value);
        if (delta === 0) return;

        if (currentView === VIEW_TRIM || currentView === VIEW_SLICE) {
            var wasZero = (zoomLevel <= 0);
            zoomLevel += delta * ZOOM_STEP;
            if (zoomLevel < 0) zoomLevel = 0;
            if (zoomLevel > ZOOM_MAX) zoomLevel = ZOOM_MAX;
            if (wasZero && zoomLevel > 0) {
                zoomCenter = (currentView === VIEW_SLICE) ? startSample
                    : (selectedField === 0 ? startSample : endSample);
            }
            if (zoomLevel <= 0) {
                showKnobStatus(2, "Zoom: Full");
            } else {
                var zoomFactor = Math.pow(2, zoomLevel);
                showKnobStatus(2, "Zoom:" + zoomFactor.toFixed(1) + "x");
            }
            syncZoomToDsp();
        } else if (currentView === VIEW_LOOP) {
            /* E3: seam zoom (negate: CW = zoom in = fewer samples) */
            seamZoomLevel -= delta * SEAM_ZOOM_STEP;
            if (seamZoomLevel < 0) seamZoomLevel = 0;
            if (seamZoomLevel > ZOOM_MAX) seamZoomLevel = ZOOM_MAX;
            seamWaveformDirty = true;
            var seamFactor = Math.pow(2, seamZoomLevel);
            showKnobStatus(2, "Zoom:" + seamFactor.toFixed(1) + "x");
        }
        return;
    }

    /* E4 turn: vertical scale (all modes) */
    if (cc === CC_E4) {
        var delta = decodeDelta(value);
        if (delta === 0) return;
        vScale *= Math.pow(2, delta * VSCALE_STEP);
        if (vScale < VSCALE_MIN) vScale = VSCALE_MIN;
        if (vScale > VSCALE_MAX) vScale = VSCALE_MAX;
        if (vScale > 0.9 && vScale < 1.1) vScale = 1.0;
        showKnobStatus(3, "Scale:" + vScale.toFixed(1) + "x");
        return;
    }

    /* E5 turn: gain (trim/loop) | threshold (slice auto) | Shift+E5: normalize */
    if (cc === CC_E5) {
        if (currentView === VIEW_SLICE && sliceMode === SLICE_MODE_AUTO) {
            var delta = decodeDelta(value);
            if (delta === 0) return;
            var step = shiftHeld ? 0.1 : 1.0;
            sliceThreshold += delta * step;
            sliceThreshold = Math.round(sliceThreshold * 10) / 10;
            if (sliceThreshold < 0.1) sliceThreshold = 0.1;
            if (sliceThreshold > 100) sliceThreshold = 100;
            recomputeSliceBoundaries();
            selectSlice(selectedSlice);
            syncMarkersToDs();
            updateSlicePadLeds();
            showKnobStatus(4, "T:" + sliceThreshold.toFixed(1));
            return;
        }
        if (currentView === VIEW_TRIM || currentView === VIEW_LOOP) {
            if (shiftHeld) {
                /* Shift+E5: show normalize confirm overlay */
                normalizeIndex = 0;
                switchView(VIEW_CONFIRM_NORMALIZE);
            } else {
                var delta = decodeDelta(value);
                if (delta === 0) return;
                gainDb += delta * GAIN_STEP;
                if (gainDb < GAIN_MIN) gainDb = GAIN_MIN;
                if (gainDb > GAIN_MAX) gainDb = GAIN_MAX;
                host_module_set_param("gain_db", gainDb.toFixed(1));
                showKnobStatus(4, "Gain:" + formatDb(gainDb));
                invalidateWaveform();
            }
        }
        return;
    }

    /* E7/E8 twist actions: turn confirms/cancels pending action */
    if (cc === CC_E7 || cc === CC_E8) {
        var delta = decodeDelta(value);
        if (delta > 0 && pendingTwistAction && pendingTwistAction.cc === cc) {
            /* Twist right = execute */
            if (pendingTwistAction.action === "toggle_loop") {
                toggleLoop();
            } else if (pendingTwistAction.action === "zero_cross") {
                snapToZeroCrossing();
            }
            pendingTwistAction = null;
        } else if (delta < 0 && pendingTwistAction && pendingTwistAction.cc === cc) {
            /* Twist left = cancel */
            pendingTwistAction = null;
            showStatus("Cancelled", 20);
        }
        return;
    }
}

/**
 * Handle note messages (pads and encoder touch events).
 */
function handleNote(note, velocity) {
    /* Ignore pads during record states */
    if (recordState !== "idle") return;

    /* Knob touch: twist actions for E7 (loop) and E8 (zero crossing) */
    if (velocity > 0) {
        if (note === MoveKnob7Touch && (currentView === VIEW_TRIM || currentView === VIEW_LOOP)) {
            pendingTwistAction = { cc: CC_E7, action: "toggle_loop" };
            showStatus("Twist: Loop " + (loopEnabled ? "Off" : "On"), 9999);
            return;
        }
        if (note === MoveKnob8Touch && (currentView === VIEW_TRIM || currentView === VIEW_LOOP)) {
            pendingTwistAction = { cc: CC_E8, action: "zero_cross" };
            showStatus("Twist: Zero Cross Snap", 9999);
            return;
        }
    } else {
        /* Touch release: cancel pending and clear prompt */
        if ((note === MoveKnob7Touch || note === MoveKnob8Touch) && pendingTwistAction) {
            pendingTwistAction = null;
            statusTimer = 0;
            statusMsg = "";
        }
    }

    /* Pad press/release: audition (hold to play, release to stop).
     * Only the most recently pressed pad owns playback — releasing
     * an earlier pad while a newer one is held does nothing. */
    if (note >= PAD_NOTE_MIN && note <= PAD_NOTE_MAX) {
        if (currentView === VIEW_TRIM || currentView === VIEW_LOOP) {
            if (velocity > 0) {
                setLED(note, PAD_COLOR_PLAY);
                activePadNote = note;
                if (shiftHeld) {
                    /* Shift+pad: preview from 3% before end marker */
                    var selLen = endSample - startSample;
                    var previewLen = Math.min(Math.max(Math.floor(selLen * 0.05), Math.floor(sampleRate / 4)), sampleRate * 5);
                    var from = endSample - previewLen;
                    if (from < startSample) from = startSample;
                    startPlaybackFrom(from);
                    showStatus("Preview End", 20);
                } else {
                    startPlayback();
                    showStatus("Play Sel", 20);
                }
            } else {
                setLED(note, PAD_COLOR_DIM);
                if (note === activePadNote) {
                    activePadNote = -1;
                    stopPlayback();
                }
            }
        } else if (currentView === VIEW_SLICE) {
            var padIdx = note - PAD_NOTE_MIN;
            if (sliceMode === SLICE_MODE_LAZY && lazySub === LAZY_SUB_CHOP) {
                /* Lazy chop mode: pad 1 triggers chopping */
                if (padIdx === 0 && velocity > 0) {
                    if (!lazyChopping) {
                        /* Start new chop session */
                        sliceCount = 1;
                        sliceBoundaries = [sliceRegionStart, sliceRegionEnd];
                        startSample = sliceRegionStart;
                        endSample = sliceRegionEnd;
                        syncMarkersToDs();
                        startPlayback();
                        lazyChopping = true;
                        selectedSlice = 0;
                        updateLazyChopPadLeds();
                        showStatus("Chopping", 30);
                    } else {
                        /* Add chop point at current play position */
                        var insertIdx = sliceCount;
                        sliceBoundaries.splice(insertIdx, 0, playPos);
                        sliceCount = sliceBoundaries.length - 1;
                        selectedSlice = sliceCount - 1;
                        updateLazyChopPadLeds();
                        showStatus("Slice " + sliceCount, 20);
                    }
                }
                /* In chop mode, pad release does NOT stop playback */
            } else {
                /* Normal slice or lazy play mode: audition slices */
                var sliceIdx = slicePadOffset + padIdx;
                if (sliceIdx < sliceCount) {
                    if (velocity > 0) {
                        selectSlice(sliceIdx);
                        updateSlicePadLeds();
                        setLED(note, PAD_COLOR_PLAY);
                        activePadNote = note;
                        startPlayback();
                        showStatus("Slice " + (sliceIdx + 1), 20);
                    } else {
                        updateSlicePadLeds();
                        if (note === activePadNote) {
                            activePadNote = -1;
                            stopPlayback();
                        }
                    }
                }
            }
        }
        return;
    }

    /* Knob touch tracking — persist status while knob is held */
    if (note >= TOUCH_NOTE_MIN && note <= TOUCH_NOTE_MAX) {
        var ki = note - TOUCH_NOTE_MIN;
        if (velocity > 0) {
            knobTouched[ki] = true;
            pushTouchOrder(ki);
            /* Announce knob name + current value on touch */
            var label = getKnobLabel(ki);
            if (label !== "") {
                knobStatusMsg[ki] = label;
                announce(label);
            }
        } else {
            knobTouched[ki] = false;
            /* Remove from touch order */
            for (var t = 0; t < knobTouchOrder.length; t++) {
                if (knobTouchOrder[t] === ki) {
                    knobTouchOrder.splice(t, 1);
                    break;
                }
            }
            knobStatusMsg[ki] = "";
        }
        return;
    }
}

/* ============ Exported Entry Points ============ */

globalThis.init = function() {
    var isReconnect = (typeof host_tool_reconnect !== "undefined" && host_tool_reconnect);

    openedFilePath = (typeof host_tool_file_path === "string") ? host_tool_file_path : "";
    refreshFileInfo();
    refreshWaveform();
    refreshState();

    if (isReconnect) {
        /* Reconnecting to existing session — restore view based on DSP state */
        /* Check if DSP is still recording */
        var stillRecording = (typeof host_sampler_is_recording === "function") && host_sampler_is_recording();
        if (stillRecording) {
            recordState = "recording";
            recordFilePath = SCRATCH_PATH;
            openedFilePath = SCRATCH_PATH;
            recordLedCounter = 0;
            currentView = VIEW_TRIM;
            selectedField = 0;

            /* Recover actual elapsed time from sampler's sample counter */
            var samplesWritten = 0;
            if (typeof host_sampler_get_samples_written === "function") {
                samplesWritten = host_sampler_get_samples_written();
            }
            var elapsedSec = samplesWritten / 44100;
            recordStartTime = Date.now() - (elapsedSec * 1000);

            /* Reconstruct waveform array with placeholder entries so the
             * write head position reflects actual recording progress.
             * Each tick adds one entry, ticks are ~16ms apart. */
            var estimatedTicks = Math.round(elapsedSec * 1000 / 16);
            recordWaveform = [];
            for (var i = 0; i < estimatedTicks; i++) {
                recordWaveform.push(0.05);  /* dim baseline so it's visible */
            }
            recordWriteHead = recordWaveform.length;

            var timeStr = Math.floor(elapsedSec / 60) + ":" +
                (elapsedSec % 60 < 10 ? "0" : "") + Math.floor(elapsedSec % 60);
            announce("Wave Edit, recording in progress, " + timeStr);
        } else if ((typeof host_sampler_is_paused === "function") && host_sampler_is_paused()) {
            /* DSP is paused — restore paused state */
            recordState = "paused";
            recordFilePath = SCRATCH_PATH;
            openedFilePath = SCRATCH_PATH;
            recordPauseStart = Date.now();
            recordPausedTotal = 0;
            recordLedCounter = 0;
            currentView = VIEW_TRIM;
            selectedField = 0;

            /* Recover elapsed time from sampler's sample counter */
            var pausedSamples = 0;
            if (typeof host_sampler_get_samples_written === "function") {
                pausedSamples = host_sampler_get_samples_written();
            }
            var pausedElapsed = pausedSamples / 44100;
            recordStartTime = Date.now() - (pausedElapsed * 1000);

            /* Reconstruct waveform with placeholder entries */
            var pausedTicks = Math.round(pausedElapsed * 1000 / 16);
            recordWaveform = [];
            for (var j = 0; j < pausedTicks; j++) {
                recordWaveform.push(0.05);
            }
            recordWriteHead = recordWaveform.length;

            announce("Wave Edit, recording paused");
        } else if (openedFilePath && totalFrames === 0) {
            /* File path set but no audio data — restore record-ready state */
            recordBrowserDir = SCRATCH_DIR;
            recordFilePath = SCRATCH_PATH;
            recordState = "ready";
            recordLedCounter = 0;
            currentView = VIEW_TRIM;
            selectedField = 0;
            announce("New Recording, press REC to record");
        } else if (restoreSliceState()) {
            /* Restored slice state from DSP — resume slice mode */
            currentView = VIEW_SLICE;
            selectedField = 0;
            selectSlice(selectedSlice);
            syncMarkersToDs();
            announce("Wave Edit, slice mode, " + sliceCount + " slices");
        } else {
            currentView = VIEW_TRIM;
            selectedField = 0;
            announce("Wave Edit, " + (fileName || "no file") + ", " + formatTime(totalFrames));
        }
        /* Force full LED repaint */
        ledInitPending = true;
        ledInitIndex = 0;
    } else {
        /* Fresh session */
        currentView = VIEW_TRIM;
        selectedField = 0;
        host_module_set_param("mode", "0");

        if (openedFilePath && totalFrames === 0) {
            /* New file — use scratch path for recording */
            if (typeof host_ensure_dir === "function") {
                host_ensure_dir(SCRATCH_DIR);
            }
            recordFilePath = SCRATCH_PATH;
            recordBrowserDir = SCRATCH_DIR;
            recordState = "ready";
            recordLedCounter = 0;
            announce("New Recording, press REC to record");
        } else {
            announce("Wave Edit, " + (fileName || "no file") + ", " + formatTime(totalFrames));
        }
    }
};

globalThis.tick = function() {
    /* Progressive LED init */
    if (ledInitPending) {
        initLedsStep();
        if (!ledInitPending) {
            /* Init just finished — sync LEDs to current state */
            updateLeds();
        }
    }

    /* Poll for sampler finalization after recording stop */
    if (recordState === "stopping") {
        recordStoppingTicks++;
        if (typeof host_sampler_is_recording === "function" && !host_sampler_is_recording()) {
            /* Sampler finished — load the recorded file.
             * Use blocking set_param to ensure the DSP processes file_path
             * before we query file_info/waveform. In overtake mode, normal
             * set_param is fire-and-forget and can be overwritten by
             * subsequent writes to the single shared-memory IPC slot. */
            recordState = "idle";
            openedFilePath = recordFilePath;
            isRecordedFile = true;
            loadFileIntoEditor(recordFilePath);
            announce("Loaded " + fileName);
            showStatus("Recorded " + fileName, 90);
        } else if (recordStoppingTicks > 220) {
            /* Timeout (~5 sec) — load anyway */
            recordState = "idle";
            openedFilePath = recordFilePath;
            isRecordedFile = true;
            loadFileIntoEditor(recordFilePath);
            showStatus("Recorded " + fileName, 90);
        }
    }

    /* Flush queued play/stop command — issued here in tick() so it's the
     * last set_param in the frame, after encoder flush has completed.
     * This prevents knob params from overwriting the play command.
     * In slice mode, sync markers then use a blocking get_param as a
     * barrier so the DSP processes markers before we issue play. */
    if (pendingPlay !== "") {
        if (pendingPlay === "stop") {
            host_module_set_param("stop", "1");
        } else if (pendingPlay.indexOf("from:") === 0) {
            host_module_set_param("play_from", pendingPlay.substring(5));
        } else {
            if (currentView === VIEW_SLICE) {
                syncMarkersToDs();
                host_module_get_param("dirty"); /* sync barrier: blocks until DSP processes markers */
            }
            host_module_set_param("play", pendingPlay);
        }
        pendingPlay = "";
    }

    /* Poll playback state if playing */
    if (playing) {
        var posRaw = host_module_get_param("play_pos");
        if (posRaw) playPos = parseInt(posRaw, 10) || 0;

        var playingRaw = host_module_get_param("playing");
        if (playingRaw === "0" || playingRaw === "false") {
            playing = false;
            if (lazyChopping) {
                /* Sample reached end — finalize chop session */
                lazyChopping = false;
                lazySub = LAZY_SUB_PLAY;
                selectedSlice = 0;
                selectSlice(0);
                updateSlicePadLeds();
                showStatus("Chop done, " + sliceCount + " slices", 30);
            }
        }
    }

    /* Decay status message timer */
    if (statusTimer > 0) {
        statusTimer--;
        if (statusTimer <= 0) {
            statusMsg = "";
        }
    }

    /* Decay jog virtual touch timer */
    if (jogHeldTimer > 0) {
        jogHeldTimer--;
        if (jogHeldTimer <= 0) {
            jogStatusMsg = "";
            /* Remove jog from touch order */
            for (var t = 0; t < knobTouchOrder.length; t++) {
                if (knobTouchOrder[t] === JOG_ID) {
                    knobTouchOrder.splice(t, 1);
                    break;
                }
            }
        }
    }

    /* Record LED flash */
    if (recordState === "ready") {
        recordLedCounter++;
        if (recordLedCounter % 15 === 0) {
            setButtonLED(CC_REC, (recordLedCounter % 30 < 15) ? BrightRed : LED_OFF);
        }
    }
    if (recordState === "paused") {
        recordLedCounter++;
        if (recordLedCounter % 30 === 0) {
            setButtonLED(CC_REC, (recordLedCounter % 60 < 30) ? DeepRed : LED_OFF);
        }
    }

    /* Draw current view */
    switch (currentView) {
        case VIEW_MODE_MENU:
            drawModeMenu();
            break;
        case VIEW_TRIM:
            drawTrimView();
            break;
        case VIEW_LOOP:
            drawLoopView();
            break;
        case VIEW_CONFIRM_EXIT:
            drawConfirmExit();
            break;
        case VIEW_CONFIRM_NORMALIZE:
            drawConfirmNormalize();
            break;
        case VIEW_CONFIRM_SAVE:
            drawConfirmSave();
            break;
        case VIEW_OPEN_FILE:
            drawOpenFileBrowser();
            break;
        case VIEW_SLICE:
            drawSliceView();
            break;
    }
};

globalThis.onMidiMessageInternal = function(data) {
    var status = data[0] & 0xF0;
    var d1 = data[1];
    var d2 = data[2];

    if (status === 0xB0) {
        /* CC message */
        handleCC(d1, d2);
    } else if (status === 0x90) {
        /* Note on */
        handleNote(d1, d2);
    } else if (status === 0x80) {
        /* Note off - treat as touch release */
        handleNote(d1, 0);
    }
};
