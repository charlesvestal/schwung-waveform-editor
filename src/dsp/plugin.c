/*
 * Waveform Editor DSP Plugin
 *
 * Provides WAV file loading, playback, trimming, gain adjustment,
 * normalization, and waveform visualization for the Move Everything
 * waveform editor tool.
 *
 * V2 API only - instance-based for multi-instance support.
 * Audio stored as interleaved stereo int16 (L,R,L,R,...).
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <math.h>
#include <time.h>
#include <unistd.h>
#include <pwd.h>

/* ============================================================================
 * Plugin API definitions (inlined to avoid path issues during cross-compile)
 * ============================================================================ */

#define MOVE_PLUGIN_API_VERSION_2 2
#define MOVE_SAMPLE_RATE 44100
#define MOVE_FRAMES_PER_BLOCK 128

typedef struct host_api_v1 {
    uint32_t api_version;
    int sample_rate;
    int frames_per_block;
    uint8_t *mapped_memory;
    int audio_out_offset;
    int audio_in_offset;
    void (*log)(const char *msg);
    int (*midi_send_internal)(const uint8_t *msg, int len);
    int (*midi_send_external)(const uint8_t *msg, int len);
    int (*get_clock_status)(void);
} host_api_v1_t;

typedef struct plugin_api_v2 {
    uint32_t api_version;
    void* (*create_instance)(const char *module_dir, const char *json_defaults);
    void (*destroy_instance)(void *instance);
    void (*on_midi)(void *instance, const uint8_t *msg, int len, int source);
    void (*set_param)(void *instance, const char *key, const char *val);
    int (*get_param)(void *instance, const char *key, char *buf, int buf_len);
    int (*get_error)(void *instance, char *buf, int buf_len);
    void (*render_block)(void *instance, int16_t *out_interleaved_lr, int frames);
} plugin_api_v2_t;

/* ============================================================================
 * Constants
 * ============================================================================ */

#define MAX_WAVEFORM_COLS 256
#define NORMALIZE_TARGET_DB (-0.3f)

/* Maximum audio duration: 10 minutes at 44100 Hz */
#define MAX_AUDIO_FRAMES (MOVE_SAMPLE_RATE * 600)

/* Samples per frame (stereo interleaved) */
#define SAMPLES_PER_FRAME 2

/* ============================================================================
 * Instance structure
 * ============================================================================ */

typedef struct {
    char file_path[512];
    char file_name[128];
    int sample_rate;
    int channels;
    int total_frames;
    uint16_t orig_format;       /* 1=PCM, 3=IEEE float */
    uint16_t orig_bits;         /* 16, 24, or 32 */
    uint16_t orig_channels;     /* 1=mono, 2=stereo */
    float duration_secs;

    int16_t *audio_data;        /* Stereo interleaved PCM buffer (L,R,L,R,...) */
    int audio_frames;           /* Number of frames (each frame = 2 samples) */
    int16_t *undo_buffer;
    int undo_frames;
    int has_undo;
    int dirty;

    int16_t *clipboard_data;    /* Clipboard buffer (stereo interleaved) */
    int clipboard_frames;

    int16_t waveform_min[MAX_WAVEFORM_COLS];
    int16_t waveform_max[MAX_WAVEFORM_COLS];
    int waveform_cols;

    int start_sample;
    int end_sample;
    int zoom_level;             /* 0=fit all, 1-12 zoom levels */
    int zoom_center;

    int playing;
    int play_pos;
    int play_loop;
    int play_whole;

    float gain_db;
    float peak_db;

    int mode;                   /* 0=trim, 1=gain */

    char copy_result[256];
    char load_error[256];
    char module_dir[512];
    char slice_state[2048];     /* JSON blob for UI slice state persistence across reconnect */
} instance_t;

/* ============================================================================
 * Globals
 * ============================================================================ */

static const host_api_v1_t *g_host = NULL;

static void plugin_log(const char *msg) {
    if (g_host && g_host->log) {
        char buf[512];
        snprintf(buf, sizeof(buf), "[waveform-editor] %s", msg);
        g_host->log(buf);
    }
}

/* Escape a string for JSON output (handles " and \) */
static int json_escape(char *dst, int dst_len, const char *src) {
    int i = 0;
    while (*src && i < dst_len - 1) {
        if (*src == '"' || *src == '\\') {
            if (i + 2 >= dst_len) break;
            dst[i++] = '\\';
        }
        dst[i++] = *src++;
    }
    dst[i] = '\0';
    return i;
}

/* ============================================================================
 * WAV file utilities
 * ============================================================================ */

/* Read a 16-bit little-endian unsigned value */
static uint16_t read_u16_le(const uint8_t *p) {
    return (uint16_t)(p[0] | (p[1] << 8));
}

/* Read a 32-bit little-endian unsigned value */
static uint32_t read_u32_le(const uint8_t *p) {
    return (uint32_t)(p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] << 24));
}

/* Write a 16-bit little-endian value */
static void write_u16_le(uint8_t *p, uint16_t v) {
    p[0] = (uint8_t)(v & 0xFF);
    p[1] = (uint8_t)((v >> 8) & 0xFF);
}

/* Write a 32-bit little-endian value */
static void write_u32_le(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)(v & 0xFF);
    p[1] = (uint8_t)((v >> 8) & 0xFF);
    p[2] = (uint8_t)((v >> 16) & 0xFF);
    p[3] = (uint8_t)((v >> 24) & 0xFF);
}

/*
 * Load a WAV file into the instance.
 * Supports 16-bit PCM, 24-bit PCM, and 32-bit float, mono or stereo.
 * Mono files are expanded to stereo. All formats converted to int16 stereo.
 * Returns 0 on success, -1 on error.
 */
static int load_wav(instance_t *inst, const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) {
        snprintf(inst->load_error, sizeof(inst->load_error),
                 "Cannot open file: %s", path);
        plugin_log(inst->load_error);
        return -1;
    }

    /* Read entire file into memory for parsing */
    fseek(f, 0, SEEK_END);
    long file_size = ftell(f);
    fseek(f, 0, SEEK_SET);

    if (file_size < 44) {
        snprintf(inst->load_error, sizeof(inst->load_error),
                 "File too small to be WAV: %ld bytes", file_size);
        plugin_log(inst->load_error);
        fclose(f);
        return -1;
    }

    uint8_t *file_data = (uint8_t *)malloc((size_t)file_size);
    if (!file_data) {
        snprintf(inst->load_error, sizeof(inst->load_error),
                 "Out of memory reading file (%ld bytes)", file_size);
        plugin_log(inst->load_error);
        fclose(f);
        return -1;
    }

    size_t bytes_read = fread(file_data, 1, (size_t)file_size, f);
    fclose(f);

    if ((long)bytes_read != file_size) {
        snprintf(inst->load_error, sizeof(inst->load_error),
                 "Short read: expected %ld, got %zu", file_size, bytes_read);
        plugin_log(inst->load_error);
        free(file_data);
        return -1;
    }

    /* Verify RIFF header */
    if (memcmp(file_data, "RIFF", 4) != 0 ||
        memcmp(file_data + 8, "WAVE", 4) != 0) {
        snprintf(inst->load_error, sizeof(inst->load_error),
                 "Not a valid WAV file (missing RIFF/WAVE header)");
        plugin_log(inst->load_error);
        free(file_data);
        return -1;
    }

    /* Search for fmt and data chunks */
    uint16_t audio_format = 0;
    uint16_t num_channels = 0;
    uint32_t wav_sample_rate = 0;
    uint16_t bits_per_sample = 0;
    const uint8_t *data_ptr = NULL;
    uint32_t data_size = 0;
    int found_fmt = 0;
    int found_data = 0;

    size_t pos = 12; /* Skip RIFF header + "WAVE" */
    while (pos + 8 <= (size_t)file_size) {
        const uint8_t *chunk = file_data + pos;
        uint32_t chunk_size = read_u32_le(chunk + 4);

        if (memcmp(chunk, "fmt ", 4) == 0 && chunk_size >= 16) {
            audio_format    = read_u16_le(chunk + 8);
            num_channels    = read_u16_le(chunk + 10);
            wav_sample_rate = read_u32_le(chunk + 12);
            /* byte_rate at +16, block_align at +20 */
            bits_per_sample = read_u16_le(chunk + 22);
            found_fmt = 1;
        } else if (memcmp(chunk, "data", 4) == 0) {
            data_ptr = chunk + 8;
            data_size = chunk_size;
            found_data = 1;
        }

        /* Advance to next chunk (chunk sizes are word-aligned) */
        pos += 8 + chunk_size;
        if (chunk_size & 1) pos++; /* Pad byte for odd-sized chunks */
    }

    if (!found_fmt || !found_data) {
        snprintf(inst->load_error, sizeof(inst->load_error),
                 "Missing %s%s%s chunk",
                 found_fmt ? "" : "fmt ",
                 (!found_fmt && !found_data) ? "and " : "",
                 found_data ? "" : "data");
        plugin_log(inst->load_error);
        free(file_data);
        return -1;
    }

    /* Supported formats: PCM 16-bit, PCM 24-bit, IEEE float 32-bit */
    if (audio_format == 1 && bits_per_sample != 16 && bits_per_sample != 24) {
        snprintf(inst->load_error, sizeof(inst->load_error),
                 "Unsupported PCM bit depth %u (16 or 24 supported)",
                 bits_per_sample);
        plugin_log(inst->load_error);
        free(file_data);
        return -1;
    }
    if (audio_format == 3 && bits_per_sample != 32) {
        snprintf(inst->load_error, sizeof(inst->load_error),
                 "Unsupported float bit depth %u (only 32-bit supported)",
                 bits_per_sample);
        plugin_log(inst->load_error);
        free(file_data);
        return -1;
    }
    if (audio_format != 1 && audio_format != 3) {
        snprintf(inst->load_error, sizeof(inst->load_error),
                 "Unsupported audio format %u (PCM=1 or float=3 supported)",
                 audio_format);
        plugin_log(inst->load_error);
        free(file_data);
        return -1;
    }

    if (num_channels < 1 || num_channels > 2) {
        snprintf(inst->load_error, sizeof(inst->load_error),
                 "Unsupported channel count %u (only mono/stereo supported)",
                 num_channels);
        plugin_log(inst->load_error);
        free(file_data);
        return -1;
    }

    /* Calculate number of frames */
    int bytes_per_frame = num_channels * (bits_per_sample / 8);
    int total_frames = (int)(data_size / (uint32_t)bytes_per_frame);

    if (total_frames <= 0) {
        snprintf(inst->load_error, sizeof(inst->load_error),
                 "WAV file contains no audio data");
        plugin_log(inst->load_error);
        free(file_data);
        return -1;
    }

    if (total_frames > MAX_AUDIO_FRAMES) {
        snprintf(inst->load_error, sizeof(inst->load_error),
                 "File too long: %d frames (max %d)", total_frames, MAX_AUDIO_FRAMES);
        plugin_log(inst->load_error);
        free(file_data);
        return -1;
    }

    /* Allocate stereo interleaved audio buffer */
    int16_t *audio = (int16_t *)malloc((size_t)total_frames * SAMPLES_PER_FRAME * sizeof(int16_t));
    if (!audio) {
        snprintf(inst->load_error, sizeof(inst->load_error),
                 "Out of memory allocating %d stereo frames", total_frames);
        plugin_log(inst->load_error);
        free(file_data);
        return -1;
    }

    /* Convert to stereo int16 — handles PCM16, PCM24, and float32 */
    if (audio_format == 3 && bits_per_sample == 32) {
        /* IEEE float 32-bit */
        const float *fsrc = (const float *)data_ptr;
        if (num_channels == 1) {
            for (int i = 0; i < total_frames; i++) {
                float s = fsrc[i];
                if (s > 1.0f) s = 1.0f;
                if (s < -1.0f) s = -1.0f;
                int16_t v = (int16_t)(s * 32767.0f);
                audio[i * 2]     = v;
                audio[i * 2 + 1] = v;
            }
        } else {
            for (int i = 0; i < total_frames; i++) {
                float left  = fsrc[i * 2];
                float right = fsrc[i * 2 + 1];
                if (left > 1.0f) left = 1.0f;
                if (left < -1.0f) left = -1.0f;
                if (right > 1.0f) right = 1.0f;
                if (right < -1.0f) right = -1.0f;
                audio[i * 2]     = (int16_t)(left * 32767.0f);
                audio[i * 2 + 1] = (int16_t)(right * 32767.0f);
            }
        }
    } else if (audio_format == 1 && bits_per_sample == 24) {
        /* PCM 24-bit */
        const uint8_t *bsrc = (const uint8_t *)data_ptr;
        int src_bytes_per_frame = 3 * num_channels;
        if (num_channels == 1) {
            for (int i = 0; i < total_frames; i++) {
                const uint8_t *p = bsrc + i * 3;
                int32_t s = (int32_t)((uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16));
                if (s & 0x800000) s |= (int32_t)0xFF000000;
                int16_t v = (int16_t)(s >> 8);
                audio[i * 2]     = v;
                audio[i * 2 + 1] = v;
            }
        } else {
            for (int i = 0; i < total_frames; i++) {
                const uint8_t *p = bsrc + i * src_bytes_per_frame;
                int32_t left  = (int32_t)((uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16));
                int32_t right = (int32_t)((uint32_t)p[3] | ((uint32_t)p[4] << 8) | ((uint32_t)p[5] << 16));
                if (left & 0x800000)  left  |= (int32_t)0xFF000000;
                if (right & 0x800000) right |= (int32_t)0xFF000000;
                audio[i * 2]     = (int16_t)(left >> 8);
                audio[i * 2 + 1] = (int16_t)(right >> 8);
            }
        }
    } else {
        /* PCM 16-bit */
        const int16_t *src = (const int16_t *)data_ptr;
        if (num_channels == 1) {
            for (int i = 0; i < total_frames; i++) {
                audio[i * 2]     = src[i];
                audio[i * 2 + 1] = src[i];
            }
        } else {
            memcpy(audio, src, (size_t)total_frames * SAMPLES_PER_FRAME * sizeof(int16_t));
        }
    }

    /* Free old audio data */
    if (inst->audio_data) {
        free(inst->audio_data);
        inst->audio_data = NULL;
    }
    if (inst->undo_buffer) {
        free(inst->undo_buffer);
        inst->undo_buffer = NULL;
    }

    /* Update instance state */
    inst->audio_data = audio;
    inst->audio_frames = total_frames;
    inst->undo_buffer = NULL;
    inst->undo_frames = 0;
    inst->has_undo = 0;
    inst->dirty = 0;

    inst->sample_rate = (int)wav_sample_rate;
    inst->channels = 2; /* Always stereo internally */
    inst->total_frames = total_frames;
    inst->orig_format = audio_format;
    inst->orig_bits = bits_per_sample;
    inst->orig_channels = num_channels;
    inst->duration_secs = (float)total_frames / (float)wav_sample_rate;

    inst->start_sample = 0;
    inst->end_sample = total_frames;
    inst->zoom_level = 0;
    inst->zoom_center = total_frames / 2;

    inst->playing = 0;
    inst->play_pos = 0;
    inst->gain_db = 0.0f;
    inst->mode = 0;

    inst->load_error[0] = '\0';
    inst->copy_result[0] = '\0';

    free(file_data);

    {
        char log_buf[256];
        snprintf(log_buf, sizeof(log_buf),
                 "Loaded WAV: %d frames, %u Hz, %u ch -> stereo int16",
                 total_frames, wav_sample_rate, num_channels);
        plugin_log(log_buf);
    }

    return 0;
}

/*
 * Write WAV file from interleaved stereo int16 data.
 * out_fmt: 1=PCM, 3=IEEE float.  out_bits: 16, 24, or 32.
 * out_channels: 1=mono (uses L channel), 2=stereo.
 * Returns 0 on success, -1 on error.
 */
/* Chown file to ableton user so Move's UI can see it.
 * The shim runs as root but Move's UI runs as ableton. */
static void chown_to_ableton(const char *path) {
    struct passwd *pw = getpwnam("ableton");
    if (pw) chown(path, pw->pw_uid, pw->pw_gid);
}

static int write_wav(const char *path, const int16_t *data, int num_frames,
                     int sample_rate, uint16_t out_fmt, uint16_t out_bits,
                     uint16_t out_channels) {
    if (!path || !data || num_frames <= 0) return -1;

    FILE *f = fopen(path, "wb");
    if (!f) {
        char log_buf[256];
        snprintf(log_buf, sizeof(log_buf), "Cannot open for writing: %s", path);
        plugin_log(log_buf);
        return -1;
    }

    int bytes_per_sample = out_bits / 8;
    int block_align = out_channels * bytes_per_sample;
    uint32_t data_size = (uint32_t)num_frames * (uint32_t)block_align;
    uint32_t file_size = 36 + data_size;

    uint8_t header[44];

    /* RIFF header */
    memcpy(header, "RIFF", 4);
    write_u32_le(header + 4, file_size);
    memcpy(header + 8, "WAVE", 4);

    /* fmt chunk */
    memcpy(header + 12, "fmt ", 4);
    write_u32_le(header + 16, 16);
    write_u16_le(header + 20, out_fmt);
    write_u16_le(header + 22, out_channels);
    write_u32_le(header + 24, (uint32_t)sample_rate);
    write_u32_le(header + 28, (uint32_t)(sample_rate * block_align));
    write_u16_le(header + 32, (uint16_t)block_align);
    write_u16_le(header + 34, out_bits);

    /* data chunk */
    memcpy(header + 36, "data", 4);
    write_u32_le(header + 40, data_size);

    size_t written = fwrite(header, 1, 44, f);
    if (written != 44) { fclose(f); return -1; }

    /* Write sample data, converting from internal stereo int16 */
    int ok = 1;
    for (int i = 0; i < num_frames && ok; i++) {
        for (int ch = 0; ch < out_channels; ch++) {
            int16_t s = data[i * 2 + ch]; /* ch=0 is L, ch=1 is R */

            if (out_fmt == 3 && out_bits == 32) {
                /* IEEE float 32-bit */
                float fs = (float)s / 32767.0f;
                if (fwrite(&fs, sizeof(float), 1, f) != 1) ok = 0;
            } else if (out_fmt == 1 && out_bits == 24) {
                /* PCM 24-bit */
                int32_t s24 = (int32_t)s << 8;
                uint8_t b[3] = { (uint8_t)(s24 & 0xFF),
                                 (uint8_t)((s24 >> 8) & 0xFF),
                                 (uint8_t)((s24 >> 16) & 0xFF) };
                if (fwrite(b, 3, 1, f) != 1) ok = 0;
            } else {
                /* PCM 16-bit */
                if (fwrite(&s, sizeof(int16_t), 1, f) != 1) ok = 0;
            }
        }
    }
    fclose(f);
    if (!ok) return -1;

    {
        char log_buf[256];
        const char *fmt_name = (out_fmt == 3) ? "float" : "PCM";
        snprintf(log_buf, sizeof(log_buf),
                 "Wrote WAV: %s (%d frames, %s %d-bit %s)",
                 path, num_frames, fmt_name, out_bits,
                 out_channels == 1 ? "mono" : "stereo");
        plugin_log(log_buf);
    }

    chown_to_ableton(path);
    return 0;
}

/* ============================================================================
 * Waveform computation
 * ============================================================================ */

/*
 * Compute visible range based on zoom level and center position.
 * zoom_level 0 = show entire file.
 * zoom_level 1-12 = progressively narrower window.
 */
static void get_visible_range(const instance_t *inst,
                              int *out_start, int *out_end) {
    if (!inst->audio_data || inst->audio_frames <= 0) {
        *out_start = 0;
        *out_end = 0;
        return;
    }

    if (inst->zoom_level <= 0) {
        /* Show entire file */
        *out_start = 0;
        *out_end = inst->audio_frames;
        return;
    }

    /* Each zoom level halves the visible window.
     * Level 1: 1/2 of file, Level 2: 1/4, ..., Level 12: 1/4096 */
    float fraction = 1.0f / (float)(1 << inst->zoom_level);
    int visible_frames = (int)((float)inst->audio_frames * fraction);
    if (visible_frames < 128) visible_frames = 128; /* Minimum visible */

    int half = visible_frames / 2;
    int center = inst->zoom_center;

    /* Clamp center so visible window stays within bounds */
    if (center < half) center = half;
    if (center > inst->audio_frames - half) center = inst->audio_frames - half;
    if (center < half) center = half; /* Handle very short files */

    *out_start = center - half;
    *out_end = center + half;

    /* Final clamp */
    if (*out_start < 0) *out_start = 0;
    if (*out_end > inst->audio_frames) *out_end = inst->audio_frames;
}

/*
 * Compute waveform overview (min/max per column) for an explicit sample range.
 * Uses L channel only for display.
 */
static void compute_waveform_range(instance_t *inst, int num_cols,
                                   int vis_start, int vis_end) {
    if (num_cols <= 0) num_cols = 1;
    if (num_cols > MAX_WAVEFORM_COLS) num_cols = MAX_WAVEFORM_COLS;

    inst->waveform_cols = num_cols;

    if (!inst->audio_data || inst->audio_frames <= 0) {
        memset(inst->waveform_min, 0, (size_t)num_cols * sizeof(int16_t));
        memset(inst->waveform_max, 0, (size_t)num_cols * sizeof(int16_t));
        return;
    }

    /* Clamp range */
    if (vis_start < 0) vis_start = 0;
    if (vis_end > inst->audio_frames) vis_end = inst->audio_frames;
    int vis_frames = vis_end - vis_start;
    if (vis_frames <= 0) {
        memset(inst->waveform_min, 0, (size_t)num_cols * sizeof(int16_t));
        memset(inst->waveform_max, 0, (size_t)num_cols * sizeof(int16_t));
        return;
    }

    for (int col = 0; col < num_cols; col++) {
        int col_start = vis_start + (col * vis_frames) / num_cols;
        int col_end   = vis_start + ((col + 1) * vis_frames) / num_cols;
        if (col_end <= col_start) col_end = col_start + 1;
        if (col_end > vis_end) col_end = vis_end;

        int16_t mn = 32767;
        int16_t mx = -32768;

        for (int i = col_start; i < col_end; i++) {
            int16_t s = inst->audio_data[i * 2]; /* L channel */
            if (s < mn) mn = s;
            if (s > mx) mx = s;
        }

        inst->waveform_min[col] = mn;
        inst->waveform_max[col] = mx;
    }
}

/*
 * Compute waveform overview using internal zoom state.
 */
static void compute_waveform(instance_t *inst, int num_cols) {
    int vis_start, vis_end;
    get_visible_range(inst, &vis_start, &vis_end);
    compute_waveform_range(inst, num_cols, vis_start, vis_end);
}

/* ============================================================================
 * Peak level computation
 * ============================================================================ */

/*
 * Scan stereo audio buffer and compute peak level in dB.
 * Scans both L and R channels.
 * Returns -inf for silence.
 */
static float compute_peak_db(const int16_t *data, int num_frames) {
    if (!data || num_frames <= 0) return -96.0f;

    int32_t peak = 0;
    int total_samples = num_frames * SAMPLES_PER_FRAME;
    for (int i = 0; i < total_samples; i++) {
        int32_t abs_val = (int32_t)data[i];
        if (abs_val < 0) abs_val = -abs_val;
        if (abs_val > peak) peak = abs_val;
    }

    if (peak == 0) return -96.0f;

    return 20.0f * log10f((float)peak / 32768.0f);
}

/* ============================================================================
 * Undo management
 * ============================================================================ */

/*
 * Save current audio state to undo buffer.
 */
static void save_undo(instance_t *inst) {
    if (!inst->audio_data || inst->audio_frames <= 0) return;

    /* Free old undo buffer */
    if (inst->undo_buffer) {
        free(inst->undo_buffer);
        inst->undo_buffer = NULL;
    }

    size_t buf_size = (size_t)inst->audio_frames * SAMPLES_PER_FRAME * sizeof(int16_t);
    inst->undo_buffer = (int16_t *)malloc(buf_size);
    if (!inst->undo_buffer) {
        inst->undo_frames = 0;
        inst->has_undo = 0;
        plugin_log("Failed to allocate undo buffer");
        return;
    }

    memcpy(inst->undo_buffer, inst->audio_data, buf_size);
    inst->undo_frames = inst->audio_frames;
    inst->has_undo = 1;
}

/* ============================================================================
 * Filename utilities
 * ============================================================================ */

/*
 * Extract filename from a full path.
 */
static const char* basename_ptr(const char *path) {
    const char *last_slash = strrchr(path, '/');
    return last_slash ? last_slash + 1 : path;
}

/*
 * Generate an edited copy filename from the original with timestamp.
 * "sample.wav" -> "sample_edit_0306_1423.wav"
 * Writes into out_buf with max out_len.
 */
static void make_edit_filename(const char *original_path, char *out_buf,
                               int out_len) {
    /* Get timestamp */
    time_t now = time(NULL);
    struct tm *t = localtime(&now);
    char ts[16];
    snprintf(ts, sizeof(ts), "%02d%02d_%02d%02d",
             t->tm_mon + 1, t->tm_mday, t->tm_hour, t->tm_min);

    /* Find the directory */
    const char *filename = basename_ptr(original_path);
    int dir_len = (int)(filename - original_path);

    /* Find the extension */
    const char *dot = strrchr(filename, '.');
    if (!dot) {
        snprintf(out_buf, (size_t)out_len, "%s_edit_%s.wav", original_path, ts);
        return;
    }

    int name_part_len = (int)(dot - filename);

    /* Build: dir + name_part + "_edit_MMDD_HHMM" + extension */
    snprintf(out_buf, (size_t)out_len, "%.*s%.*s_edit_%s%s",
             dir_len, original_path,
             name_part_len, filename,
             ts, dot);
}

/* ============================================================================
 * V2 API implementation
 * ============================================================================ */

static void* v2_create(const char *module_dir, const char *json_defaults) {
    (void)json_defaults;

    instance_t *inst = (instance_t *)calloc(1, sizeof(instance_t));
    if (!inst) {
        plugin_log("Failed to allocate instance");
        return NULL;
    }

    if (module_dir) {
        strncpy(inst->module_dir, module_dir, sizeof(inst->module_dir) - 1);
    }

    inst->gain_db = 0.0f;
    inst->peak_db = -96.0f;
    inst->mode = 0;
    inst->zoom_level = 0;

    /* Default output format for new recordings */
    inst->orig_format = 1;    /* PCM */
    inst->orig_bits = 16;
    inst->orig_channels = 2;  /* stereo */

    plugin_log("Instance created");
    return inst;
}

static void v2_destroy(void *instance) {
    if (!instance) return;
    instance_t *inst = (instance_t *)instance;

    if (inst->audio_data) {
        free(inst->audio_data);
        inst->audio_data = NULL;
    }
    if (inst->undo_buffer) {
        free(inst->undo_buffer);
        inst->undo_buffer = NULL;
    }
    if (inst->clipboard_data) {
        free(inst->clipboard_data);
        inst->clipboard_data = NULL;
    }

    free(inst);
    plugin_log("Instance destroyed");
}

static void v2_on_midi(void *instance, const uint8_t *msg, int len,
                       int source) {
    /* Waveform editor does not process MIDI */
    (void)instance;
    (void)msg;
    (void)len;
    (void)source;
}

/* ---- set_param ---- */

static void v2_set_param(void *instance, const char *key, const char *val) {
    if (!instance || !key) return;
    instance_t *inst = (instance_t *)instance;

    /* --- File loading --- */
    if (strcmp(key, "file_path") == 0) {
        if (!val || val[0] == '\0') return;

        strncpy(inst->file_path, val, sizeof(inst->file_path) - 1);
        inst->file_path[sizeof(inst->file_path) - 1] = '\0';

        /* Extract filename */
        const char *fn = basename_ptr(val);
        strncpy(inst->file_name, fn, sizeof(inst->file_name) - 1);
        inst->file_name[sizeof(inst->file_name) - 1] = '\0';

        /* Stop any playback */
        inst->playing = 0;

        /* Load the file */
        if (load_wav(inst, val) == 0) {
            /* Compute initial waveform and peak */
            compute_waveform(inst, 128);
            inst->peak_db = compute_peak_db(inst->audio_data,
                                            inst->audio_frames);
        }
        return;
    }

    /* --- Selection markers --- */
    /* Combined marker param: "start,end" - avoids fire-and-forget race */
    if (strcmp(key, "markers") == 0) {
        if (!val) return;
        int s = 0, e = 0;
        if (sscanf(val, "%d,%d", &s, &e) == 2) {
            if (s < 0) s = 0;
            if (inst->audio_data && s > inst->audio_frames) s = inst->audio_frames;
            if (e < 0) e = 0;
            if (inst->audio_data && e > inst->audio_frames) e = inst->audio_frames;
            inst->start_sample = s;
            inst->end_sample = e;
        }
        return;
    }

    if (strcmp(key, "start_sample") == 0) {
        if (!val) return;
        int v = atoi(val);
        if (v < 0) v = 0;
        if (inst->audio_data && v > inst->audio_frames)
            v = inst->audio_frames;
        inst->start_sample = v;
        return;
    }

    if (strcmp(key, "end_sample") == 0) {
        if (!val) return;
        int v = atoi(val);
        if (v < 0) v = 0;
        if (inst->audio_data && v > inst->audio_frames)
            v = inst->audio_frames;
        inst->end_sample = v;
        return;
    }

    /* --- Zoom --- */
    /* Combined zoom param: "level,center" - avoids fire-and-forget race */
    if (strcmp(key, "zoom") == 0) {
        if (!val) return;
        int level = 0, center = 0;
        if (sscanf(val, "%d,%d", &level, &center) == 2) {
            if (level < 0) level = 0;
            if (level > 12) level = 12;
            if (center < 0) center = 0;
            if (inst->audio_data && center > inst->audio_frames)
                center = inst->audio_frames;
            inst->zoom_level = level;
            inst->zoom_center = center;
        }
        return;
    }

    if (strcmp(key, "zoom_level") == 0) {
        if (!val) return;
        int v = atoi(val);
        if (v < 0) v = 0;
        if (v > 12) v = 12;
        inst->zoom_level = v;
        return;
    }

    if (strcmp(key, "zoom_center") == 0) {
        if (!val) return;
        int v = atoi(val);
        if (v < 0) v = 0;
        if (inst->audio_data && v > inst->audio_frames)
            v = inst->audio_frames;
        inst->zoom_center = v;
        return;
    }

    /* --- Mode --- */
    if (strcmp(key, "mode") == 0) {
        if (!val) return;
        int v = atoi(val);
        inst->mode = (v == 1) ? 1 : 0;
        return;
    }

    /* --- Playback --- */
    if (strcmp(key, "play") == 0) {
        if (!inst->audio_data || inst->audio_frames <= 0) return;

        /* Value encodes play mode: "whole" = entire file, anything else = selection */
        int whole = (val && strcmp(val, "whole") == 0) ? 1 : 0;
        inst->play_whole = whole;
        inst->playing = 1;
        if (whole) {
            inst->play_pos = 0;
        } else {
            inst->play_pos = inst->start_sample;
        }
        {
            char dbg[256];
            snprintf(dbg, sizeof(dbg), "PLAY: whole=%d start=%d end=%d pos=%d total=%d",
                     whole, inst->start_sample, inst->end_sample,
                     inst->play_pos, inst->audio_frames);
            plugin_log(dbg);
        }
        return;
    }

    if (strcmp(key, "play_from") == 0) {
        /* Start playback from an arbitrary frame position to end_sample.
         * Used for previewing near the end marker without moving markers. */
        if (!inst->audio_data || inst->audio_frames <= 0) return;
        if (!val) return;
        int pos = atoi(val);
        if (pos < 0) pos = 0;
        if (pos >= inst->audio_frames) pos = inst->audio_frames - 1;
        inst->play_whole = 0;
        inst->playing = 1;
        inst->play_pos = pos;
        return;
    }

    if (strcmp(key, "stop") == 0) {
        inst->playing = 0;
        return;
    }

    if (strcmp(key, "play_loop") == 0) {
        if (!val) return;
        inst->play_loop = atoi(val) ? 1 : 0;
        return;
    }

    if (strcmp(key, "play_whole") == 0) {
        if (!val) return;
        inst->play_whole = atoi(val) ? 1 : 0;
        return;
    }

    /* --- Find zero crossing (S1000-style FIND) --- */
    /* Uses L channel for zero crossing detection */
    if (strcmp(key, "find_zero_crossing") == 0) {
        if (!inst->audio_data || inst->audio_frames <= 2) return;

        int end_pos = inst->end_sample;
        int start_pos = inst->start_sample;

        /* Reference: amplitude and slope at loop end point (L channel) */
        if (end_pos < 1) end_pos = 1;
        if (end_pos > inst->audio_frames) end_pos = inst->audio_frames;
        int ref_idx = end_pos - 1;
        if (ref_idx < 1) ref_idx = 1;
        int ref_amp = (int)inst->audio_data[ref_idx * 2];
        int ref_slope = (int)inst->audio_data[ref_idx * 2] - (int)inst->audio_data[(ref_idx - 1) * 2];

        /* Search ±2048 samples around current start */
        int search_radius = 2048;
        int search_lo = start_pos - search_radius;
        int search_hi = start_pos + search_radius;
        if (search_lo < 1) search_lo = 1;
        if (search_hi >= inst->audio_frames) search_hi = inst->audio_frames - 1;

        int best_pos = start_pos;
        int best_score = 0x7FFFFFFF;

        for (int i = search_lo; i <= search_hi; i++) {
            int amp = (int)inst->audio_data[i * 2];
            int slope = (int)inst->audio_data[i * 2] - (int)inst->audio_data[(i - 1) * 2];
            int amp_err = abs(amp - ref_amp);
            int slope_err = abs(slope - ref_slope);
            int score = amp_err * 2 + slope_err;
            if (score < best_score) {
                best_score = score;
                best_pos = i;
            }
        }

        inst->start_sample = best_pos;

        {
            char log_buf[128];
            snprintf(log_buf, sizeof(log_buf),
                     "Zero-crossing FIND: %d -> %d (score %d)",
                     start_pos, best_pos, best_score);
            plugin_log(log_buf);
        }
        return;
    }

    /* --- Gain --- */
    if (strcmp(key, "gain_db") == 0) {
        if (!val) return;
        inst->gain_db = (float)atof(val);
        /* Clamp to reasonable range */
        if (inst->gain_db < -60.0f) inst->gain_db = -60.0f;
        if (inst->gain_db > 24.0f) inst->gain_db = 24.0f;
        return;
    }

    /* --- Editing operations --- */

    if (strcmp(key, "trim") == 0) {
        if (!inst->audio_data || inst->audio_frames <= 0) return;

        int start = inst->start_sample;
        int end = inst->end_sample;

        /* Validate selection */
        if (start < 0) start = 0;
        if (end > inst->audio_frames) end = inst->audio_frames;
        if (start >= end) {
            plugin_log("Trim: invalid selection (start >= end)");
            return;
        }

        int new_frames = end - start;
        if (new_frames <= 0) return;

        /* Save to undo */
        save_undo(inst);

        /* Extract the selected region */
        size_t buf_size = (size_t)new_frames * SAMPLES_PER_FRAME * sizeof(int16_t);
        int16_t *new_data = (int16_t *)malloc(buf_size);
        if (!new_data) {
            plugin_log("Trim: allocation failed");
            return;
        }

        memcpy(new_data, inst->audio_data + start * SAMPLES_PER_FRAME, buf_size);

        /* Replace audio */
        free(inst->audio_data);
        inst->audio_data = new_data;
        inst->audio_frames = new_frames;
        inst->total_frames = new_frames;
        inst->duration_secs = (float)new_frames / (float)inst->sample_rate;

        /* Reset markers */
        inst->start_sample = 0;
        inst->end_sample = new_frames;
        inst->zoom_level = 0;
        inst->zoom_center = new_frames / 2;
        inst->dirty = 1;
        inst->playing = 0;

        /* Recompute */
        compute_waveform(inst, 128);
        inst->peak_db = compute_peak_db(inst->audio_data, inst->audio_frames);

        {
            char log_buf[128];
            snprintf(log_buf, sizeof(log_buf),
                     "Trimmed: %d-%d -> %d frames", start, end, new_frames);
            plugin_log(log_buf);
        }
        return;
    }

    if (strcmp(key, "copy") == 0) {
        /* Copy selection to clipboard (non-destructive) */
        if (!inst->audio_data || inst->audio_frames <= 0) return;

        int start = inst->start_sample;
        int end = inst->end_sample;

        if (start < 0) start = 0;
        if (end > inst->audio_frames) end = inst->audio_frames;
        if (start >= end) {
            plugin_log("Copy: invalid selection");
            return;
        }

        int copy_frames = end - start;

        /* Free old clipboard */
        if (inst->clipboard_data) {
            free(inst->clipboard_data);
            inst->clipboard_data = NULL;
            inst->clipboard_frames = 0;
        }

        size_t buf_size = (size_t)copy_frames * SAMPLES_PER_FRAME * sizeof(int16_t);
        inst->clipboard_data = (int16_t *)malloc(buf_size);
        if (!inst->clipboard_data) {
            plugin_log("Copy: clipboard allocation failed");
            return;
        }

        memcpy(inst->clipboard_data, inst->audio_data + start * SAMPLES_PER_FRAME, buf_size);
        inst->clipboard_frames = copy_frames;

        {
            char log_buf[128];
            snprintf(log_buf, sizeof(log_buf),
                     "Copied %d frames to clipboard", copy_frames);
            plugin_log(log_buf);
        }
        return;
    }

    if (strcmp(key, "export") == 0) {
        /* Export selection to new file */
        if (!inst->audio_data || inst->audio_frames <= 0) return;

        int start = inst->start_sample;
        int end = inst->end_sample;

        if (start < 0) start = 0;
        if (end > inst->audio_frames) end = inst->audio_frames;
        if (start >= end) {
            plugin_log("Export: invalid selection");
            return;
        }

        int copy_frames = end - start;

        /* Generate output filename */
        char out_path[512];
        make_edit_filename(inst->file_path, out_path, (int)sizeof(out_path));

        /* Write the selection as PCM 16-bit (internal format).
         * Always use PCM so exported files are compatible with rex-encode
         * and other tools that may not support IEEE float WAV. */
        if (write_wav(out_path, inst->audio_data + start * SAMPLES_PER_FRAME, copy_frames,
                      inst->sample_rate, 1, 16,
                      inst->orig_channels) == 0) {
            const char *out_name = basename_ptr(out_path);
            strncpy(inst->copy_result, out_name,
                    sizeof(inst->copy_result) - 1);
            inst->copy_result[sizeof(inst->copy_result) - 1] = '\0';
        } else {
            strncpy(inst->copy_result, "ERROR",
                    sizeof(inst->copy_result) - 1);
        }
        return;
    }

    if (strcmp(key, "mute") == 0) {
        /* Mute (zero out) selection */
        if (!inst->audio_data || inst->audio_frames <= 0) return;

        int start = inst->start_sample;
        int end = inst->end_sample;

        if (start < 0) start = 0;
        if (end > inst->audio_frames) end = inst->audio_frames;
        if (start >= end) {
            plugin_log("Mute: invalid selection");
            return;
        }

        save_undo(inst);

        memset(inst->audio_data + start * SAMPLES_PER_FRAME, 0,
               (size_t)(end - start) * SAMPLES_PER_FRAME * sizeof(int16_t));

        inst->dirty = 1;
        compute_waveform(inst, 128);
        inst->peak_db = compute_peak_db(inst->audio_data, inst->audio_frames);

        {
            char log_buf[128];
            snprintf(log_buf, sizeof(log_buf),
                     "Muted %d-%d (%d frames)", start, end, end - start);
            plugin_log(log_buf);
        }
        return;
    }

    if (strcmp(key, "cut") == 0) {
        /* Cut selection to clipboard (copy + remove) */
        if (!inst->audio_data || inst->audio_frames <= 0) return;

        int start = inst->start_sample;
        int end = inst->end_sample;

        if (start < 0) start = 0;
        if (end > inst->audio_frames) end = inst->audio_frames;
        if (start >= end) {
            plugin_log("Cut: invalid selection");
            return;
        }

        int sel_frames = end - start;

        save_undo(inst);

        /* Copy selection to clipboard */
        if (inst->clipboard_data) {
            free(inst->clipboard_data);
            inst->clipboard_data = NULL;
            inst->clipboard_frames = 0;
        }

        size_t clip_size = (size_t)sel_frames * SAMPLES_PER_FRAME * sizeof(int16_t);
        inst->clipboard_data = (int16_t *)malloc(clip_size);
        if (!inst->clipboard_data) {
            plugin_log("Cut: clipboard allocation failed");
            return;
        }

        memcpy(inst->clipboard_data, inst->audio_data + start * SAMPLES_PER_FRAME, clip_size);
        inst->clipboard_frames = sel_frames;

        /* Remove selection from audio_data */
        int new_frames = inst->audio_frames - sel_frames;
        if (new_frames <= 0) {
            /* Cutting everything — leave a tiny silent buffer */
            new_frames = 1;
            int16_t *new_data = (int16_t *)calloc(SAMPLES_PER_FRAME, sizeof(int16_t));
            if (!new_data) {
                plugin_log("Cut: allocation failed");
                return;
            }
            free(inst->audio_data);
            inst->audio_data = new_data;
        } else {
            size_t new_size = (size_t)new_frames * SAMPLES_PER_FRAME * sizeof(int16_t);
            int16_t *new_data = (int16_t *)malloc(new_size);
            if (!new_data) {
                plugin_log("Cut: allocation failed");
                return;
            }

            /* Copy [0..start] + [end..audio_frames] */
            if (start > 0) {
                memcpy(new_data, inst->audio_data,
                       (size_t)start * SAMPLES_PER_FRAME * sizeof(int16_t));
            }
            if (end < inst->audio_frames) {
                memcpy(new_data + start * SAMPLES_PER_FRAME,
                       inst->audio_data + end * SAMPLES_PER_FRAME,
                       (size_t)(inst->audio_frames - end) * SAMPLES_PER_FRAME * sizeof(int16_t));
            }

            free(inst->audio_data);
            inst->audio_data = new_data;
        }

        inst->audio_frames = new_frames;
        inst->total_frames = new_frames;
        inst->duration_secs = (float)new_frames / (float)inst->sample_rate;

        /* Reset markers to cut point */
        inst->start_sample = start;
        if (inst->start_sample > new_frames) inst->start_sample = new_frames;
        inst->end_sample = inst->start_sample;
        inst->zoom_level = 0;
        inst->zoom_center = new_frames / 2;
        inst->dirty = 1;
        inst->playing = 0;

        compute_waveform(inst, 128);
        inst->peak_db = compute_peak_db(inst->audio_data, inst->audio_frames);

        {
            char log_buf[128];
            snprintf(log_buf, sizeof(log_buf),
                     "Cut %d frames to clipboard, %d remain",
                     sel_frames, new_frames);
            plugin_log(log_buf);
        }
        return;
    }

    if (strcmp(key, "paste") == 0) {
        /* Paste clipboard at start_sample (insert, shift right) */
        if (!inst->clipboard_data || inst->clipboard_frames <= 0) {
            plugin_log("Paste: clipboard is empty");
            return;
        }
        if (!inst->audio_data || inst->audio_frames <= 0) return;

        int insert_at = inst->start_sample;
        if (insert_at < 0) insert_at = 0;
        if (insert_at > inst->audio_frames) insert_at = inst->audio_frames;

        int new_frames = inst->audio_frames + inst->clipboard_frames;
        if (new_frames > MAX_AUDIO_FRAMES) {
            plugin_log("Paste: result would exceed max duration");
            return;
        }

        save_undo(inst);

        size_t new_size = (size_t)new_frames * SAMPLES_PER_FRAME * sizeof(int16_t);
        int16_t *new_data = (int16_t *)malloc(new_size);
        if (!new_data) {
            plugin_log("Paste: allocation failed");
            return;
        }

        /* Copy [0..insert_at] + clipboard + [insert_at..audio_frames] */
        if (insert_at > 0) {
            memcpy(new_data, inst->audio_data,
                   (size_t)insert_at * SAMPLES_PER_FRAME * sizeof(int16_t));
        }
        memcpy(new_data + insert_at * SAMPLES_PER_FRAME, inst->clipboard_data,
               (size_t)inst->clipboard_frames * SAMPLES_PER_FRAME * sizeof(int16_t));
        if (insert_at < inst->audio_frames) {
            memcpy(new_data + (insert_at + inst->clipboard_frames) * SAMPLES_PER_FRAME,
                   inst->audio_data + insert_at * SAMPLES_PER_FRAME,
                   (size_t)(inst->audio_frames - insert_at) * SAMPLES_PER_FRAME * sizeof(int16_t));
        }

        free(inst->audio_data);
        inst->audio_data = new_data;
        inst->audio_frames = new_frames;
        inst->total_frames = new_frames;
        inst->duration_secs = (float)new_frames / (float)inst->sample_rate;

        /* Select the pasted region */
        inst->start_sample = insert_at;
        inst->end_sample = insert_at + inst->clipboard_frames;
        inst->dirty = 1;
        inst->playing = 0;

        compute_waveform(inst, 128);
        inst->peak_db = compute_peak_db(inst->audio_data, inst->audio_frames);

        {
            char log_buf[128];
            snprintf(log_buf, sizeof(log_buf),
                     "Pasted %d frames at %d, total now %d",
                     inst->clipboard_frames, insert_at, new_frames);
            plugin_log(log_buf);
        }
        return;
    }

    if (strcmp(key, "apply_gain") == 0) {
        if (!inst->audio_data || inst->audio_frames <= 0) return;

        save_undo(inst);

        /* Convert dB to linear gain */
        float linear_gain = powf(10.0f, inst->gain_db / 20.0f);
        int total_samples = inst->audio_frames * SAMPLES_PER_FRAME;

        for (int i = 0; i < total_samples; i++) {
            float s = (float)inst->audio_data[i] * linear_gain;
            /* Clamp to int16 range */
            if (s > 32767.0f) s = 32767.0f;
            if (s < -32768.0f) s = -32768.0f;
            inst->audio_data[i] = (int16_t)s;
        }

        inst->dirty = 1;
        inst->peak_db = compute_peak_db(inst->audio_data, inst->audio_frames);
        compute_waveform(inst, 128);

        {
            char log_buf[128];
            snprintf(log_buf, sizeof(log_buf),
                     "Applied gain: %.1f dB (linear %.4f)",
                     inst->gain_db, linear_gain);
            plugin_log(log_buf);
        }
        return;
    }

    if (strcmp(key, "normalize") == 0) {
        if (!inst->audio_data || inst->audio_frames <= 0) return;

        save_undo(inst);

        /* Find current peak */
        float current_peak_db = compute_peak_db(inst->audio_data,
                                                inst->audio_frames);
        if (current_peak_db <= -96.0f) {
            plugin_log("Normalize: file is silent");
            return;
        }

        /* Calculate gain needed to reach target */
        float gain_needed_db = NORMALIZE_TARGET_DB - current_peak_db;
        float linear_gain = powf(10.0f, gain_needed_db / 20.0f);
        int total_samples = inst->audio_frames * SAMPLES_PER_FRAME;

        for (int i = 0; i < total_samples; i++) {
            float s = (float)inst->audio_data[i] * linear_gain;
            if (s > 32767.0f) s = 32767.0f;
            if (s < -32768.0f) s = -32768.0f;
            inst->audio_data[i] = (int16_t)s;
        }

        inst->dirty = 1;
        inst->peak_db = compute_peak_db(inst->audio_data, inst->audio_frames);
        compute_waveform(inst, 128);

        {
            char log_buf[128];
            snprintf(log_buf, sizeof(log_buf),
                     "Normalized: applied %.1f dB, peak now %.1f dB",
                     gain_needed_db, inst->peak_db);
            plugin_log(log_buf);
        }
        return;
    }

    if (strcmp(key, "normalize_selection") == 0) {
        /* Normalize only the selected region [start_sample, end_sample] */
        int start = inst->start_sample;
        int end   = inst->end_sample;
        if (start < 0) start = 0;
        if (end > inst->audio_frames) end = inst->audio_frames;
        if (start >= end) { plugin_log("NormSel: empty selection"); return; }
        if (!inst->audio_data) return;

        save_undo(inst);

        float sel_peak = compute_peak_db(inst->audio_data + start * SAMPLES_PER_FRAME,
                                         end - start);
        if (sel_peak <= -96.0f) { plugin_log("NormSel: selection silent"); return; }

        float gain_db  = NORMALIZE_TARGET_DB - sel_peak;
        float lin_gain = powf(10.0f, gain_db / 20.0f);
        int   n_samp   = (end - start) * SAMPLES_PER_FRAME;
        int16_t *ptr   = inst->audio_data + start * SAMPLES_PER_FRAME;
        for (int i = 0; i < n_samp; i++) {
            float s = (float)ptr[i] * lin_gain;
            if (s >  32767.0f) s =  32767.0f;
            if (s < -32768.0f) s = -32768.0f;
            ptr[i] = (int16_t)s;
        }
        inst->dirty   = 1;
        inst->peak_db = compute_peak_db(inst->audio_data, inst->audio_frames);
        compute_waveform(inst, 128);
        {
            char log_buf[128];
            snprintf(log_buf, sizeof(log_buf),
                     "NormSel: applied %.1f dB to frames %d-%d", gain_db, start, end);
            plugin_log(log_buf);
        }
        return;
    }

    if (strcmp(key, "paste_overwrite") == 0) {
        /* Paste clipboard at start_sample, overwriting (file length unchanged) */
        if (!inst->clipboard_data || inst->clipboard_frames <= 0) {
            plugin_log("PasteOW: clipboard empty"); return; }
        if (!inst->audio_data || inst->audio_frames <= 0) return;

        int insert_at = inst->start_sample;
        if (insert_at < 0) insert_at = 0;
        if (insert_at >= inst->audio_frames) {
            plugin_log("PasteOW: cursor at/past EOF"); return; }

        int frames_to_write = inst->clipboard_frames;
        if (insert_at + frames_to_write > inst->audio_frames)
            frames_to_write = inst->audio_frames - insert_at;

        save_undo(inst);

        memcpy(inst->audio_data + insert_at * SAMPLES_PER_FRAME,
               inst->clipboard_data,
               (size_t)frames_to_write * SAMPLES_PER_FRAME * sizeof(int16_t));

        inst->start_sample = insert_at;
        inst->end_sample   = insert_at + frames_to_write;
        inst->dirty   = 1;
        inst->playing = 0;
        compute_waveform(inst, 128);
        inst->peak_db = compute_peak_db(inst->audio_data, inst->audio_frames);
        {
            char log_buf[128];
            snprintf(log_buf, sizeof(log_buf),
                     "PasteOW: wrote %d frames at %d", frames_to_write, insert_at);
            plugin_log(log_buf);
        }
        return;
    }

    if (strcmp(key, "undo") == 0) {
        if (!inst->has_undo || !inst->undo_buffer) {
            plugin_log("Undo: nothing to undo");
            return;
        }

        /* Swap audio_data and undo_buffer */
        int16_t *tmp_data = inst->audio_data;
        int tmp_frames = inst->audio_frames;

        inst->audio_data = inst->undo_buffer;
        inst->audio_frames = inst->undo_frames;
        inst->total_frames = inst->undo_frames;
        inst->duration_secs = (float)inst->undo_frames /
                              (float)inst->sample_rate;

        inst->undo_buffer = tmp_data;
        inst->undo_frames = tmp_frames;
        inst->has_undo = 0; /* Only one level of undo */

        /* Reset markers */
        inst->start_sample = 0;
        inst->end_sample = inst->audio_frames;
        inst->zoom_level = 0;
        inst->zoom_center = inst->audio_frames / 2;
        inst->playing = 0;

        /* Recompute */
        compute_waveform(inst, 128);
        inst->peak_db = compute_peak_db(inst->audio_data, inst->audio_frames);

        plugin_log("Undo applied");
        return;
    }

    if (strcmp(key, "save") == 0) {
        if (!inst->audio_data || inst->audio_frames <= 0) {
            plugin_log("Save: no audio data");
            return;
        }
        if (inst->file_path[0] == '\0') {
            plugin_log("Save: no file path");
            return;
        }

        if (write_wav(inst->file_path, inst->audio_data, inst->audio_frames,
                      inst->sample_rate, inst->orig_format, inst->orig_bits,
                      inst->orig_channels) == 0) {
            inst->dirty = 0;
            plugin_log("File saved");
        } else {
            plugin_log("Save failed");
        }
        return;
    }

    if (strcmp(key, "save_as") == 0) {
        /* Save full audio to a specified path in original format */
        if (!inst->audio_data || inst->audio_frames <= 0 || !val || val[0] == '\0') {
            plugin_log("save_as: no audio or no path");
            return;
        }
        if (write_wav(val, inst->audio_data, inst->audio_frames,
                      inst->sample_rate, inst->orig_format, inst->orig_bits,
                      inst->orig_channels) == 0) {
            char log_buf[256];
            snprintf(log_buf, sizeof(log_buf), "Saved copy to: %s", val);
            plugin_log(log_buf);
        } else {
            plugin_log("save_as failed");
        }
        return;
    }

    if (strcmp(key, "dirty") == 0) {
        inst->dirty = (val && val[0] == '1') ? 1 : 0;
        return;
    }

    if (strcmp(key, "slice_state") == 0) {
        /* Store UI slice state JSON for reconnect persistence */
        if (val) {
            strncpy(inst->slice_state, val, sizeof(inst->slice_state) - 1);
            inst->slice_state[sizeof(inst->slice_state) - 1] = '\0';
        } else {
            inst->slice_state[0] = '\0';
        }
        return;
    }

    {
        char log_buf[256];
        snprintf(log_buf, sizeof(log_buf),
                 "Unknown param key: %s", key);
        plugin_log(log_buf);
    }
}

/* ---- get_param ---- */

static int v2_get_param(void *instance, const char *key, char *buf,
                        int buf_len) {
    if (!instance || !key || !buf || buf_len <= 0) return -1;
    instance_t *inst = (instance_t *)instance;

    /* --- File info --- */
    if (strcmp(key, "file_info") == 0) {
        if (!inst->audio_data || inst->audio_frames <= 0) {
            int n = snprintf(buf, (size_t)buf_len,
                             "{\"name\":\"\",\"duration\":0,"
                             "\"frames\":0,\"start\":0,\"end\":0}");
            return (n >= 0 && n < buf_len) ? n : -1;
        }
        char escaped_name[256];
        json_escape(escaped_name, sizeof(escaped_name), inst->file_name);
        int n = snprintf(buf, (size_t)buf_len,
                         "{\"name\":\"%s\",\"duration\":%.2f,"
                         "\"frames\":%d,\"start\":%d,\"end\":%d}",
                         escaped_name,
                         inst->duration_secs,
                         inst->audio_frames,
                         inst->start_sample,
                         inst->end_sample);
        return (n >= 0 && n < buf_len) ? n : -1;
    }

    /* --- Waveform data --- */
    if (strncmp(key, "waveform", 8) == 0) {
        int vis_start = -1, vis_end = -1;
        if (key[8] == ':') {
            sscanf(key + 9, "%d,%d", &vis_start, &vis_end);
        }
        if (vis_start >= 0 && vis_end > vis_start) {
            compute_waveform_range(inst, 128, vis_start, vis_end);
        } else {
            compute_waveform(inst, 128);
        }

        if (inst->waveform_cols <= 0 || !inst->audio_data) {
            int n = snprintf(buf, (size_t)buf_len, "[]");
            return (n >= 0 && n < buf_len) ? n : -1;
        }

        /* Build JSON array: [[min,max],[min,max],...] */
        int pos = 0;
        int remaining = buf_len - 1;

        if (remaining < 1) return -1;
        buf[pos++] = '[';
        remaining--;

        for (int i = 0; i < inst->waveform_cols; i++) {
            float mn = (float)inst->waveform_min[i] / 32768.0f;
            float mx = (float)inst->waveform_max[i] / 32768.0f;

            /* Clamp to -1..1 */
            if (mn < -1.0f) mn = -1.0f;
            if (mn > 1.0f) mn = 1.0f;
            if (mx < -1.0f) mx = -1.0f;
            if (mx > 1.0f) mx = 1.0f;

            int n = snprintf(buf + pos, (size_t)remaining,
                             "%s[%.4f,%.4f]",
                             (i > 0) ? "," : "",
                             mn, mx);
            if (n < 0 || n >= remaining) {
                /* Buffer full - truncate gracefully */
                buf[pos] = ']';
                buf[pos + 1] = '\0';
                return pos + 1;
            }
            pos += n;
            remaining -= n;
        }

        if (remaining >= 1) {
            buf[pos++] = ']';
        }
        buf[pos] = '\0';
        return pos;
    }

    /* --- Seam waveform (loop junction view) --- */
    if (strncmp(key, "seam_waveform:", 14) == 0) {
        int sw_start = 0, sw_end = 0, half_samples = 0;
        if (sscanf(key + 14, "%d,%d,%d", &sw_start, &sw_end, &half_samples) != 3
            || half_samples <= 0) {
            int n = snprintf(buf, (size_t)buf_len, "[]");
            return (n >= 0 && n < buf_len) ? n : -1;
        }
        if (!inst->audio_data || inst->audio_frames <= 0) {
            int n = snprintf(buf, (size_t)buf_len, "[]");
            return (n >= 0 && n < buf_len) ? n : -1;
        }

        /* Clamp */
        if (sw_start < 0) sw_start = 0;
        if (sw_end > inst->audio_frames) sw_end = inst->audio_frames;
        if (sw_start > inst->audio_frames) sw_start = inst->audio_frames;
        if (sw_end < 0) sw_end = 0;

        /* First half: approaching loop end (end - half_samples .. end) */
        int left_start = sw_end - half_samples;
        if (left_start < 0) left_start = 0;
        int left_end = sw_end;
        if (left_end > inst->audio_frames) left_end = inst->audio_frames;

        compute_waveform_range(inst, 64, left_start, left_end);

        /* Save first-half results to stack before second call overwrites */
        int16_t seam_min[128], seam_max[128];
        for (int i = 0; i < 64; i++) {
            seam_min[i] = (i < inst->waveform_cols) ? inst->waveform_min[i] : 0;
            seam_max[i] = (i < inst->waveform_cols) ? inst->waveform_max[i] : 0;
        }

        /* Second half: continuing from loop start (start .. start + half_samples) */
        int right_start = sw_start;
        int right_end = sw_start + half_samples;
        if (right_end > inst->audio_frames) right_end = inst->audio_frames;

        compute_waveform_range(inst, 64, right_start, right_end);

        for (int i = 0; i < 64; i++) {
            seam_min[64 + i] = (i < inst->waveform_cols) ? inst->waveform_min[i] : 0;
            seam_max[64 + i] = (i < inst->waveform_cols) ? inst->waveform_max[i] : 0;
        }

        /* Build JSON array: [[min,max],[min,max],...] — 128 pairs */
        int pos = 0;
        int remaining = buf_len - 1;
        if (remaining < 1) return -1;
        buf[pos++] = '[';
        remaining--;

        for (int i = 0; i < 128; i++) {
            float mn = (float)seam_min[i] / 32768.0f;
            float mx = (float)seam_max[i] / 32768.0f;
            if (mn < -1.0f) mn = -1.0f;
            if (mn > 1.0f) mn = 1.0f;
            if (mx < -1.0f) mx = -1.0f;
            if (mx > 1.0f) mx = 1.0f;

            int n = snprintf(buf + pos, (size_t)remaining,
                             "%s[%.4f,%.4f]",
                             (i > 0) ? "," : "",
                             mn, mx);
            if (n < 0 || n >= remaining) {
                buf[pos] = ']';
                buf[pos + 1] = '\0';
                return pos + 1;
            }
            pos += n;
            remaining -= n;
        }

        if (remaining >= 1) {
            buf[pos++] = ']';
        }
        buf[pos] = '\0';
        return pos;
    }

    /* --- Integer params as string --- */
    if (strcmp(key, "start_sample") == 0) {
        int n = snprintf(buf, (size_t)buf_len, "%d", inst->start_sample);
        return (n >= 0 && n < buf_len) ? n : -1;
    }

    if (strcmp(key, "end_sample") == 0) {
        int n = snprintf(buf, (size_t)buf_len, "%d", inst->end_sample);
        return (n >= 0 && n < buf_len) ? n : -1;
    }

    if (strcmp(key, "play_pos") == 0) {
        int n = snprintf(buf, (size_t)buf_len, "%d", inst->play_pos);
        return (n >= 0 && n < buf_len) ? n : -1;
    }

    if (strcmp(key, "playing") == 0) {
        int n = snprintf(buf, (size_t)buf_len, "%d", inst->playing ? 1 : 0);
        return (n >= 0 && n < buf_len) ? n : -1;
    }

    if (strcmp(key, "has_undo") == 0) {
        int n = snprintf(buf, (size_t)buf_len, "%d", inst->has_undo ? 1 : 0);
        return (n >= 0 && n < buf_len) ? n : -1;
    }

    if (strcmp(key, "has_clipboard") == 0) {
        int n = snprintf(buf, (size_t)buf_len, "%d",
                         (inst->clipboard_data && inst->clipboard_frames > 0) ? 1 : 0);
        return (n >= 0 && n < buf_len) ? n : -1;
    }

    if (strcmp(key, "dirty") == 0) {
        int n = snprintf(buf, (size_t)buf_len, "%d", inst->dirty ? 1 : 0);
        return (n >= 0 && n < buf_len) ? n : -1;
    }

    if (strcmp(key, "slice_state") == 0) {
        int n = snprintf(buf, (size_t)buf_len, "%s", inst->slice_state);
        return (n >= 0 && n < buf_len) ? n : -1;
    }

    if (strcmp(key, "peak_db") == 0) {
        int n = snprintf(buf, (size_t)buf_len, "%.1f", inst->peak_db);
        return (n >= 0 && n < buf_len) ? n : -1;
    }

    if (strcmp(key, "gain_db") == 0) {
        int n = snprintf(buf, (size_t)buf_len, "%.1f", inst->gain_db);
        return (n >= 0 && n < buf_len) ? n : -1;
    }

    if (strcmp(key, "play_loop") == 0) {
        int n = snprintf(buf, (size_t)buf_len, "%d", inst->play_loop ? 1 : 0);
        return (n >= 0 && n < buf_len) ? n : -1;
    }

    if (strcmp(key, "play_whole") == 0) {
        int n = snprintf(buf, (size_t)buf_len, "%d",
                         inst->play_whole ? 1 : 0);
        return (n >= 0 && n < buf_len) ? n : -1;
    }

    if (strcmp(key, "copy_result") == 0) {
        int n = snprintf(buf, (size_t)buf_len, "%s", inst->copy_result);
        return (n >= 0 && n < buf_len) ? n : -1;
    }

    if (strcmp(key, "mode") == 0) {
        int n = snprintf(buf, (size_t)buf_len, "%d", inst->mode);
        return (n >= 0 && n < buf_len) ? n : -1;
    }

    if (strcmp(key, "audio_frames") == 0) {
        int n = snprintf(buf, (size_t)buf_len, "%d", inst->audio_frames);
        return (n >= 0 && n < buf_len) ? n : -1;
    }

    if (strcmp(key, "zoom_level") == 0) {
        int n = snprintf(buf, (size_t)buf_len, "%d", inst->zoom_level);
        return (n >= 0 && n < buf_len) ? n : -1;
    }

    if (strcmp(key, "zoom_center") == 0) {
        int n = snprintf(buf, (size_t)buf_len, "%d", inst->zoom_center);
        return (n >= 0 && n < buf_len) ? n : -1;
    }

    if (strcmp(key, "sample_rate") == 0) {
        int n = snprintf(buf, (size_t)buf_len, "%d", inst->sample_rate);
        return (n >= 0 && n < buf_len) ? n : -1;
    }

    return -1; /* Unknown parameter */
}

/* ---- get_error ---- */

static int v2_get_error(void *instance, char *buf, int buf_len) {
    if (!instance || !buf || buf_len <= 0) return 0;
    instance_t *inst = (instance_t *)instance;

    if (inst->load_error[0] == '\0') return 0;

    int n = snprintf(buf, (size_t)buf_len, "%s", inst->load_error);
    return (n >= 0 && n < buf_len) ? n : 0;
}

/* ---- render_block ---- */

static void v2_render_block(void *instance, int16_t *out_interleaved_lr,
                            int frames) {
    if (!instance || !out_interleaved_lr) return;
    instance_t *inst = (instance_t *)instance;

    /* Output silence if not playing or no audio loaded */
    if (!inst->playing || !inst->audio_data || inst->audio_frames <= 0) {
        memset(out_interleaved_lr, 0,
               (size_t)frames * 2 * sizeof(int16_t));
        return;
    }

    /* Determine playback boundaries */
    int play_start, play_end;
    if (inst->play_whole) {
        play_start = 0;
        play_end = inst->audio_frames;
    } else {
        play_start = inst->start_sample;
        play_end = inst->end_sample;
        /* Clamp to valid range */
        if (play_start < 0) play_start = 0;
        if (play_end > inst->audio_frames) play_end = inst->audio_frames;
        if (play_start >= play_end) {
            /* Zero-length selection: output silence but stay "playing"
             * so expanding markers while holding a pad resumes audio */
            memset(out_interleaved_lr, 0,
                   (size_t)frames * 2 * sizeof(int16_t));
            return;
        }
    }

    /* Precompute gain for preview */
    float linear_gain = 1.0f;
    if (inst->gain_db != 0.0f) {
        linear_gain = powf(10.0f, inst->gain_db / 20.0f);
    }

    for (int i = 0; i < frames; i++) {
        if (!inst->playing) {
            /* Stopped mid-block: fill rest with silence */
            out_interleaved_lr[i * 2]     = 0;
            out_interleaved_lr[i * 2 + 1] = 0;
            continue;
        }

        if (inst->play_pos >= play_end) {
            if (inst->play_loop) {
                inst->play_pos = play_start;
            } else {
                inst->playing = 0;
                out_interleaved_lr[i * 2]     = 0;
                out_interleaved_lr[i * 2 + 1] = 0;
                continue;
            }
        }

        int16_t sample_l = inst->audio_data[inst->play_pos * 2];
        int16_t sample_r = inst->audio_data[inst->play_pos * 2 + 1];
        inst->play_pos++;

        /* Apply gain preview */
        if (linear_gain != 1.0f) {
            float sl = (float)sample_l * linear_gain;
            float sr = (float)sample_r * linear_gain;
            if (sl > 32767.0f) sl = 32767.0f;
            if (sl < -32768.0f) sl = -32768.0f;
            if (sr > 32767.0f) sr = 32767.0f;
            if (sr < -32768.0f) sr = -32768.0f;
            sample_l = (int16_t)sl;
            sample_r = (int16_t)sr;
        }

        out_interleaved_lr[i * 2]     = sample_l;
        out_interleaved_lr[i * 2 + 1] = sample_r;
    }
}

/* ============================================================================
 * V2 API registration
 * ============================================================================ */

static plugin_api_v2_t s_plugin_api = {
    .api_version = MOVE_PLUGIN_API_VERSION_2,
    .create_instance = v2_create,
    .destroy_instance = v2_destroy,
    .on_midi = v2_on_midi,
    .set_param = v2_set_param,
    .get_param = v2_get_param,
    .get_error = v2_get_error,
    .render_block = v2_render_block,
};

__attribute__((visibility("default")))
void *move_plugin_init_v2(const host_api_v1_t *host_api) {
    if (!host_api) return NULL;
    g_host = host_api;
    plugin_log("Plugin initialized (V2 stereo)");
    return &s_plugin_api;
}
