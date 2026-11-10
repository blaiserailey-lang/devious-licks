/*
 * Devious Licks Player: a small native libretro frontend.
 *
 * The Electron app launches this for consoles that are too heavy for the
 * WebAssembly emulator (N64). It loads a libretro core (a .dylib bundled in
 * the app), opens a window with SDL2 + OpenGL, and handles video, audio,
 * keyboard/gamepad input, battery saves and save states.
 *
 * Usage:
 *   dl-player --core <core.dylib> --rom <file> [--title <name>]
 *             [--save-dir <dir>] [--system-dir <dir>] [--fullscreen]
 *             [--option <key>=<value>]...   core option overrides
 *             [--icon <image>]              Dock icon (macOS)
 *             [--no-dialog]                 report errors on stderr only
 *             [--verbose]                   include the core's debug log
 *   Self-test (used by CI): [--frames <n>] [--expect <tl|tr|bl|br|c>=<rrggbb>]...
 *             [--expect-tone <hz>]          the sound has to be a tone of that pitch
 *             [--peek <hex address>[:<words>]]...  print the console's memory
 *             [--gl-trace <frames>]         record the core's OpenGL calls
 *             [--gl-probe]                  ...and what each framebuffer then shows
 *   dl-player --check --core <core.dylib>   load the core, print what it is, exit
 *
 * Exit codes: 0 fine, 1 error, 2 bad usage, 3 self-test mismatch,
 * 4 this machine can't open a window with OpenGL 3.3.
 *
 * Keys: arrows = analog stick, X = A, C = B, Z = Z trigger, Q/E = L/R,
 * Enter = Start, I/J/K/L = C buttons, W/A/S/D = D-pad,
 * Cmd+S (or F5) = save state, Cmd+L (or F9) = load state,
 * Cmd+F (or F11) = fullscreen, Cmd+R = reset, Cmd+Q / Cmd+W = quit,
 * F8 = record one more frame (when started with --gl-trace),
 * Esc = leave fullscreen (or quit when windowed).
 * (On a Mac only Cmd makes a shortcut: Ctrl sits next to the game keys.)
 * Game controllers: the first one plays as player 1 (with the keyboard),
 * the next ones as players 2 to 4. Bottom button = A, left button = B,
 * either trigger = Z, shoulders = L/R, right stick = C buttons.
 */
#include <SDL.h>
#include <dlfcn.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifdef __APPLE__
#include <SDL_syswm.h>
#include <objc/message.h>
#include <objc/runtime.h>
#endif

#include "libretro.h"

#ifndef APIENTRY
#define APIENTRY
#endif

/* ---------- OpenGL (loaded at runtime so no GL headers are needed) ---------- */
typedef unsigned int GLenum;
typedef unsigned int GLuint;
typedef int GLint;
typedef int GLsizei;
typedef unsigned int GLbitfield;
typedef float GLfloat;
typedef unsigned char GLboolean;
typedef char GLchar;

#define GL_TEXTURE_2D 0x0DE1
#define GL_RGBA 0x1908
#define GL_RGB 0x1907
#define GL_BGRA 0x80E1
#define GL_RGBA8 0x8058
#define GL_UNSIGNED_BYTE 0x1401
#define GL_UNSIGNED_INT_8_8_8_8_REV 0x8367
#define GL_UNSIGNED_SHORT_5_6_5 0x8363
#define GL_UNSIGNED_SHORT_1_5_5_5_REV 0x8366
#define GL_TEXTURE_MIN_FILTER 0x2801
#define GL_TEXTURE_MAG_FILTER 0x2800
#define GL_NEAREST 0x2600
#define GL_LINEAR 0x2601
#define GL_FRAMEBUFFER 0x8D40
#define GL_READ_FRAMEBUFFER 0x8CA8
#define GL_DRAW_FRAMEBUFFER 0x8CA9
#define GL_RENDERBUFFER 0x8D41
#define GL_COLOR_ATTACHMENT0 0x8CE0
#define GL_DEPTH_ATTACHMENT 0x8D00
#define GL_DEPTH_STENCIL_ATTACHMENT 0x821A
#define GL_DEPTH24_STENCIL8 0x88F0
#define GL_DEPTH_COMPONENT24 0x81A6
#define GL_COLOR_BUFFER_BIT 0x00004000
#define GL_FRAMEBUFFER_COMPLETE 0x8CD5
#define GL_UNPACK_ROW_LENGTH 0x0CF2
#define GL_PACK_ALIGNMENT 0x0D05
#define GL_UNPACK_ALIGNMENT 0x0CF5
#define GL_SCISSOR_TEST 0x0C11
#define GL_BACK 0x0405
#define GL_COMPILE_STATUS 0x8B81
#define GL_LINK_STATUS 0x8B82
#define GL_SHADER_SOURCE_LENGTH 0x8B88
#define GL_VENDOR 0x1F00
#define GL_RENDERER 0x1F01
#define GL_VERSION 0x1F02

#define GLFN(ret, name, args) typedef ret(APIENTRY *PFN_##name) args; static PFN_##name name##_;
GLFN(void, glGenFramebuffers, (GLsizei, GLuint *))
GLFN(void, glDeleteFramebuffers, (GLsizei, const GLuint *))
GLFN(void, glBindFramebuffer, (GLenum, GLuint))
GLFN(void, glFramebufferTexture2D, (GLenum, GLenum, GLenum, GLuint, GLint))
GLFN(void, glGenRenderbuffers, (GLsizei, GLuint *))
GLFN(void, glDeleteRenderbuffers, (GLsizei, const GLuint *))
GLFN(void, glBindRenderbuffer, (GLenum, GLuint))
GLFN(void, glRenderbufferStorage, (GLenum, GLenum, GLsizei, GLsizei))
GLFN(void, glFramebufferRenderbuffer, (GLenum, GLenum, GLenum, GLuint))
GLFN(GLenum, glCheckFramebufferStatus, (GLenum))
GLFN(void, glBlitFramebuffer, (GLint, GLint, GLint, GLint, GLint, GLint, GLint, GLint, GLbitfield, GLenum))
GLFN(void, glGenTextures, (GLsizei, GLuint *))
GLFN(void, glDeleteTextures, (GLsizei, const GLuint *))
GLFN(void, glBindTexture, (GLenum, GLuint))
GLFN(void, glTexImage2D, (GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, const void *))
GLFN(void, glTexSubImage2D, (GLenum, GLint, GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, const void *))
GLFN(void, glTexParameteri, (GLenum, GLenum, GLint))
GLFN(void, glPixelStorei, (GLenum, GLint))
GLFN(void, glViewport, (GLint, GLint, GLsizei, GLsizei))
GLFN(void, glClearColor, (GLfloat, GLfloat, GLfloat, GLfloat))
GLFN(void, glClear, (GLbitfield))
GLFN(void, glDisable, (GLenum))
GLFN(void, glColorMask, (GLboolean, GLboolean, GLboolean, GLboolean))
GLFN(void, glReadBuffer, (GLenum))
GLFN(void, glReadPixels, (GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, void *))
GLFN(const unsigned char *, glGetString, (GLenum))
GLFN(GLenum, glGetError, (void))

static bool load_gl(void) {
#define LOAD(name) if (!(name##_ = (PFN_##name)SDL_GL_GetProcAddress(#name))) { fprintf(stderr, "[player] missing GL function %s\n", #name); return false; }
  LOAD(glGenFramebuffers) LOAD(glDeleteFramebuffers) LOAD(glBindFramebuffer) LOAD(glFramebufferTexture2D)
  LOAD(glGenRenderbuffers) LOAD(glDeleteRenderbuffers) LOAD(glBindRenderbuffer) LOAD(glRenderbufferStorage)
  LOAD(glFramebufferRenderbuffer) LOAD(glCheckFramebufferStatus) LOAD(glBlitFramebuffer)
  LOAD(glGenTextures) LOAD(glDeleteTextures) LOAD(glBindTexture) LOAD(glTexImage2D) LOAD(glTexSubImage2D)
  LOAD(glTexParameteri) LOAD(glPixelStorei) LOAD(glViewport) LOAD(glClearColor) LOAD(glClear)
  LOAD(glDisable) LOAD(glColorMask) LOAD(glReadBuffer) LOAD(glReadPixels) LOAD(glGetString) LOAD(glGetError)
#undef LOAD
  return true;
}

/* ---------- core symbols ---------- */
static struct {
  void *handle;
  void (*init)(void);
  void (*deinit)(void);
  void (*get_system_info)(struct retro_system_info *);
  void (*get_system_av_info)(struct retro_system_av_info *);
  void (*set_environment)(retro_environment_t);
  void (*set_video_refresh)(retro_video_refresh_t);
  void (*set_audio_sample)(retro_audio_sample_t);
  void (*set_audio_sample_batch)(retro_audio_sample_batch_t);
  void (*set_input_poll)(retro_input_poll_t);
  void (*set_input_state)(retro_input_state_t);
  void (*set_controller_port_device)(unsigned, unsigned);
  void (*run)(void);
  void (*reset)(void);
  bool (*load_game)(const struct retro_game_info *);
  void (*unload_game)(void);
  size_t (*serialize_size)(void);
  bool (*serialize)(void *, size_t);
  bool (*unserialize)(const void *, size_t);
  void *(*get_memory_data)(unsigned);
  size_t (*get_memory_size)(unsigned);
} core;

/* ---------- state ---------- */
#define MAX_PADS 4
static SDL_Window *window;
static SDL_GLContext glctx;
static SDL_AudioDeviceID audio_dev;
static SDL_GameController *pads[MAX_PADS];
static struct retro_hw_render_callback hw;
static bool use_hw;
static enum retro_pixel_format pixel_format = RETRO_PIXEL_FORMAT_0RGB1555;
static struct retro_system_av_info av;
static GLuint fbo, fbo_tex, fbo_depth;
static GLuint sw_tex, sw_fbo;
static unsigned fb_w, fb_h;                /* size of the last frame */
static unsigned tex_w, tex_h;              /* allocated FBO / texture size */
static unsigned want_w, want_h;            /* bigger FBO the core asked for mid-run */
static int view_x, view_y, view_w, view_h; /* where the picture sits in the window */
static float aspect = 4.0f / 3.0f;
static bool frame_ready;
static bool running = true;
static bool no_dialog;
static int log_level = RETRO_LOG_INFO;
static volatile sig_atomic_t exit_code;
static char save_dir[1024] = ".";
static char system_dir[1024] = ".";
static char sram_path[2048];
static char state_path[2048];
static char rom_base[512] = "game";

/* self-test bookkeeping (--frames) */
static long test_frames;
static struct { char name[4]; unsigned rgb; } expects[8];
static int n_expects;
static unsigned long peeks[32]; /* --peek: addresses in the console's memory */
static int n_peeks;
static unsigned long n_hw_frames, n_sw_frames, n_audio_frames;
static double expect_tone;      /* --expect-tone: the pitch the sound should have, in Hz */
static double audio_rate = 44100; /* what the core says its sound is sampled at */
/* What the sound looked like (left channel): its loudest sample and the times
 * it swung from one side of silence to the other. */
static struct { long peak; unsigned long swings, first, last; int side; } tone;

static int die_status = 1; /* exit code used by die() */

static void die(const char *fmt, ...) {
  char buf[1024];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  fprintf(stderr, "[player] %s\n", buf);
  if (!no_dialog) SDL_ShowSimpleMessageBox(SDL_MESSAGEBOX_ERROR, "Devious Licks", buf, window);
  exit(die_status);
}

static void core_log(enum retro_log_level level, const char *fmt, ...) {
  if ((int)level < log_level) return;
  va_list ap;
  va_start(ap, fmt);
  fprintf(stderr, "[core] ");
  vfprintf(stderr, fmt, ap);
  va_end(ap);
}

/* ---------- core options ----------
 * A core announces its options (with their defaults) when it starts and then
 * asks for each value. It gets our override when there is one, otherwise its
 * own default. Cores don't fall back to the defaults by themselves, so every
 * option has to get an answer. */
struct option { char *key, *def, *override; };
static struct option *opts;
static int n_opts, cap_opts;

/* Applied to every game; keys that belong to a core we aren't running are
 * simply never asked for. --option on the command line wins over these. */
static const char *const builtin_overrides[][2] = {
  { "mupen64plus-cpucore", "cached_interpreter" },
  { "mupen64plus-rdp-plugin", "gliden64" },
  { "mupen64plus-rsp-plugin", "hle" },
  { "mupen64plus-ThreadedRenderer", "False" },
  { "mupen64plus-EnableFBEmulation", "True" },
  { "mupen64plus-aspect", "4:3" },
  { "mupen64plus-43screensize", "1280x960" },
};

static char *dupstr(const char *s) {
  size_t n = strlen(s) + 1;
  char *d = malloc(n);
  if (!d) abort();
  memcpy(d, s, n);
  return d;
}

static struct option *opt_slot(const char *key) {
  for (int i = 0; i < n_opts; i++) if (!strcmp(opts[i].key, key)) return &opts[i];
  if (n_opts == cap_opts) {
    cap_opts = cap_opts ? cap_opts * 2 : 128;
    opts = realloc(opts, (size_t)cap_opts * sizeof *opts);
    if (!opts) abort();
  }
  struct option *o = &opts[n_opts++];
  o->key = dupstr(key);
  o->def = o->override = NULL;
  return o;
}

static void opt_default(const char *key, const char *value) {
  if (!key || !value) return;
  struct option *o = opt_slot(key);
  free(o->def);
  o->def = dupstr(value);
}

static void opt_override(const char *key, const char *value) {
  struct option *o = opt_slot(key);
  free(o->override);
  o->override = dupstr(value);
}

static const char *opt_value(const char *key) {
  for (int i = 0; i < n_opts; i++)
    if (!strcmp(opts[i].key, key)) return opts[i].override ? opts[i].override : opts[i].def;
  return NULL;
}

static void opts_from_v2(const struct retro_core_options_v2 *o) {
  if (!o || !o->definitions) return;
  for (const struct retro_core_option_v2_definition *d = o->definitions; d->key; d++)
    opt_default(d->key, d->default_value ? d->default_value : d->values[0].value);
}

static void opts_from_v1(const struct retro_core_option_definition *d) {
  for (; d && d->key; d++) opt_default(d->key, d->default_value ? d->default_value : d->values[0].value);
}

/* Oldest form: { key, "Description; default|other|other" } */
static void opts_from_variables(const struct retro_variable *v) {
  for (; v && v->key; v++) {
    const char *p = v->value ? strstr(v->value, "; ") : NULL;
    if (!p) continue;
    p += 2;
    char buf[256];
    size_t n = strcspn(p, "|");
    if (n >= sizeof buf) n = sizeof buf - 1;
    memcpy(buf, p, n);
    buf[n] = 0;
    opt_default(v->key, buf);
  }
}

/* ---------- calls into the core ----------
 * The N64 core runs its emulator on a second stack and hops between the two
 * (libco). On Apple Silicon that hop doesn't put back the floating-point
 * registers a function may keep its numbers in across a call (d8-d15), so a
 * call into the core can return with the player's own numbers scrambled.
 * Marking those registers as overwritten makes the compiler save and restore
 * them around every such call. */
#if defined(__aarch64__)
#define FP_GUARD() __asm__ volatile("" ::: "d8", "d9", "d10", "d11", "d12", "d13", "d14", "d15")
#else
#define FP_GUARD() ((void)0)
#endif
#define NOINLINE __attribute__((noinline))

static NOINLINE void core_run(void) { core.run(); FP_GUARD(); }
static NOINLINE bool core_load_game(const struct retro_game_info *game) { bool ok = core.load_game(game); FP_GUARD(); return ok; }
static NOINLINE void core_context_reset(void) { hw.context_reset(); FP_GUARD(); }
static NOINLINE void core_reset(void) { core.reset(); FP_GUARD(); }
static NOINLINE bool core_serialize(void *buf, size_t size) { bool ok = core.serialize(buf, size); FP_GUARD(); return ok; }
static NOINLINE bool core_unserialize(const void *buf, size_t size) { bool ok = core.unserialize(buf, size); FP_GUARD(); return ok; }
static NOINLINE void core_shutdown(void) { core.unload_game(); core.deinit(); FP_GUARD(); }

/* ---------- OpenGL call recorder (--gl-trace <frames>, --gl-probe) ----------
 * A hardware-rendered core asks the player for its OpenGL functions
 * (get_proc_address), so the player can hand it stand-ins that write the call
 * down, ask OpenGL whether it failed, and pass it on. That is how a black
 * picture gets diagnosed without rebuilding the core.
 *
 * Only OpenGL 2.0 and later can be seen this way. A core links the 1.x
 * functions (glDrawArrays, glClear, glBindTexture, glViewport...) straight to
 * the system, so those never come past. An error one of them raises is found
 * waiting when the next recorded call arrives; the state it ran in is then
 * still in place and gets written down (tr_state).
 *
 * What is printed: while the core sets up, the calls that build framebuffers;
 * for the first <frames> frames, the last frame of a self-test and any frame
 * asked for with F8, every recorded call; at any time, a call that failed.
 * With --gl-probe each fully recorded frame ends with the colours every
 * framebuffer shows at the middle of each of its quarters and at its centre. */
static long gl_trace;      /* 0 = recorder off */
static bool gl_probe;
static bool gl_trace_live; /* inside a recorded window */
static bool tr_detail;     /* ...in which every call is printed, not just the framebuffer ones */
static long tr_frame;      /* the frame being run, 0 before the first */
static bool tr_request;    /* F8: record the next frame in full */
static unsigned tr_failures, tr_unseen, tr_shaders, tr_shader_fails, tr_programs, tr_program_fails;
static GLuint tr_draw_fb, tr_read_fb, tr_program;
static GLuint tr_fbs[48];  /* the framebuffers the core has made */
static unsigned tr_n_fbs;
static GLint tr_seen[16][4]; /* error, program, vertex array, framebuffer: states already written down */
static unsigned tr_n_seen;
static char tr_last[400];
static unsigned tr_repeats;

static void (APIENTRY *tr_GetShaderiv)(GLuint, GLenum, GLint *);
static void (APIENTRY *tr_GetShaderInfoLog)(GLuint, GLsizei, GLsizei *, GLchar *);
static void (APIENTRY *tr_GetShaderSource)(GLuint, GLsizei, GLsizei *, GLchar *);
static void (APIENTRY *tr_GetProgramiv)(GLuint, GLenum, GLint *);
static void (APIENTRY *tr_GetProgramInfoLog)(GLuint, GLsizei, GLsizei *, GLchar *);
static void (APIENTRY *tr_GetIntegerv)(GLenum, GLint *);
static void (APIENTRY *tr_BindBuffer)(GLenum, GLuint);
static void (APIENTRY *tr_GetVertexAttribiv)(GLuint, GLenum, GLint *);
static void (APIENTRY *tr_ValidateProgram)(GLuint);
static void (APIENTRY *tr_GetActiveAttrib)(GLuint, GLuint, GLsizei, GLsizei *, GLint *, GLenum *, GLchar *);
static GLint (APIENTRY *tr_GetAttribLocation)(GLuint, const GLchar *);
static void (APIENTRY *tr_GetActiveUniform)(GLuint, GLuint, GLsizei, GLsizei *, GLint *, GLenum *, GLchar *);
static GLint (APIENTRY *tr_GetUniformLocation)(GLuint, const GLchar *);
static void (APIENTRY *tr_GetUniformiv)(GLuint, GLint, GLint *);
static void (APIENTRY *tr_GetBufferParameteriv)(GLenum, GLenum, GLint *);
static GLboolean (APIENTRY *tr_IsEnabled)(GLenum);
static void (APIENTRY *tr_GetFramebufferAttachmentParameteriv)(GLenum, GLenum, GLenum, GLint *);
static void (APIENTRY *tr_GetTexLevelParameteriv)(GLenum, GLint, GLenum, GLint *);
static void (APIENTRY *tr_GetRenderbufferParameteriv)(GLenum, GLenum, GLint *);

static void tr_flush(void) {
  if (tr_repeats) fprintf(stderr, "[gl]   (the same call %u more time%s)\n", tr_repeats, tr_repeats == 1 ? "" : "s");
  tr_repeats = 0;
  tr_last[0] = 0;
}

static void tr_print(const char *line) {
  if (!strcmp(line, tr_last)) { tr_repeats++; return; }
  tr_flush();
  fprintf(stderr, "[gl] %s\n", line);
  snprintf(tr_last, sizeof tr_last, "%s", line);
}

/* Writes one recorded call down, with the error OpenGL reports after it.
 * detail = a call that is only worth a line in a fully recorded frame. */
static void tr(int detail, const char *fmt, ...) {
  char line[400];
  GLenum err = glGetError_();
  bool wanted = gl_trace_live && (tr_detail || !detail);
  if (!wanted && (!err || tr_failures >= 60)) return;
  int n = wanted ? 0 : tr_frame ? snprintf(line, 32, "frame %ld: ", tr_frame) : snprintf(line, 32, "set-up: ");
  va_list ap;
  va_start(ap, fmt);
  int m = vsnprintf(line + n, sizeof line - 40 - (size_t)n, fmt, ap);
  va_end(ap);
  n += m < 0 ? 0 : m;
  if (n > (int)sizeof line - 41) n = (int)sizeof line - 41;
  if (err) {
    snprintf(line + n, 40, "   <-- GL error 0x%04x", err);
    if (!wanted) tr_failures++;
  }
  tr_print(line);
}

/* Opens (or, with what = NULL, closes) a recorded window. */
static void tr_window(const char *what, long frame, bool detail) {
  tr_flush();
  gl_trace_live = what != NULL;
  tr_detail = detail;
  if (frame) tr_frame = frame;
  if (!what) return;
  if (frame) fprintf(stderr, "[gl] ---- %s %ld ----\n", what, frame);
  else fprintf(stderr, "[gl] ---- %s ----\n", what);
}

static const char *tr_name(GLenum e) {
  static char buf[8][12];
  static unsigned slot;
  switch (e) {
    case 0x8D40: return "FRAMEBUFFER";
    case 0x8CA8: return "READ_FRAMEBUFFER";
    case 0x8CA9: return "DRAW_FRAMEBUFFER";
    case 0x8D41: return "RENDERBUFFER";
    case 0x0DE1: return "TEXTURE_2D";
    case 0x9100: return "TEXTURE_2D_MULTISAMPLE";
    case 0x8CE0: return "COLOR0";
    case 0x8D00: return "DEPTH";
    case 0x8D20: return "STENCIL";
    case 0x821A: return "DEPTH_STENCIL";
    case 0x8CD5: return "COMPLETE";
    case 0x0BE2: return "BLEND";
    case 0x0B71: return "DEPTH_TEST";
    case 0x0C11: return "SCISSOR_TEST";
    case 0x0B44: return "CULL_FACE";
    case 0x0B90: return "STENCIL_TEST";
    case 0x0BD0: return "DITHER";
    case 0x8037: return "POLYGON_OFFSET_FILL";
    case 0x864F: return "DEPTH_CLAMP";
    case 0x3000: return "CLIP_DISTANCE0";
    case 0x8DB9: return "FRAMEBUFFER_SRGB";
    case 0x809D: return "MULTISAMPLE";
    case 0x0404: return "FRONT";
    case 0x0405: return "BACK";
    case 0x8892: return "ARRAY_BUFFER";
    case 0x8893: return "ELEMENT_ARRAY_BUFFER";
    case 0x88EB: return "PIXEL_PACK_BUFFER";
    case 0x88EC: return "PIXEL_UNPACK_BUFFER";
    case 0x8A11: return "UNIFORM_BUFFER";
    case 0x1908: return "RGBA";
    case 0x1907: return "RGB";
    case 0x8058: return "RGBA8";
    case 0x1401: return "UNSIGNED_BYTE";
    case 0x1406: return "FLOAT";
    case 0x2600: return "NEAREST";
    case 0x2601: return "LINEAR";
    default: break;
  }
  slot = (slot + 1) % 8;
  snprintf(buf[slot], sizeof buf[slot], "0x%04x", e);
  return buf[slot];
}

static const char *tr_mode(GLenum mode) {
  static const char *const names[] = { "POINTS", "LINES", "LINE_LOOP", "LINE_STRIP", "TRIANGLES", "TRIANGLE_STRIP", "TRIANGLE_FAN" };
  return mode < sizeof names / sizeof names[0] ? names[mode] : tr_name(mode);
}

/* Prints a block of text (a compiler's message) under the call it belongs to. */
static void tr_text(const char *text, int max_lines) {
  tr_flush();
  while (*text && max_lines-- > 0) {
    size_t n = strcspn(text, "\n");
    if (n) fprintf(stderr, "[gl]     %.*s\n", (int)(n > 300 ? 300 : n), text);
    text += n;
    if (*text) text++;
  }
}

static void tr_source_line(const char *src, long want) {
  long line = 1;
  for (const char *p = src; *p; line++) {
    size_t n = strcspn(p, "\n");
    if (line == want) { fprintf(stderr, "[gl]     source line %ld: %.*s\n", want, (int)(n > 300 ? 300 : n), p); return; }
    p += n;
    if (*p) p++;
  }
}

/* The compiler's message, the shader's first line (its GLSL version) and the
 * source lines the message points at ("ERROR: 0:<line>: ..." on a Mac). */
static void tr_shader_failure(GLuint shader) {
  char log[2048] = "";
  GLint len = 0;
  tr_GetShaderInfoLog(shader, (GLsizei)sizeof log, NULL, log);
  tr_text(log, 12);
  tr_GetShaderiv(shader, GL_SHADER_SOURCE_LENGTH, &len);
  char *src = len > 0 ? calloc(1, (size_t)len + 1) : NULL;
  if (!src) return;
  tr_GetShaderSource(shader, len, NULL, src);
  tr_source_line(src, 1);
  long last = 0;
  int shown = 0;
  for (const char *p = log; (p = strstr(p, "0:")) && shown < 6;) {
    p += 2;
    long n = strtol(p, NULL, 10);
    if (n > 1 && n != last) { tr_source_line(src, n); last = n; shown++; }
  }
  free(src);
}

static const char *tr_sampler(GLenum type) {
  switch (type) {
    case 0x8B5E: return "sampler2D";
    case 0x8B62: return "sampler2DShadow";
    case 0x8DCA: return "isampler2D";
    case 0x8DD2: return "usampler2D";
    case 0x9108: return "sampler2DMS";
    case 0x9109: return "isampler2DMS";
    case 0x910A: return "usampler2DMS";
    default: break;
  }
  bool sampler = (type >= 0x8B5D && type <= 0x8B64) || (type >= 0x8DC0 && type <= 0x8DC5) || (type >= 0x8DC9 && type <= 0x8DD8) ||
                 (type >= 0x910B && type <= 0x910D);
  return sampler ? "sampler" : NULL;
}

/* What a drawing call depends on, as OpenGL has it right now. */
static void tr_state(void) {
  enum { CURRENT_PROGRAM = 0x8B8D, VAO_BINDING = 0x85B5, ARRAY_BINDING = 0x8894, ELEMENT_BINDING = 0x8895, DRAW_FB_BINDING = 0x8CA6,
         READ_FB_BINDING = 0x8CAA, VIEWPORT = 0x0BA2, SCISSOR_BOX = 0x0C10, MAX_ATTRIBS = 0x8869, ATTRIB_ON = 0x8622, ATTRIB_SIZE = 0x8623,
         ATTRIB_STRIDE = 0x8624, ATTRIB_TYPE = 0x8625, ATTRIB_BUFFER = 0x889F, VALIDATE_STATUS = 0x8B83, ACTIVE_ATTRIBUTES = 0x8B89,
         ACTIVE_UNIFORMS = 0x8B86, BUFFER_MAPPED = 0x88BC };
  GLint program = 0, vao = 0, array = 0, element = 0, draw_fb = 0, read_fb = 0, vp[4] = { 0, 0, 0, 0 }, sc[4] = { 0, 0, 0, 0 }, n = 0;
  char line[700];
  size_t len;
  if (!tr_GetIntegerv) return;
  tr_GetIntegerv(CURRENT_PROGRAM, &program);
  tr_GetIntegerv(VAO_BINDING, &vao);
  tr_GetIntegerv(ARRAY_BINDING, &array);
  tr_GetIntegerv(ELEMENT_BINDING, &element);
  tr_GetIntegerv(DRAW_FB_BINDING, &draw_fb);
  tr_GetIntegerv(READ_FB_BINDING, &read_fb);
  tr_GetIntegerv(VIEWPORT, vp);
  tr_GetIntegerv(SCISSOR_BOX, sc);
  GLenum status = glCheckFramebufferStatus_(GL_DRAW_FRAMEBUFFER);
  fprintf(stderr, "[gl]     drawing into framebuffer %d (%s), reading from %d; viewport %d,%d %dx%d; scissor %s %d,%d %dx%d\n", draw_fb,
          status == GL_FRAMEBUFFER_COMPLETE ? "complete" : "NOT complete", read_fb, vp[0], vp[1], vp[2], vp[3],
          tr_IsEnabled && tr_IsEnabled(GL_SCISSOR_TEST) ? "on" : "off", sc[0], sc[1], sc[2], sc[3]);
  fprintf(stderr, "[gl]     program %d, vertex array %d, array buffer %d, element buffer %d\n", program, vao, array, element);
  if (program && tr_ValidateProgram && tr_GetProgramiv) {
    GLint ok = 1;
    char log[1024] = "";
    tr_ValidateProgram((GLuint)program);
    tr_GetProgramiv((GLuint)program, VALIDATE_STATUS, &ok);
    if (tr_GetProgramInfoLog) tr_GetProgramInfoLog((GLuint)program, (GLsizei)sizeof log, NULL, log);
    fprintf(stderr, "[gl]     OpenGL says program %d %s as things stand\n", program, ok ? "can run" : "can NOT run");
    tr_text(log, 6);
  }
  if (program && tr_GetProgramiv && tr_GetActiveAttrib && tr_GetAttribLocation) {
    tr_GetProgramiv((GLuint)program, ACTIVE_ATTRIBUTES, &n);
    line[0] = 0;
    len = 0;
    for (GLint i = 0; i < n && i < 16 && len < sizeof line - 100; i++) {
      char name[64] = "";
      GLint size = 0;
      GLenum type = 0;
      tr_GetActiveAttrib((GLuint)program, (GLuint)i, (GLsizei)sizeof name, NULL, &size, &type, name);
      len += (size_t)snprintf(line + len, sizeof line - len, " %s=%d", name, (int)tr_GetAttribLocation((GLuint)program, name));
    }
    fprintf(stderr, "[gl]     the program reads vertex attributes:%s\n", len ? line : " none");
  }
  if (tr_GetVertexAttribiv) {
    tr_GetIntegerv(MAX_ATTRIBS, &n);
    for (GLint i = 0; i < n && i < 32; i++) {
      GLint on = 0, buffer = 0, size = 0, stride = 0, type = 0;
      tr_GetVertexAttribiv((GLuint)i, ATTRIB_ON, &on);
      if (!on) continue;
      tr_GetVertexAttribiv((GLuint)i, ATTRIB_BUFFER, &buffer);
      tr_GetVertexAttribiv((GLuint)i, ATTRIB_SIZE, &size);
      tr_GetVertexAttribiv((GLuint)i, ATTRIB_STRIDE, &stride);
      tr_GetVertexAttribiv((GLuint)i, ATTRIB_TYPE, &type);
      fprintf(stderr, "[gl]     attribute array %d is on: buffer %d, %d x %s, stride %d%s\n", (int)i, buffer, size, tr_name((GLenum)type), stride,
              buffer ? "" : "   <-- on, but with no buffer to read from");
    }
  }
  if (program && tr_GetProgramiv && tr_GetActiveUniform && tr_GetUniformLocation && tr_GetUniformiv) {
    n = 0;
    tr_GetProgramiv((GLuint)program, ACTIVE_UNIFORMS, &n);
    line[0] = 0;
    len = 0;
    for (GLint i = 0; i < n && i < 96 && len < sizeof line - 100; i++) {
      char name[64] = "";
      GLint size = 0, unit = -1;
      GLenum type = 0;
      tr_GetActiveUniform((GLuint)program, (GLuint)i, (GLsizei)sizeof name, NULL, &size, &type, name);
      const char *kind = tr_sampler(type);
      if (!kind) continue;
      GLint at = tr_GetUniformLocation((GLuint)program, name);
      if (at >= 0) tr_GetUniformiv((GLuint)program, at, &unit);
      len += (size_t)snprintf(line + len, sizeof line - len, " %s(%s)=%d", name, kind, unit);
    }
    if (len) fprintf(stderr, "[gl]     its textures come from units:%s\n", line);
  }
  if (array && tr_GetBufferParameteriv) {
    GLint mapped = 0;
    tr_GetBufferParameteriv(0x8892, BUFFER_MAPPED, &mapped);
    if (mapped) fprintf(stderr, "[gl]     array buffer %d is still mapped\n", array);
  }
  while (glGetError_()) { }
}

/* An error that is already waiting when a recorded call arrives was raised by
 * a call the recorder can't see. The first time it happens in a given state,
 * that state is written down. */
static void tr_pending(const char *next) {
  GLenum err = glGetError_();
  if (!err) return;
  while (glGetError_()) { }
  if (++tr_unseen > 12) return; /* after that they are only counted */
  tr_flush();
  if (gl_trace_live) fprintf(stderr, "[gl] ");
  else if (tr_frame) fprintf(stderr, "[gl] frame %ld: ", tr_frame);
  else fprintf(stderr, "[gl] set-up: ");
  fprintf(stderr, "GL error 0x%04x was raised by a call that can't be recorded, before %s\n", err, next);
  GLint now[4] = { (GLint)err, 0, 0, 0 };
  if (!tr_GetIntegerv) return;
  tr_GetIntegerv(0x8B8D, &now[1]);
  tr_GetIntegerv(0x85B5, &now[2]);
  tr_GetIntegerv(0x8CA6, &now[3]);
  for (unsigned i = 0; i < tr_n_seen; i++)
    if (!memcmp(tr_seen[i], now, sizeof now)) return;
  if (tr_n_seen == sizeof tr_seen / sizeof tr_seen[0]) return;
  memcpy(tr_seen[tr_n_seen++], now, sizeof now);
  tr_state();
}

/* --gl-probe: what every framebuffer shows once a fully recorded frame is done:
 * five pixels each, named as OpenGL stores them (y runs upward). Every piece
 * of OpenGL state this touches is put back. */
static void tr_survey(void) {
  enum { READ_FB_BINDING = 0x8CAA, PACK_BUFFER_BINDING = 0x88ED, READ_BUFFER = 0x0C02, PACK_SKIP_ROWS = 0x0D03, PACK_SKIP_PIXELS = 0x0D04,
         PACK_ROW_LENGTH = 0x0D02, TEXTURE_BINDING_2D = 0x8069, RENDERBUFFER_BINDING = 0x8CA7, OBJECT_TYPE = 0x8CD0, OBJECT_NAME = 0x8CD1,
         TEXTURE = 0x1702, TEXTURE_WIDTH = 0x1000, TEXTURE_HEIGHT = 0x1001, RENDERBUFFER_WIDTH = 0x8D42, RENDERBUFFER_HEIGHT = 0x8D43 };
  static const float px[5] = { 0.25f, 0.75f, 0.25f, 0.75f, 0.5f }, py[5] = { 0.75f, 0.75f, 0.25f, 0.25f, 0.5f };
  GLint read_fb = 0, pack = 0, skip_rows = 0, skip_pixels = 0, row_length = 0, texture = 0, renderbuffer = 0;
  if (!gl_probe || !tr_GetIntegerv || !tr_BindBuffer || !tr_GetFramebufferAttachmentParameteriv || !tr_GetTexLevelParameteriv ||
      !tr_GetRenderbufferParameteriv) return;
  tr_GetIntegerv(PACK_SKIP_ROWS, &skip_rows);
  tr_GetIntegerv(PACK_SKIP_PIXELS, &skip_pixels);
  tr_GetIntegerv(PACK_ROW_LENGTH, &row_length);
  if (skip_rows || skip_pixels || row_length) return;
  tr_GetIntegerv(READ_FB_BINDING, &read_fb);
  tr_GetIntegerv(PACK_BUFFER_BINDING, &pack);
  tr_GetIntegerv(TEXTURE_BINDING_2D, &texture);
  tr_GetIntegerv(RENDERBUFFER_BINDING, &renderbuffer);
  if (pack) tr_BindBuffer(0x88EB, 0);
  while (glGetError_()) { }
  tr_flush();
  for (unsigned k = 0; k <= tr_n_fbs; k++) {
    GLuint id = k ? tr_fbs[k - 1] : fbo;
    const char *whose = k ? "" : ", the player's";
    GLint type = 0, name = 0, w = 0, h = 0, read_buffer = 0;
    unsigned got[5];
    if (!id) continue;
    glBindFramebuffer_(GL_READ_FRAMEBUFFER, id);
    GLenum status = glCheckFramebufferStatus_(GL_READ_FRAMEBUFFER);
    if (status != GL_FRAMEBUFFER_COMPLETE) {
      while (glGetError_()) { }
      fprintf(stderr, "[gl]     framebuffer %u%s: not usable (%s)\n", id, whose, tr_name(status));
      continue;
    }
    tr_GetFramebufferAttachmentParameteriv(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, OBJECT_TYPE, &type);
    tr_GetFramebufferAttachmentParameteriv(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, OBJECT_NAME, &name);
    if (type == TEXTURE) {
      glBindTexture_(GL_TEXTURE_2D, (GLuint)name);
      tr_GetTexLevelParameteriv(GL_TEXTURE_2D, 0, TEXTURE_WIDTH, &w);
      tr_GetTexLevelParameteriv(GL_TEXTURE_2D, 0, TEXTURE_HEIGHT, &h);
    } else if (type == GL_RENDERBUFFER) {
      glBindRenderbuffer_(GL_RENDERBUFFER, (GLuint)name);
      tr_GetRenderbufferParameteriv(GL_RENDERBUFFER, RENDERBUFFER_WIDTH, &w);
      tr_GetRenderbufferParameteriv(GL_RENDERBUFFER, RENDERBUFFER_HEIGHT, &h);
    }
    if (glGetError_() || w <= 0 || h <= 0) {
      while (glGetError_()) { }
      fprintf(stderr, "[gl]     framebuffer %u%s: has no colour picture that can be measured\n", id, whose);
      continue;
    }
    tr_GetIntegerv(READ_BUFFER, &read_buffer);
    glReadBuffer_(GL_COLOR_ATTACHMENT0);
    for (int i = 0; i < 5; i++) {
      unsigned char p[4] = { 0, 0, 0, 0 };
      glReadPixels_((GLint)((float)w * px[i]), (GLint)((float)h * py[i]), 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, p);
      got[i] = ((unsigned)p[0] << 16) | ((unsigned)p[1] << 8) | p[2];
    }
    GLenum err = glGetError_();
    glReadBuffer_((GLenum)read_buffer);
    while (glGetError_()) { }
    if (err) fprintf(stderr, "[gl]     framebuffer %u%s (%dx%d): can't be read back (0x%04x)\n", id, whose, w, h, err);
    else fprintf(stderr, "[gl]     framebuffer %u%s (%dx%d) shows tl=%06x tr=%06x bl=%06x br=%06x c=%06x\n", id, whose, w, h,
                 got[0], got[1], got[2], got[3], got[4]);
  }
  glBindTexture_(GL_TEXTURE_2D, (GLuint)texture);
  glBindRenderbuffer_(GL_RENDERBUFFER, (GLuint)renderbuffer);
  glBindFramebuffer_(GL_READ_FRAMEBUFFER, (GLuint)read_fb);
  if (pack) tr_BindBuffer(0x88EB, (GLuint)pack);
  while (glGetError_()) { }
}

/* Stand-ins. real_<name> is the function OpenGL itself provides. */
#define TR_VOID(detail, name, params, args, ...) \
  static void (APIENTRY *real_##name) params; \
  static void APIENTRY tr_##name params { tr_pending(#name); real_##name args; tr(detail, #name __VA_ARGS__); }

static void (APIENTRY *real_glBindFramebuffer)(GLenum, GLuint);
static void APIENTRY tr_glBindFramebuffer(GLenum target, GLuint id) {
  tr_pending("glBindFramebuffer");
  real_glBindFramebuffer(target, id);
  if (target != GL_READ_FRAMEBUFFER) tr_draw_fb = id;
  if (target != GL_DRAW_FRAMEBUFFER) tr_read_fb = id;
  tr(0, "glBindFramebuffer(%s, %u)%s", tr_name(target), id, !id ? "  = the window" : id == fbo ? "  = the player's framebuffer" : "");
}

static void (APIENTRY *real_glGenFramebuffers)(GLsizei, GLuint *);
static void APIENTRY tr_glGenFramebuffers(GLsizei n, GLuint *ids) {
  tr_pending("glGenFramebuffers");
  real_glGenFramebuffers(n, ids);
  for (GLsizei i = 0; i < n && tr_n_fbs < sizeof tr_fbs / sizeof tr_fbs[0]; i++) tr_fbs[tr_n_fbs++] = ids[i];
  tr(0, "glGenFramebuffers(%d) -> %u", n, n > 0 ? ids[0] : 0);
}

static void (APIENTRY *real_glDeleteFramebuffers)(GLsizei, const GLuint *);
static void APIENTRY tr_glDeleteFramebuffers(GLsizei n, const GLuint *ids) {
  GLuint first = n > 0 ? ids[0] : 0;
  tr_pending("glDeleteFramebuffers");
  for (GLsizei i = 0; i < n; i++)
    for (unsigned k = 0; k < tr_n_fbs; k++)
      if (tr_fbs[k] == ids[i]) { tr_fbs[k] = tr_fbs[--tr_n_fbs]; break; }
  real_glDeleteFramebuffers(n, ids);
  tr(0, "glDeleteFramebuffers(%d: %u)", n, first);
}

static GLenum (APIENTRY *real_glCheckFramebufferStatus)(GLenum);
static GLenum APIENTRY tr_glCheckFramebufferStatus(GLenum target) {
  tr_pending("glCheckFramebufferStatus");
  GLenum status = real_glCheckFramebufferStatus(target);
  bool live = gl_trace_live;
  if (status != GL_FRAMEBUFFER_COMPLETE) gl_trace_live = true; /* always worth a line */
  tr(0, "glCheckFramebufferStatus(%s) -> %s%s  [draw fb %u, read fb %u]", tr_name(target), tr_name(status),
     status == GL_FRAMEBUFFER_COMPLETE ? "" : "  <-- NOT COMPLETE", tr_draw_fb, tr_read_fb);
  gl_trace_live = live;
  return status;
}

static void (APIENTRY *real_glDrawBuffers)(GLsizei, const GLenum *);
static void APIENTRY tr_glDrawBuffers(GLsizei n, const GLenum *bufs) {
  tr_pending("glDrawBuffers");
  real_glDrawBuffers(n, bufs);
  tr(0, "glDrawBuffers(%d: %s)  [draw fb %u]", n, n > 0 ? tr_name(bufs[0]) : "-", tr_draw_fb);
}

static void (APIENTRY *real_glUseProgram)(GLuint);
static void APIENTRY tr_glUseProgram(GLuint program) {
  tr_pending("glUseProgram");
  real_glUseProgram(program);
  tr_program = program;
  tr(1, "glUseProgram(%u)", program);
}

static void (APIENTRY *real_glCompileShader)(GLuint);
static void APIENTRY tr_glCompileShader(GLuint shader) {
  GLint ok = 1;
  bool live = gl_trace_live;
  tr_pending("glCompileShader");
  real_glCompileShader(shader);
  if (tr_GetShaderiv) tr_GetShaderiv(shader, GL_COMPILE_STATUS, &ok);
  tr_shaders++;
  if (ok) { tr(1, "glCompileShader(%u) ok", shader); return; }
  gl_trace_live = true; /* a failure is always written down */
  tr(0, "glCompileShader(%u) FAILED", shader);
  if (++tr_shader_fails <= 4 && tr_GetShaderInfoLog && tr_GetShaderSource) tr_shader_failure(shader);
  gl_trace_live = live;
}

static void (APIENTRY *real_glLinkProgram)(GLuint);
static void APIENTRY tr_glLinkProgram(GLuint program) {
  GLint ok = 1;
  bool live = gl_trace_live;
  tr_pending("glLinkProgram");
  real_glLinkProgram(program);
  if (tr_GetProgramiv) tr_GetProgramiv(program, GL_LINK_STATUS, &ok);
  tr_programs++;
  if (ok) { tr(1, "glLinkProgram(%u) ok", program); return; }
  gl_trace_live = true;
  tr(0, "glLinkProgram(%u) FAILED", program);
  if (++tr_program_fails <= 4 && tr_GetProgramInfoLog) {
    char log[2048] = "";
    tr_GetProgramInfoLog(program, (GLsizei)sizeof log, NULL, log);
    tr_text(log, 12);
  }
  gl_trace_live = live;
}

static void *(APIENTRY *real_glMapBufferRange)(GLenum, ptrdiff_t, ptrdiff_t, GLbitfield);
static void *APIENTRY tr_glMapBufferRange(GLenum target, ptrdiff_t offset, ptrdiff_t length, GLbitfield access) {
  tr_pending("glMapBufferRange");
  void *p = real_glMapBufferRange(target, offset, length, access);
  tr(1, "glMapBufferRange(%s, %ld, %ld, 0x%x) -> %s", tr_name(target), (long)offset, (long)length, access, p ? "mapped" : "NULL");
  return p;
}

static GLboolean (APIENTRY *real_glUnmapBuffer)(GLenum);
static GLboolean APIENTRY tr_glUnmapBuffer(GLenum target) {
  tr_pending("glUnmapBuffer");
  GLboolean ok = real_glUnmapBuffer(target);
  tr(1, "glUnmapBuffer(%s) -> %d", tr_name(target), ok);
  return ok;
}

TR_VOID(0, glFramebufferTexture2D, (GLenum target, GLenum attachment, GLenum textarget, GLuint texture, GLint level), (target, attachment, textarget, texture, level),
        "(%s, %s, %s, texture %u, level %d)  [draw fb %u, read fb %u]", tr_name(target), tr_name(attachment), tr_name(textarget), texture, level, tr_draw_fb, tr_read_fb)
TR_VOID(0, glFramebufferRenderbuffer, (GLenum target, GLenum attachment, GLenum rbtarget, GLuint rb), (target, attachment, rbtarget, rb),
        "(%s, %s, renderbuffer %u)  [draw fb %u, read fb %u]", tr_name(target), tr_name(attachment), rb, tr_draw_fb, tr_read_fb)
TR_VOID(0, glRenderbufferStorage, (GLenum target, GLenum format, GLsizei w, GLsizei h), (target, format, w, h), "(%s, %dx%d)", tr_name(format), w, h)
TR_VOID(0, glBlitFramebuffer, (GLint sx0, GLint sy0, GLint sx1, GLint sy1, GLint dx0, GLint dy0, GLint dx1, GLint dy1, GLbitfield mask, GLenum filter),
        (sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, filter),
        "(%d,%d %d,%d -> %d,%d %d,%d, mask 0x%x, %s)  [read fb %u -> draw fb %u]", sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, tr_name(filter), tr_read_fb, tr_draw_fb)
TR_VOID(0, glReadBuffer, (GLenum src), (src), "(%s)  [read fb %u]", tr_name(src), tr_read_fb)
TR_VOID(0, glReadPixels, (GLint x, GLint y, GLsizei w, GLsizei h, GLenum format, GLenum type, void *pixels), (x, y, w, h, format, type, pixels),
        "(%d,%d %dx%d, %s, %s)  [read fb %u]", x, y, w, h, tr_name(format), tr_name(type), tr_read_fb)
TR_VOID(0, glClear, (GLbitfield mask), (mask), "(%s%s%s)  [draw fb %u]", mask & 0x4000 ? "colour" : "", mask & 0x100 ? " depth" : "", mask & 0x400 ? " stencil" : "", tr_draw_fb)
TR_VOID(1, glViewport, (GLint x, GLint y, GLsizei w, GLsizei h), (x, y, w, h), "(%d, %d, %d, %d)", x, y, w, h)
TR_VOID(1, glScissor, (GLint x, GLint y, GLsizei w, GLsizei h), (x, y, w, h), "(%d, %d, %d, %d)", x, y, w, h)
TR_VOID(1, glEnable, (GLenum cap), (cap), "(%s)", tr_name(cap))
TR_VOID(1, glDisable, (GLenum cap), (cap), "(%s)", tr_name(cap))
TR_VOID(1, glColorMask, (GLboolean r, GLboolean g, GLboolean b, GLboolean a), (r, g, b, a), "(%d, %d, %d, %d)", r, g, b, a)
TR_VOID(0, glDrawArrays, (GLenum mode, GLint first, GLsizei count), (mode, first, count),
        "(%s, %d, %d)  [draw fb %u, program %u]", tr_mode(mode), first, count, tr_draw_fb, tr_program)
TR_VOID(0, glDrawElements, (GLenum mode, GLsizei count, GLenum type, const void *indices), (mode, count, type, indices),
        "(%s, %d)  [draw fb %u, program %u]", tr_mode(mode), count, tr_draw_fb, tr_program)
TR_VOID(0, glDrawElementsBaseVertex, (GLenum mode, GLsizei count, GLenum type, const void *indices, GLint base), (mode, count, type, indices, base),
        "(%s, %d, base %d)  [draw fb %u, program %u]", tr_mode(mode), count, base, tr_draw_fb, tr_program)
TR_VOID(0, glDrawRangeElementsBaseVertex, (GLenum mode, GLuint start, GLuint end, GLsizei count, GLenum type, const void *indices, GLint base),
        (mode, start, end, count, type, indices, base), "(%s, %d, base %d)  [draw fb %u, program %u]", tr_mode(mode), count, base, tr_draw_fb, tr_program)
TR_VOID(1, glBindTexture, (GLenum target, GLuint texture), (target, texture), "(%s, %u)", tr_name(target), texture)
TR_VOID(1, glTexImage2D, (GLenum target, GLint level, GLint iformat, GLsizei w, GLsizei h, GLint border, GLenum format, GLenum type, const void *pixels),
        (target, level, iformat, w, h, border, format, type, pixels),
        "(%s, level %d, %s, %dx%d, %s, %s, %s)", tr_name(target), level, tr_name((GLenum)iformat), w, h, tr_name(format), tr_name(type), pixels ? "pixels" : "empty")
TR_VOID(1, glTexSubImage2D, (GLenum target, GLint level, GLint x, GLint y, GLsizei w, GLsizei h, GLenum format, GLenum type, const void *pixels),
        (target, level, x, y, w, h, format, type, pixels), "(%s, level %d, %d,%d %dx%d, %s, %s)", tr_name(target), level, x, y, w, h, tr_name(format), tr_name(type))
TR_VOID(1, glTexStorage2D, (GLenum target, GLsizei levels, GLenum iformat, GLsizei w, GLsizei h), (target, levels, iformat, w, h),
        "(%s, %d levels, %s, %dx%d)", tr_name(target), levels, tr_name(iformat), w, h)
TR_VOID(1, glBindVertexArray, (GLuint array), (array), "(%u)", array)
TR_VOID(1, glEnableVertexAttribArray, (GLuint index), (index), "(%u)", index)
TR_VOID(1, glDisableVertexAttribArray, (GLuint index), (index), "(%u)", index)
TR_VOID(1, glBindBuffer, (GLenum target, GLuint buffer), (target, buffer), "(%s, %u)", tr_name(target), buffer)
TR_VOID(1, glBufferData, (GLenum target, ptrdiff_t size, const void *data, GLenum usage), (target, size, data, usage), "(%s, %ld bytes)", tr_name(target), (long)size)
TR_VOID(1, glBufferSubData, (GLenum target, ptrdiff_t offset, ptrdiff_t size, const void *data), (target, offset, size, data),
        "(%s, at %ld, %ld bytes)", tr_name(target), (long)offset, (long)size)

static const struct { const char *name; void *real; retro_proc_address_t stand_in; } tr_table[] = {
#define TR_ENTRY(name) { #name, &real_##name, (retro_proc_address_t)tr_##name },
  TR_ENTRY(glBindFramebuffer) TR_ENTRY(glGenFramebuffers) TR_ENTRY(glDeleteFramebuffers) TR_ENTRY(glCheckFramebufferStatus)
  TR_ENTRY(glDrawBuffers) TR_ENTRY(glUseProgram) TR_ENTRY(glCompileShader) TR_ENTRY(glLinkProgram)
  TR_ENTRY(glMapBufferRange) TR_ENTRY(glUnmapBuffer) TR_ENTRY(glFramebufferTexture2D) TR_ENTRY(glFramebufferRenderbuffer)
  TR_ENTRY(glRenderbufferStorage) TR_ENTRY(glBlitFramebuffer) TR_ENTRY(glReadBuffer) TR_ENTRY(glReadPixels)
  TR_ENTRY(glClear) TR_ENTRY(glViewport) TR_ENTRY(glScissor) TR_ENTRY(glEnable) TR_ENTRY(glDisable) TR_ENTRY(glColorMask)
  TR_ENTRY(glDrawArrays) TR_ENTRY(glDrawElements) TR_ENTRY(glDrawElementsBaseVertex) TR_ENTRY(glDrawRangeElementsBaseVertex)
  TR_ENTRY(glBindTexture) TR_ENTRY(glTexImage2D) TR_ENTRY(glTexSubImage2D) TR_ENTRY(glTexStorage2D)
  TR_ENTRY(glBindVertexArray) TR_ENTRY(glEnableVertexAttribArray) TR_ENTRY(glDisableVertexAttribArray)
  TR_ENTRY(glBindBuffer) TR_ENTRY(glBufferData) TR_ENTRY(glBufferSubData)
#undef TR_ENTRY
};

static void tr_start(void) {
#define OPTIONAL(var, name) *(void **)&var = SDL_GL_GetProcAddress(name)
  OPTIONAL(tr_GetShaderiv, "glGetShaderiv");
  OPTIONAL(tr_GetShaderInfoLog, "glGetShaderInfoLog");
  OPTIONAL(tr_GetShaderSource, "glGetShaderSource");
  OPTIONAL(tr_GetProgramiv, "glGetProgramiv");
  OPTIONAL(tr_GetProgramInfoLog, "glGetProgramInfoLog");
  OPTIONAL(tr_GetIntegerv, "glGetIntegerv");
  OPTIONAL(tr_BindBuffer, "glBindBuffer");
  OPTIONAL(tr_GetVertexAttribiv, "glGetVertexAttribiv");
  OPTIONAL(tr_ValidateProgram, "glValidateProgram");
  OPTIONAL(tr_GetActiveAttrib, "glGetActiveAttrib");
  OPTIONAL(tr_GetAttribLocation, "glGetAttribLocation");
  OPTIONAL(tr_GetActiveUniform, "glGetActiveUniform");
  OPTIONAL(tr_GetUniformLocation, "glGetUniformLocation");
  OPTIONAL(tr_GetUniformiv, "glGetUniformiv");
  OPTIONAL(tr_GetBufferParameteriv, "glGetBufferParameteriv");
  OPTIONAL(tr_IsEnabled, "glIsEnabled");
  OPTIONAL(tr_GetFramebufferAttachmentParameteriv, "glGetFramebufferAttachmentParameteriv");
  OPTIONAL(tr_GetTexLevelParameteriv, "glGetTexLevelParameteriv");
  OPTIONAL(tr_GetRenderbufferParameteriv, "glGetRenderbufferParameteriv");
#undef OPTIONAL
  fprintf(stderr, "[gl] recording the OpenGL calls the core makes through the player: its set-up, the first %ld frame(s)%s, then only failures\n",
          gl_trace, test_frames ? " and the last one" : " and any frame asked for with F8");
  fprintf(stderr, "[gl] (the old OpenGL 1.x calls, such as glDrawArrays and glClear, go straight to the system and can't be recorded;\n"
                  "[gl]  an error from one of them is reported when the next recorded call arrives)\n");
}

static void tr_summary(void) {
  tr_flush();
  fprintf(stderr, "[gl] summary: %u shader(s) compiled, %u failed; %u program(s) linked, %u failed; %u recorded call(s) failed outside the recorded frames; "
                  "%u error(s) came from calls that can't be recorded\n", tr_shaders, tr_shader_fails, tr_programs, tr_program_fails, tr_failures, tr_unseen);
}

/* ---------- video ---------- */
static uintptr_t get_current_framebuffer(void) { return fbo; }

static retro_proc_address_t get_proc_address(const char *sym) {
  retro_proc_address_t p = (retro_proc_address_t)SDL_GL_GetProcAddress(sym);
  if (gl_trace && p) {
    for (size_t i = 0; i < sizeof tr_table / sizeof tr_table[0]; i++) {
      if (strcmp(sym, tr_table[i].name)) continue;
      memcpy(tr_table[i].real, &p, sizeof p);
      return tr_table[i].stand_in;
    }
  }
  return p;
}

/* (Re)allocates the framebuffer a hardware-rendered core draws into. It keeps
 * the same framebuffer name when it grows, because the core remembers it. */
static void create_hw_fbo(unsigned w, unsigned h) {
  if (!fbo) {
    glGenFramebuffers_(1, &fbo);
    glGenTextures_(1, &fbo_tex);
    if (hw.depth) glGenRenderbuffers_(1, &fbo_depth);
  }
  tex_w = w; tex_h = h;
  glBindTexture_(GL_TEXTURE_2D, fbo_tex);
  glTexImage2D_(GL_TEXTURE_2D, 0, GL_RGBA8, (GLsizei)w, (GLsizei)h, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
  glTexParameteri_(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri_(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glBindTexture_(GL_TEXTURE_2D, 0);
  glBindFramebuffer_(GL_FRAMEBUFFER, fbo);
  glFramebufferTexture2D_(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, fbo_tex, 0);
  if (fbo_depth) {
    glBindRenderbuffer_(GL_RENDERBUFFER, fbo_depth);
    glRenderbufferStorage_(GL_RENDERBUFFER, hw.stencil ? GL_DEPTH24_STENCIL8 : GL_DEPTH_COMPONENT24, (GLsizei)w, (GLsizei)h);
    glFramebufferRenderbuffer_(GL_FRAMEBUFFER, hw.stencil ? GL_DEPTH_STENCIL_ATTACHMENT : GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, fbo_depth);
    glBindRenderbuffer_(GL_RENDERBUFFER, 0);
  }
  if (glCheckFramebufferStatus_(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) die("Could not set up the game's graphics (framebuffer incomplete).");
  glClearColor_(0, 0, 0, 1);
  glClear_(GL_COLOR_BUFFER_BIT);
  glBindFramebuffer_(GL_FRAMEBUFFER, 0);
}

static void ensure_sw_texture(unsigned w, unsigned h) {
  if (sw_tex && w <= tex_w && h <= tex_h) return;
  if (sw_tex) { glDeleteTextures_(1, &sw_tex); glDeleteFramebuffers_(1, &sw_fbo); }
  tex_w = w; tex_h = h;
  glGenTextures_(1, &sw_tex);
  glBindTexture_(GL_TEXTURE_2D, sw_tex);
  glTexImage2D_(GL_TEXTURE_2D, 0, GL_RGBA8, (GLsizei)w, (GLsizei)h, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
  glGenFramebuffers_(1, &sw_fbo);
  glBindFramebuffer_(GL_READ_FRAMEBUFFER, sw_fbo);
  glFramebufferTexture2D_(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, sw_tex, 0);
  glBindFramebuffer_(GL_READ_FRAMEBUFFER, 0);
}

static void video_refresh(const void *data, unsigned w, unsigned h, size_t pitch) {
  if (gl_trace_live) {
    tr_flush();
    fprintf(stderr, "[gl] the core hands over %s (%ux%u)\n", !data ? "no new picture" : data == RETRO_HW_FRAME_BUFFER_VALID ? "the framebuffer" : "a software picture", w, h);
  }
  if (!data) return; /* duped frame: keep showing the last one */
  fb_w = w; fb_h = h;
  if (data == RETRO_HW_FRAME_BUFFER_VALID) {
    n_hw_frames++;
  } else {
    unsigned bpp = pixel_format == RETRO_PIXEL_FORMAT_XRGB8888 ? 4 : 2;
    n_sw_frames++;
    ensure_sw_texture(w, h);
    glBindTexture_(GL_TEXTURE_2D, sw_tex);
    glPixelStorei_(GL_UNPACK_ALIGNMENT, 1);
    glPixelStorei_(GL_UNPACK_ROW_LENGTH, (GLint)(pitch / bpp));
    if (pixel_format == RETRO_PIXEL_FORMAT_XRGB8888)
      glTexSubImage2D_(GL_TEXTURE_2D, 0, 0, 0, (GLsizei)w, (GLsizei)h, GL_BGRA, GL_UNSIGNED_INT_8_8_8_8_REV, data);
    else if (pixel_format == RETRO_PIXEL_FORMAT_RGB565)
      glTexSubImage2D_(GL_TEXTURE_2D, 0, 0, 0, (GLsizei)w, (GLsizei)h, GL_RGB, GL_UNSIGNED_SHORT_5_6_5, data);
    else
      glTexSubImage2D_(GL_TEXTURE_2D, 0, 0, 0, (GLsizei)w, (GLsizei)h, GL_BGRA, GL_UNSIGNED_SHORT_1_5_5_5_REV, data);
    glPixelStorei_(GL_UNPACK_ROW_LENGTH, 0);
  }
  frame_ready = true;
}

/* Draws the current picture into the window's back buffer, letterboxed. */
static void draw_frame(void) {
  int dw, dh;
  SDL_GL_GetDrawableSize(window, &dw, &dh);
  glBindFramebuffer_(GL_DRAW_FRAMEBUFFER, 0);
  glDisable_(GL_SCISSOR_TEST); /* the core may have left these set */
  glColorMask_(1, 1, 1, 1);
  glViewport_(0, 0, dw, dh);
  glClearColor_(0, 0, 0, 1);
  glClear_(GL_COLOR_BUFFER_BIT);
  if (fb_w && fb_h) {
    int vw = dw, vh = (int)(dw / aspect);
    if (vh > dh) { vh = dh; vw = (int)(dh * aspect); }
    int x = (dw - vw) / 2, y = (dh - vh) / 2;
    view_x = x; view_y = y; view_w = vw; view_h = vh;
    if (use_hw) {
      glBindFramebuffer_(GL_READ_FRAMEBUFFER, fbo);
      glReadBuffer_(GL_COLOR_ATTACHMENT0); /* the core may have pointed it elsewhere */
      /* bottom_left_origin = standard GL; otherwise the image is upside down */
      if (hw.bottom_left_origin)
        glBlitFramebuffer_(0, 0, (GLint)fb_w, (GLint)fb_h, x, y, x + vw, y + vh, GL_COLOR_BUFFER_BIT, GL_LINEAR);
      else
        glBlitFramebuffer_(0, 0, (GLint)fb_w, (GLint)fb_h, x, y + vh, x + vw, y, GL_COLOR_BUFFER_BIT, GL_LINEAR);
    } else {
      glBindFramebuffer_(GL_READ_FRAMEBUFFER, sw_fbo);
      glBlitFramebuffer_(0, 0, (GLint)fb_w, (GLint)fb_h, x, y + vh, x + vw, y, GL_COLOR_BUFFER_BIT, GL_NEAREST);
    }
    glBindFramebuffer_(GL_READ_FRAMEBUFFER, 0);
  }
}

static void present(void) {
  draw_frame();
  SDL_GL_SwapWindow(window);
}

/* ---------- self-test ---------- */
static unsigned read_px(int x, int y) {
  unsigned char p[4] = { 0, 0, 0, 0 };
  glReadPixels_(x, y, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, p);
  return ((unsigned)p[0] << 16) | ((unsigned)p[1] << 8) | p[2];
}

static bool close_enough(unsigned a, unsigned b) {
  for (int s = 0; s <= 16; s += 8) {
    int d = (int)((a >> s) & 255) - (int)((b >> s) & 255);
    if (d < -48 || d > 48) return false;
  }
  return true;
}

/* Prints the --peek words of the console's memory (for the N64 core: its RAM,
 * one 32-bit word per address, the way the console sees it). */
static void peek_report(const char *when) {
  if (!n_peeks) return;
  size_t size = core.get_memory_size(RETRO_MEMORY_SYSTEM_RAM);
  const unsigned char *ram = core.get_memory_data(RETRO_MEMORY_SYSTEM_RAM);
  printf("[selftest] memory %s:", when);
  for (int i = 0; i < n_peeks; i++) {
    uint32_t word;
    if (!ram || peeks[i] + 4 > size) { printf(" %lx=?", peeks[i]); continue; }
    memcpy(&word, ram + peeks[i], 4);
    printf(" %lx=%08x", peeks[i], (unsigned)word);
  }
  printf("\n");
  fflush(stdout);
}

/* Reads back the picture at the middle of each quarter and at the centre,
 * then checks --expect. "core" is what a hardware-rendered core left in the
 * framebuffer it draws into; "screen" is what draw_frame() just put in the
 * window (before the swap). core_error is the OpenGL error left by the core's
 * last frame, player_error the one left by the player's own drawing. */
static int selftest_report(double seconds, unsigned core_error) {
  static const char *const names[5] = { "tl", "tr", "bl", "br", "c" };
  static const float px[5] = { 0.25f, 0.75f, 0.25f, 0.75f, 0.5f };
  static const float py[5] = { 0.75f, 0.75f, 0.25f, 0.25f, 0.5f }; /* GL's y runs upward */
  unsigned got[5];
  int failed = 0;
  unsigned player_error = (unsigned)glGetError_();
  printf("[selftest] frames=%ld seconds=%.2f hw_frames=%lu sw_frames=%lu audio_frames=%lu picture=%ux%u view=%dx%d core_error=0x%x player_error=0x%x\n",
         test_frames, seconds, n_hw_frames, n_sw_frames, n_audio_frames, fb_w, fb_h, view_w, view_h, core_error, player_error);
  if (use_hw && fb_w && fb_h) {
    glBindFramebuffer_(GL_READ_FRAMEBUFFER, fbo);
    glReadBuffer_(GL_COLOR_ATTACHMENT0);
    for (int i = 0; i < 5; i++) got[i] = read_px((int)(fb_w * px[i]), (int)(fb_h * (hw.bottom_left_origin ? py[i] : 1.0f - py[i])));
    printf("[selftest] core   tl=%06x tr=%06x bl=%06x br=%06x c=%06x\n", got[0], got[1], got[2], got[3], got[4]);
  }
  glBindFramebuffer_(GL_READ_FRAMEBUFFER, 0);
  glReadBuffer_(GL_BACK);
  for (int i = 0; i < 5; i++) got[i] = read_px(view_x + (int)(view_w * px[i]), view_y + (int)(view_h * py[i]));
  printf("[selftest] screen tl=%06x tr=%06x bl=%06x br=%06x c=%06x\n", got[0], got[1], got[2], got[3], got[4]);
  peek_report("at the end");
  /* A steady tone swings twice per cycle; measured from the first swing to
   * the last, so silence before or after doesn't count. */
  double pitch = tone.swings > 1 && tone.last > tone.first ? (double)(tone.swings - 1) / 2.0 * audio_rate / (double)(tone.last - tone.first) : 0;
  printf("[selftest] sound  frames=%lu loudest=%ld pitch=%.0f Hz\n", n_audio_frames, tone.peak, pitch);
  if (expect_tone > 0) {
    if (tone.swings < 20 || tone.peak < 1000) {
      printf("[selftest] FAIL no tone arrived (expected %.0f Hz)\n", expect_tone);
      failed = 1;
    } else if (pitch < expect_tone * 0.95 || pitch > expect_tone * 1.05) {
      printf("[selftest] FAIL the tone is %.0f Hz, expected %.0f Hz\n", pitch, expect_tone);
      failed = 1;
    }
  }
  for (int e = 0; e < n_expects; e++)
    for (int i = 0; i < 5; i++)
      if (!strcmp(expects[e].name, names[i]) && !close_enough(got[i], expects[e].rgb)) {
        printf("[selftest] FAIL %s is %06x, expected %06x\n", names[i], got[i], expects[e].rgb);
        failed = 1;
      }
  if (!failed) printf("[selftest] PASS\n");
  fflush(stdout);
  return failed ? 3 : 0;
}

/* ---------- audio ---------- */
static bool audio_playing;
static bool audio_stalled;   /* the sound device has stopped taking sound: nothing more is queued until it does */
static long audio_dry_count; /* how often the queue ran empty while playing */

static size_t audio_batch(const int16_t *data, size_t frames) {
  if (test_frames) {
    for (size_t i = 0; i < frames; i++) {
      int sample = data[i * 2];
      int side = sample > 512 ? 1 : sample < -512 ? -1 : 0;
      if (labs((long)sample) > tone.peak) tone.peak = labs((long)sample);
      if (side && side != tone.side) {
        if (!tone.swings) tone.first = n_audio_frames + i;
        tone.last = n_audio_frames + i;
        tone.swings++;
        tone.side = side;
      }
    }
  }
  n_audio_frames += frames;
  if (audio_dev && !audio_stalled) SDL_QueueAudio(audio_dev, data, (Uint32)(frames * 4));
  return frames;
}
static void audio_sample(int16_t l, int16_t r) {
  int16_t s[2] = { l, r };
  audio_batch(s, 1);
}

/* ---------- input ---------- */
static const Uint8 *keys;

/* While Cmd is down a shortcut is being typed: its letter is not a game button. */
static bool typing_shortcut(void) { return (SDL_GetModState() & KMOD_GUI) != 0; }

static int16_t key_button(unsigned id) {
  if (typing_shortcut()) return 0;
  switch (id) {
    case RETRO_DEVICE_ID_JOYPAD_B: return keys[SDL_SCANCODE_X];      /* N64 A */
    case RETRO_DEVICE_ID_JOYPAD_Y: return keys[SDL_SCANCODE_C];      /* N64 B */
    case RETRO_DEVICE_ID_JOYPAD_L2: return keys[SDL_SCANCODE_Z];     /* N64 Z */
    case RETRO_DEVICE_ID_JOYPAD_L: return keys[SDL_SCANCODE_Q];
    case RETRO_DEVICE_ID_JOYPAD_R: return keys[SDL_SCANCODE_E];
    case RETRO_DEVICE_ID_JOYPAD_START: return keys[SDL_SCANCODE_RETURN];
    case RETRO_DEVICE_ID_JOYPAD_SELECT: return keys[SDL_SCANCODE_RSHIFT];
    case RETRO_DEVICE_ID_JOYPAD_A: return keys[SDL_SCANCODE_V];
    case RETRO_DEVICE_ID_JOYPAD_X: return keys[SDL_SCANCODE_B];
    case RETRO_DEVICE_ID_JOYPAD_UP: return keys[SDL_SCANCODE_W];
    case RETRO_DEVICE_ID_JOYPAD_DOWN: return keys[SDL_SCANCODE_S];
    case RETRO_DEVICE_ID_JOYPAD_LEFT: return keys[SDL_SCANCODE_A];
    case RETRO_DEVICE_ID_JOYPAD_RIGHT: return keys[SDL_SCANCODE_D];
    default: return 0;
  }
}

static int16_t pad_button(unsigned port, unsigned id) {
  SDL_GameController *pad = pads[port];
  if (!pad) return 0;
  SDL_GameControllerButton b;
  switch (id) {
    case RETRO_DEVICE_ID_JOYPAD_B: b = SDL_CONTROLLER_BUTTON_A; break;
    case RETRO_DEVICE_ID_JOYPAD_Y: b = SDL_CONTROLLER_BUTTON_X; break;
    case RETRO_DEVICE_ID_JOYPAD_A: b = SDL_CONTROLLER_BUTTON_B; break;
    case RETRO_DEVICE_ID_JOYPAD_X: b = SDL_CONTROLLER_BUTTON_Y; break;
    case RETRO_DEVICE_ID_JOYPAD_L: b = SDL_CONTROLLER_BUTTON_LEFTSHOULDER; break;
    case RETRO_DEVICE_ID_JOYPAD_R: b = SDL_CONTROLLER_BUTTON_RIGHTSHOULDER; break;
    case RETRO_DEVICE_ID_JOYPAD_START: b = SDL_CONTROLLER_BUTTON_START; break;
    case RETRO_DEVICE_ID_JOYPAD_SELECT: b = SDL_CONTROLLER_BUTTON_BACK; break;
    case RETRO_DEVICE_ID_JOYPAD_UP: b = SDL_CONTROLLER_BUTTON_DPAD_UP; break;
    case RETRO_DEVICE_ID_JOYPAD_DOWN: b = SDL_CONTROLLER_BUTTON_DPAD_DOWN; break;
    case RETRO_DEVICE_ID_JOYPAD_LEFT: b = SDL_CONTROLLER_BUTTON_DPAD_LEFT; break;
    case RETRO_DEVICE_ID_JOYPAD_RIGHT: b = SDL_CONTROLLER_BUTTON_DPAD_RIGHT; break;
    case RETRO_DEVICE_ID_JOYPAD_L2: /* either trigger is the N64 Z trigger */
      return SDL_GameControllerGetAxis(pad, SDL_CONTROLLER_AXIS_TRIGGERLEFT) > 12000 || SDL_GameControllerGetAxis(pad, SDL_CONTROLLER_AXIS_TRIGGERRIGHT) > 12000;
    case RETRO_DEVICE_ID_JOYPAD_R2: return 0; /* to the N64 core this is "C buttons mode", which turns A and B off; the right stick does the C buttons */
    default: return 0;
  }
  return SDL_GameControllerGetButton(pad, b);
}

static int key_axis(SDL_Scancode neg, SDL_Scancode pos) {
  return (keys[pos] ? 0x7fff : 0) - (keys[neg] ? 0x7fff : 0);
}

static int16_t analog(unsigned port, unsigned index, unsigned id) {
  bool left = index == RETRO_DEVICE_INDEX_ANALOG_LEFT, x_axis = id == RETRO_DEVICE_ID_ANALOG_X;
  int v = 0;
  if (index != RETRO_DEVICE_INDEX_ANALOG_LEFT && index != RETRO_DEVICE_INDEX_ANALOG_RIGHT) return 0;
  if (port == 0 && !typing_shortcut()) {
    if (left) v = x_axis ? key_axis(SDL_SCANCODE_LEFT, SDL_SCANCODE_RIGHT) : key_axis(SDL_SCANCODE_UP, SDL_SCANCODE_DOWN);
    else v = x_axis ? key_axis(SDL_SCANCODE_J, SDL_SCANCODE_L) : key_axis(SDL_SCANCODE_I, SDL_SCANCODE_K); /* C buttons */
  }
  if (pads[port]) {
    SDL_GameControllerAxis ax = left ? (x_axis ? SDL_CONTROLLER_AXIS_LEFTX : SDL_CONTROLLER_AXIS_LEFTY)
                                     : (x_axis ? SDL_CONTROLLER_AXIS_RIGHTX : SDL_CONTROLLER_AXIS_RIGHTY);
    int p = SDL_GameControllerGetAxis(pads[port], ax);
    if (abs(p) > abs(v)) v = p;
  }
  return (int16_t)(v < -0x7fff ? -0x7fff : v);
}

/* Nothing to do: the main loop collects the events before every frame. (A
 * core may call this from its own stack, which is no place to run the
 * window system's event handlers.) */
static void input_poll(void) { }

static bool button(unsigned port, unsigned id) {
  return (port == 0 && key_button(id)) || pad_button(port, id);
}

static int16_t input_state(unsigned port, unsigned device, unsigned index, unsigned id) {
  if (port >= MAX_PADS) return 0;
  if (device == RETRO_DEVICE_JOYPAD) {
    if (id == RETRO_DEVICE_ID_JOYPAD_MASK) {
      unsigned mask = 0;
      for (unsigned i = 0; i < 16; i++) if (button(port, i)) mask |= 1u << i;
      return (int16_t)mask;
    }
    return button(port, id);
  }
  if (device == RETRO_DEVICE_ANALOG) return analog(port, index, id);
  return 0;
}

/* The first controller plugged in plays as player 1, the next as player 2... */
static void pad_added(int device_index) {
  SDL_JoystickID id = SDL_JoystickGetDeviceInstanceID(device_index);
  int free_slot = -1;
  for (int i = MAX_PADS - 1; i >= 0; i--) {
    if (!pads[i]) free_slot = i;
    else if (SDL_JoystickInstanceID(SDL_GameControllerGetJoystick(pads[i])) == id) return; /* already open */
  }
  if (free_slot < 0) return;
  if (!SDL_IsGameController(device_index)) {
    const char *name = SDL_JoystickNameForIndex(device_index);
    fprintf(stderr, "[player] ignoring a controller this player has no layout for: %s\n", name ? name : "(no name)");
    return;
  }
  pads[free_slot] = SDL_GameControllerOpen(device_index);
  if (pads[free_slot]) fprintf(stderr, "[player] controller %d: %s\n", free_slot + 1, SDL_GameControllerName(pads[free_slot]));
}

static void pad_removed(SDL_JoystickID id) {
  for (int i = 0; i < MAX_PADS; i++) {
    if (pads[i] && SDL_JoystickInstanceID(SDL_GameControllerGetJoystick(pads[i])) == id) {
      SDL_GameControllerClose(pads[i]);
      pads[i] = NULL;
    }
  }
}

/* ---------- environment ---------- */
static void set_geometry(const struct retro_game_geometry *g) {
  av.geometry = *g;
  if (g->aspect_ratio > 0) aspect = g->aspect_ratio;
  else if (g->base_width && g->base_height) aspect = (float)g->base_width / (float)g->base_height;
}

static bool environment(unsigned cmd, void *data) {
  switch (cmd) {
    case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
      ((struct retro_log_callback *)data)->log = core_log;
      return true;
    case RETRO_ENVIRONMENT_GET_CAN_DUPE:
      *(bool *)data = true;
      return true;
    case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
      pixel_format = *(const enum retro_pixel_format *)data;
      return pixel_format <= RETRO_PIXEL_FORMAT_RGB565;
    case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
      *(const char **)data = system_dir;
      return true;
    case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
      *(const char **)data = save_dir;
      return true;
    case RETRO_ENVIRONMENT_GET_PREFERRED_HW_RENDER:
      *(unsigned *)data = RETRO_HW_CONTEXT_OPENGL_CORE;
      return true;
    case RETRO_ENVIRONMENT_SET_HW_RENDER: {
      struct retro_hw_render_callback *cb = data;
      if (cb->context_type != RETRO_HW_CONTEXT_OPENGL_CORE && cb->context_type != RETRO_HW_CONTEXT_OPENGL) return false;
      cb->get_current_framebuffer = get_current_framebuffer;
      cb->get_proc_address = get_proc_address;
      hw = *cb;
      use_hw = true;
      return true;
    }
    case RETRO_ENVIRONMENT_SET_HW_SHARED_CONTEXT:
      return true;

    /* core options, newest form first */
    case RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION:
      *(unsigned *)data = 2;
      return true;
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2:
      opts_from_v2(data);
      return false; /* "false" only means we don't show option categories */
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2_INTL:
      opts_from_v2(((const struct retro_core_options_v2_intl *)data)->us);
      return false;
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS:
      opts_from_v1(data);
      return true;
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_INTL:
      opts_from_v1(((const struct retro_core_options_intl *)data)->us);
      return true;
    case RETRO_ENVIRONMENT_SET_VARIABLES:
      opts_from_variables(data);
      return true;
    case RETRO_ENVIRONMENT_GET_VARIABLE: {
      struct retro_variable *var = data;
      var->value = var->key ? opt_value(var->key) : NULL;
      return var->value != NULL;
    }
    case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
      *(bool *)data = false;
      return true;

    case RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME:
    case RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL:
    case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
    case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
    case RETRO_ENVIRONMENT_SET_SUBSYSTEM_INFO:
    case RETRO_ENVIRONMENT_SET_MEMORY_MAPS:
      return true;
    case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS:
      return true;
    case RETRO_ENVIRONMENT_GET_INPUT_MAX_USERS:
      *(unsigned *)data = MAX_PADS;
      return true;
    case RETRO_ENVIRONMENT_SET_GEOMETRY:
      set_geometry(data);
      return true;
    case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO:
      av = *(const struct retro_system_av_info *)data;
      set_geometry(&av.geometry);
      /* grown after the core's frame, not in the middle of its drawing */
      if (use_hw && (av.geometry.max_width > tex_w || av.geometry.max_height > tex_h)) { want_w = av.geometry.max_width; want_h = av.geometry.max_height; }
      return true;
    case RETRO_ENVIRONMENT_SET_MESSAGE: {
      const struct retro_message *m = data;
      fprintf(stderr, "[core message] %s\n", m->msg);
      return true;
    }
    case RETRO_ENVIRONMENT_SHUTDOWN:
      running = false;
      return true;
    default:
      return false;
  }
}

/* ---------- saves ---------- */
static void mkdir_p(const char *dir) {
  char tmp[1024];
  snprintf(tmp, sizeof tmp, "%s", dir);
  for (char *p = tmp + 1; *p; p++) {
    if (*p == '/') { *p = 0; mkdir(tmp, 0755); *p = '/'; }
  }
  mkdir(tmp, 0755);
}

static bool write_file(const char *path, const void *buf, size_t len) {
  char tmp[2100];
  snprintf(tmp, sizeof tmp, "%s.tmp", path);
  FILE *f = fopen(tmp, "wb");
  if (!f) return false;
  bool ok = fwrite(buf, 1, len, f) == len;
  ok = fclose(f) == 0 && ok;
  return ok && rename(tmp, path) == 0;
}

static void *read_file(const char *path, size_t *len) {
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  void *buf = n > 0 ? malloc((size_t)n) : NULL;
  if (buf && fread(buf, 1, (size_t)n, f) != (size_t)n) { free(buf); buf = NULL; }
  fclose(f);
  if (len) *len = buf ? (size_t)n : 0;
  return buf;
}

static uint64_t fnv1a(const void *buf, size_t len) {
  const unsigned char *p = buf;
  uint64_t h = 1469598103934665603ULL;
  for (size_t i = 0; i < len; i++) { h ^= p[i]; h *= 1099511628211ULL; }
  return h;
}

static uint64_t sram_saved; /* fingerprint of the battery save that is on disk */

static void load_sram(void) {
  size_t size = core.get_memory_size(RETRO_MEMORY_SAVE_RAM);
  void *mem = core.get_memory_data(RETRO_MEMORY_SAVE_RAM);
  if (!size || !mem) return;
  size_t len;
  void *buf = read_file(sram_path, &len);
  if (buf) { memcpy(mem, buf, len < size ? len : size); free(buf); }
  sram_saved = fnv1a(mem, size);
}

/* Writes the battery save, but only when the game actually changed it. */
static void save_sram(void) {
  size_t size = core.get_memory_size(RETRO_MEMORY_SAVE_RAM);
  void *mem = core.get_memory_data(RETRO_MEMORY_SAVE_RAM);
  if (!size || !mem) return;
  uint64_t h = fnv1a(mem, size);
  if (h != sram_saved && write_file(sram_path, mem, size)) sram_saved = h;
}

static void save_state(void) {
  size_t size = core.serialize_size();
  void *buf = size ? malloc(size) : NULL;
  if (buf && core_serialize(buf, size) && write_file(state_path, buf, size)) fprintf(stderr, "[player] state saved\n");
  else fprintf(stderr, "[player] the state could not be saved\n");
  free(buf);
}

static void load_state(void) {
  size_t len = 0, want = core.serialize_size();
  void *buf = read_file(state_path, &len);
  if (!buf) fprintf(stderr, "[player] there is no saved state to load\n");
  else if (len != want) fprintf(stderr, "[player] the saved state is %zu bytes instead of %zu: not loaded\n", len, want);
  else if (core_unserialize(buf, len)) fprintf(stderr, "[player] state loaded\n");
  else fprintf(stderr, "[player] the core did not take the saved state\n");
  free(buf);
}

/* ---------- main ---------- */
static void *sym(const char *name) {
  void *p = dlsym(core.handle, name);
  if (!p) die("This emulator core is missing %s.", name);
  return p;
}

static void open_core(const char *path) {
  core.handle = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  if (!core.handle) die("Could not load the emulator core: %s", dlerror());
#define S(f) *(void **)&core.f = sym("retro_" #f)
  S(init); S(deinit); S(get_system_info); S(get_system_av_info); S(set_environment); S(set_video_refresh);
  S(set_audio_sample); S(set_audio_sample_batch); S(set_input_poll); S(set_input_state);
  S(set_controller_port_device); S(run); S(reset); S(load_game); S(unload_game);
  S(serialize_size); S(serialize); S(unserialize); S(get_memory_data); S(get_memory_size);
#undef S
}

static void start_core(void) {
  core.set_environment(environment);
  core.init();
  core.set_video_refresh(video_refresh);
  core.set_audio_sample(audio_sample);
  core.set_audio_sample_batch(audio_batch);
  core.set_input_poll(input_poll);
  core.set_input_state(input_state);
}

/* Full screen has two ways in on a Mac: the player's own keys, which go
 * through SDL, and the Mac's (the green button, the Window menu), which SDL
 * does not note in the window's flags. The window itself knows both. */
static bool sdl_fullscreen(void) {
  return (SDL_GetWindowFlags(window) & SDL_WINDOW_FULLSCREEN_DESKTOP) != 0;
}

#ifdef __APPLE__
static id ns_window(void) {
  SDL_SysWMinfo info;
  SDL_VERSION(&info.version);
  return SDL_GetWindowWMInfo(window, &info) && info.subsystem == SDL_SYSWM_COCOA ? (id)info.info.cocoa.window : (id)0;
}
#endif

static bool native_fullscreen(void) {
#ifdef __APPLE__
  id w = ns_window();
  return w && (((unsigned long (*)(id, SEL))objc_msgSend)(w, sel_registerName("styleMask")) & (1UL << 14)) != 0; /* NSWindowStyleMaskFullScreen */
#else
  return false;
#endif
}

static bool in_fullscreen(void) { return sdl_fullscreen() || native_fullscreen(); }

/* Keeps SDL's flag and the mouse pointer in line with the window. Called a
 * few times a second, and before a full screen key is acted on. */
static void watch_fullscreen(void) {
  static bool was_native, pointer_hidden;
  bool flag = sdl_fullscreen(), real = native_fullscreen();
  if (flag && !real && was_native) { /* entered with the player's key, left the Mac's way */
    SDL_SetWindowFullscreen(window, 0); /* nothing moves: SDL finds the window already there */
    flag = sdl_fullscreen();
  }
  was_native = flag && real;
  if ((flag || real) != pointer_hidden) {
    pointer_hidden = flag || real;
    SDL_ShowCursor(pointer_hidden ? SDL_DISABLE : SDL_ENABLE);
  }
}

static void toggle_fullscreen(void) {
  watch_fullscreen();
  bool flag = sdl_fullscreen();
#ifdef __APPLE__
  if (!flag && native_fullscreen()) { /* entered the Mac's way: leave the same way */
    ((void (*)(id, SEL, id))objc_msgSend)(ns_window(), sel_registerName("toggleFullScreen:"), (id)0);
    return;
  }
#endif
  SDL_SetWindowFullscreen(window, flag ? 0 : SDL_WINDOW_FULLSCREEN_DESKTOP);
  watch_fullscreen();
}

/* Shows the app's icon in the Dock instead of a blank "exec" icon. */
static void set_dock_icon(const char *path) {
#ifdef __APPLE__
  id ns_string = (id)objc_getClass("NSString"), ns_image = (id)objc_getClass("NSImage"), ns_app = (id)objc_getClass("NSApplication");
  if (!path || !*path || !ns_string || !ns_image || !ns_app) return;
  id (*send)(id, SEL) = (id (*)(id, SEL))objc_msgSend;
  id (*send_str)(id, SEL, const char *) = (id (*)(id, SEL, const char *))objc_msgSend;
  id (*send_obj)(id, SEL, id) = (id (*)(id, SEL, id))objc_msgSend;
  void (*send_void)(id, SEL, id) = (void (*)(id, SEL, id))objc_msgSend;
  void (*release)(id, SEL) = (void (*)(id, SEL))objc_msgSend;
  id file = send_str(send(ns_string, sel_registerName("alloc")), sel_registerName("initWithUTF8String:"), path);
  if (!file) return;
  id image = send_obj(send(ns_image, sel_registerName("alloc")), sel_registerName("initWithContentsOfFile:"), file);
  id app = send(ns_app, sel_registerName("sharedApplication"));
  if (image && app) send_void(app, sel_registerName("setApplicationIconImage:"), image);
  if (image) release(image, sel_registerName("release"));
  release(file, sel_registerName("release"));
#else
  (void)path;
#endif
}

/* The player is started by the library app, so macOS may still treat the
 * library as the app in front. Put the game window on top regardless. The
 * library also asks for this (SIGURG) when the game is clicked again. */
static volatile sig_atomic_t front_requested;
static void on_front_request(int sig) { (void)sig; front_requested = 1; }

/* The library asks the player to stop with SIGTERM. The main loop saves and
 * leaves; if it no longer turns, the alarm ends the process regardless, so a
 * stuck player can never be left behind. */
static volatile sig_atomic_t term_requested;
static void on_term(int sig) { (void)sig; term_requested = 1; alarm(8); }

static void bring_to_front(void) {
#ifdef __APPLE__
  SDL_SysWMinfo info;
  SDL_VERSION(&info.version);
  id app = ((id (*)(id, SEL))objc_msgSend)((id)objc_getClass("NSApplication"), sel_registerName("sharedApplication"));
  if (app) ((void (*)(id, SEL, BOOL))objc_msgSend)(app, sel_registerName("activateIgnoringOtherApps:"), (BOOL)1);
  if (SDL_GetWindowWMInfo(window, &info) && info.subsystem == SDL_SYSWM_COCOA && info.info.cocoa.window)
    ((void (*)(id, SEL))objc_msgSend)((id)info.info.cocoa.window, sel_registerName("orderFrontRegardless"));
#endif
  SDL_RaiseWindow(window);
}

/* Once the game is saved, a fault or a hang while shutting down costs nothing. */
static void leave_quietly(int sig) {
  static const char msg[] = "[player] shutting down faulted or took too long (ignored)\n";
  (void)sig;
  if (write(2, msg, sizeof msg - 1) < 0) { /* nothing to do about it */ }
  _exit(exit_code);
}

int main(int argc, char **argv) {
  const char *core_path = NULL, *rom_path = NULL, *title = "Devious Licks", *icon = NULL;
  bool fullscreen = false, check_only = false;
  signal(SIGURG, on_front_request);
  signal(SIGTERM, on_term); /* before SDL starts, so SDL leaves it alone */
  for (size_t i = 0; i < sizeof builtin_overrides / sizeof builtin_overrides[0]; i++) opt_override(builtin_overrides[i][0], builtin_overrides[i][1]);
  for (int i = 1; i < argc; i++) {
    const char *a = argv[i], *v = i + 1 < argc ? argv[i + 1] : NULL;
    if (!strcmp(a, "--core") && v) core_path = argv[++i];
    else if (!strcmp(a, "--rom") && v) rom_path = argv[++i];
    else if (!strcmp(a, "--title") && v) title = argv[++i];
    else if (!strcmp(a, "--icon") && v) icon = argv[++i];
    else if (!strcmp(a, "--save-dir") && v) snprintf(save_dir, sizeof save_dir, "%s", argv[++i]);
    else if (!strcmp(a, "--system-dir") && v) snprintf(system_dir, sizeof system_dir, "%s", argv[++i]);
    else if (!strcmp(a, "--fullscreen")) fullscreen = true;
    else if (!strcmp(a, "--no-dialog")) no_dialog = true;
    else if (!strcmp(a, "--check")) { check_only = true; no_dialog = true; }
    else if (!strcmp(a, "--verbose")) log_level = RETRO_LOG_DEBUG;
    else if (!strcmp(a, "--frames") && v) { test_frames = atol(argv[++i]); no_dialog = true; }
    else if (!strcmp(a, "--gl-trace") && v) gl_trace = atol(argv[++i]);
    else if (!strcmp(a, "--gl-probe")) gl_probe = true;
    else if (!strcmp(a, "--expect-tone") && v) expect_tone = atof(argv[++i]);
    else if (!strcmp(a, "--peek") && v) { /* <hex address>[:<number of words>] */
      char *end;
      unsigned long address = strtoul(argv[++i], &end, 16);
      long words = *end == ':' ? atol(end + 1) : 1;
      for (; words > 0 && n_peeks < (int)(sizeof peeks / sizeof peeks[0]); words--, address += 4) peeks[n_peeks++] = address;
    }
    else if (!strcmp(a, "--option") && v) {
      char *kv = dupstr(argv[++i]), *eq = strchr(kv, '=');
      if (eq && eq != kv) { *eq = 0; opt_override(kv, eq + 1); }
      free(kv);
    } else if (!strcmp(a, "--expect") && v) {
      const char *e = argv[++i], *eq = strchr(e, '=');
      if (eq && eq - e < (long)sizeof expects[0].name && n_expects < (int)(sizeof expects / sizeof expects[0])) {
        memcpy(expects[n_expects].name, e, (size_t)(eq - e));
        expects[n_expects].name[eq - e] = 0;
        expects[n_expects++].rgb = (unsigned)strtoul(eq + 1, NULL, 16);
      }
    } else {
      fprintf(stderr, "[player] ignoring argument %s\n", a);
    }
  }
  if (check_only && core_path) {
    struct retro_system_info info = { 0 };
    open_core(core_path);
    core.get_system_info(&info);
    printf("[check] %s %s, plays: %s\n", info.library_name ? info.library_name : "?", info.library_version ? info.library_version : "",
           info.valid_extensions ? info.valid_extensions : "?");
    return 0;
  }
  if (!core_path || !rom_path) { fprintf(stderr, "usage: %s --core <core> --rom <file> [--title t] [--save-dir d] [--system-dir d] [--option key=value]\n", argv[0]); return 2; }

  mkdir_p(save_dir);
  mkdir_p(system_dir);
  const char *base = strrchr(rom_path, '/');
  snprintf(rom_base, sizeof rom_base, "%s", base ? base + 1 : rom_path);
  char *dot = strrchr(rom_base, '.');
  if (dot) *dot = 0;
  snprintf(sram_path, sizeof sram_path, "%s/%s.srm", save_dir, rom_base);
  snprintf(state_path, sizeof state_path, "%s/%s.state", save_dir, rom_base);

  SDL_SetHint(SDL_HINT_MAC_CTRL_CLICK_EMULATE_RIGHT_CLICK, "1");
  SDL_SetHint(SDL_HINT_VIDEO_MINIMIZE_ON_FOCUS_LOSS, "0");
  SDL_SetHint(SDL_HINT_JOYSTICK_ALLOW_BACKGROUND_EVENTS, "1"); /* a controller plays even while the library is the app in front */
  die_status = 4; /* from here to the first frame, failures mean "no window / no OpenGL here" */
  if (SDL_Init(SDL_INIT_VIDEO) != 0) die("Could not start video: %s", SDL_GetError());
  die_status = 1;
  if (SDL_InitSubSystem(SDL_INIT_AUDIO) != 0) fprintf(stderr, "[player] no audio: %s\n", SDL_GetError());
  if (SDL_InitSubSystem(SDL_INIT_GAMECONTROLLER) != 0) fprintf(stderr, "[player] no game controller support: %s\n", SDL_GetError());

  open_core(core_path);
  start_core();

  struct retro_system_info sys = { 0 };
  core.get_system_info(&sys);
  fprintf(stderr, "[player] core: %s %s\n", sys.library_name ? sys.library_name : "?", sys.library_version ? sys.library_version : "");
  struct retro_game_info game = { .path = rom_path };
  void *rom_data = NULL;
  if (!sys.need_fullpath) {
    size_t len;
    rom_data = read_file(rom_path, &len);
    if (!rom_data) die("Could not read the game file.");
    game.data = rom_data;
    game.size = len;
    /* A saved state belongs to one build of a game: a changed file starts
     * without one instead of with one the core can't use. (The battery
     * save above keeps its name, it has to survive updates.) */
    snprintf(state_path, sizeof state_path, "%s/%s-%08x.state", save_dir, rom_base, (unsigned)fnv1a(rom_data, len));
  }

  /* The window + GL context must exist before load_game for HW cores. */
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
#ifdef __APPLE__
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_FLAGS, SDL_GL_CONTEXT_FORWARD_COMPATIBLE_FLAG);
#endif
  SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER, 1);
  SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 24);
  SDL_GL_SetAttribute(SDL_GL_STENCIL_SIZE, 8);
  die_status = 4;
  window = SDL_CreateWindow(title, SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, 960, 720,
                            SDL_WINDOW_OPENGL | SDL_WINDOW_RESIZABLE | SDL_WINDOW_ALLOW_HIGHDPI);
  if (!window) die("Could not open the game window: %s", SDL_GetError());
  SDL_StopTextInput(); /* game keys are not text: keep the Mac's input methods out of it */
  glctx = SDL_GL_CreateContext(window);
  if (!glctx) die("Your Mac's graphics driver couldn't start OpenGL: %s", SDL_GetError());
  SDL_GL_MakeCurrent(window, glctx);
  SDL_GL_SetSwapInterval(0); /* the loop below does the pacing */
  if (!load_gl()) die("Your Mac's graphics driver is missing features this game needs.");
  die_status = 1;
  fprintf(stderr, "[player] OpenGL %s, %s\n", (const char *)glGetString_(GL_VERSION), (const char *)glGetString_(GL_RENDERER));
  {
    int ww = 0, wh = 0, dw = 0, dh = 0;
    SDL_GetWindowSize(window, &ww, &wh);
    SDL_GL_GetDrawableSize(window, &dw, &dh);
    fprintf(stderr, "[player] window %dx%d, drawn at %dx%d\n", ww, wh, dw, dh);
  }
  set_dock_icon(icon);
  glClearColor_(0, 0, 0, 1);
  glClear_(GL_COLOR_BUFFER_BIT);
  SDL_GL_SwapWindow(window);
  bring_to_front();
  if (gl_trace) tr_start();

  if (!core_load_game(&game)) die("The emulator couldn't start this game file.");
  core.get_system_av_info(&av);
  set_geometry(&av.geometry);
  if (use_hw) {
    create_hw_fbo(av.geometry.max_width ? av.geometry.max_width : 1920, av.geometry.max_height ? av.geometry.max_height : 1440);
    if (gl_trace) {
      fprintf(stderr, "[gl] the player's framebuffer is %u: texture %u, %ux%u, with a depth%s buffer\n", fbo, fbo_tex, tex_w, tex_h, hw.stencil ? " and stencil" : "");
      tr_window("the core sets up its graphics", 0, false);
    }
    if (hw.context_reset) core_context_reset();
    if (gl_trace) tr_window(NULL, 0, false);
  }
  load_sram();
  fprintf(stderr, "[player] video %ux%u at %.2f fps, audio %.0f Hz, %s rendering\n", av.geometry.base_width, av.geometry.base_height,
          av.timing.fps, av.timing.sample_rate, use_hw ? "hardware" : "software");

  SDL_AudioSpec want = { 0 }, have;
  want.freq = (int)(av.timing.sample_rate > 0 ? av.timing.sample_rate : 44100);
  audio_rate = want.freq;
  want.format = AUDIO_S16SYS;
  want.channels = 2;
  want.samples = 512;
  audio_dev = SDL_OpenAudioDevice(NULL, 0, &want, &have, 0);
  if (!audio_dev) fprintf(stderr, "[player] no audio device: %s\n", SDL_GetError());

  keys = SDL_GetKeyboardState(NULL);
  if (fullscreen) toggle_fullscreen();

  /* Frames are paced by the clock. The audio queue is the fine control: it is
   * buffered a little before it starts playing, and the loop runs 2% faster
   * or slower to keep it between the low and high marks. */
  const double fps = av.timing.fps > 0 ? av.timing.fps : 60.0;
  const Uint32 ms_bytes = (Uint32)(want.freq * 4 / 1000);
  const Uint32 q_start = 50 * ms_bytes, q_low = 30 * ms_bytes, q_high = 80 * ms_bytes, q_cap = 250 * ms_bytes;
  const Uint64 freq = SDL_GetPerformanceFrequency();
  const Uint64 frame_ticks = (Uint64)((double)freq / fps);
  const Uint64 started = SDL_GetPerformanceCounter();
  Uint64 next = started;
  Uint32 last_sram = SDL_GetTicks(), stall_level = 0;
  long frame_no = 0;
  Uint64 play_from = started, report_from = started; /* the speed lines in the log: one after 10 s, then one a minute */
  Uint64 report_at = started + 10 * freq;
  long report_frame = 0;
  bool focus_logged = false;

  while (running) {
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
      if (e.type == SDL_QUIT) running = false;
      else if (e.type == SDL_CONTROLLERDEVICEADDED) pad_added(e.cdevice.which);
      else if (e.type == SDL_CONTROLLERDEVICEREMOVED) pad_removed(e.cdevice.which);
      else if (e.type == SDL_KEYDOWN && !e.key.repeat) {
        SDL_Keycode k = e.key.keysym.sym;
#if defined(__APPLE__) || defined(DL_MAC_KEYS) /* (the second one: to try the Mac's rules on another system) */
        bool cmd = (e.key.keysym.mod & KMOD_GUI) != 0; /* Ctrl is not a shortcut key on a Mac, and it sits next to the game keys */
        /* Ctrl+Cmd+F is the Window menu's own "Toggle Full Screen" for as long as SDL offers it. */
        bool menu_does_it = k == SDLK_f && (e.key.keysym.mod & KMOD_CTRL) && !sdl_fullscreen();
#else
        bool cmd = (e.key.keysym.mod & (KMOD_GUI | KMOD_CTRL)) != 0;
        bool menu_does_it = false;
#endif
        if (k == SDLK_F11 || (cmd && k == SDLK_f)) { if (!menu_does_it) toggle_fullscreen(); }
        else if (k == SDLK_ESCAPE) {
          watch_fullscreen();
          if (in_fullscreen()) toggle_fullscreen();
          else running = false;
        } else if (cmd && (k == SDLK_q || k == SDLK_w)) running = false;
        else if (k == SDLK_F5 || (cmd && k == SDLK_s)) save_state();
        else if (k == SDLK_F9 || (cmd && k == SDLK_l)) load_state();
        else if (k == SDLK_F8 && gl_trace) tr_request = true;
        else if (cmd && k == SDLK_r) core_reset();
      }
    }
    if (term_requested) running = false;
    if (!running) break;
    if (front_requested) { front_requested = 0; bring_to_front(); }
    if (frame_no % 20 == 10) watch_fullscreen();
    if (!focus_logged && frame_no == 30) {
      /* Started by another app, the window may be on top without having the keyboard. */
      bool focused = (SDL_GetWindowFlags(window) & SDL_WINDOW_INPUT_FOCUS) != 0;
      focus_logged = true;
      if (!focused && !test_frames) bring_to_front();
      fprintf(stderr, "[player] the game window %s\n", focused ? "has the keyboard" : "did not have the keyboard after half a second: asked for it again");
    }

    frame_ready = false;
    frame_no++;
    bool recorded = gl_trace && (frame_no <= gl_trace || frame_no == test_frames || tr_request);
    if (tr_request) { tr_request = false; tr_failures = tr_unseen = tr_n_seen = 0; } /* start counting afresh */
    if (gl_trace) tr_window(recorded ? "frame" : NULL, frame_no, recorded);
    if (frame_no == 1) {
      /* The first frame can take seconds: the core prepares every shader the
       * game used before. Say so where it can be seen, and measure it. */
      char busy[600];
      snprintf(busy, sizeof busy, "%s - preparing graphics...", title);
      SDL_SetWindowTitle(window, busy);
      SDL_PumpEvents();
      Uint64 t0 = SDL_GetPerformanceCounter();
      core_run();
      Uint64 t1 = SDL_GetPerformanceCounter();
      SDL_SetWindowTitle(window, title);
      fprintf(stderr, "[player] the first frame took %.0f ms\n", (double)(t1 - t0) * 1000.0 / (double)freq);
      play_from = report_from = t1; /* speed is measured from here */
      report_at = t1 + 10 * freq;
      report_frame = 1;
    } else core_run();
    if (gl_trace) {
      tr_pending("the end of the frame");
      if (recorded) tr_survey();
      tr_window(NULL, 0, false);
    }
    if (want_w) { create_hw_fbo(want_w, want_h); want_w = want_h = 0; }
    if (test_frames && frame_no == 1) peek_report("after frame 1");

    if (test_frames && frame_no >= test_frames) {
      unsigned core_error = (unsigned)glGetError_();
      while (glGetError_()) { } /* a driver may hold more than one */
      draw_frame();
      if (gl_trace) tr_summary();
      exit_code = selftest_report((double)(SDL_GetPerformanceCounter() - started) / (double)freq, core_error);
      SDL_GL_SwapWindow(window);
      break;
    }
    if (frame_ready || use_hw) present();

    Uint64 step = frame_ticks;
    if (audio_dev) {
      Uint32 queued = SDL_GetQueuedAudioSize(audio_dev);
      if (audio_stalled) {
        if (queued < stall_level) { /* the device takes sound again: start afresh */
          SDL_PauseAudioDevice(audio_dev, 1);
          SDL_ClearQueuedAudio(audio_dev);
          audio_stalled = audio_playing = false;
          fprintf(stderr, "[player] the sound device is taking sound again\n");
        }
      } else {
        if (!audio_playing && queued >= q_start) { SDL_PauseAudioDevice(audio_dev, 0); audio_playing = true; }
        else if (audio_playing && queued == 0) { SDL_PauseAudioDevice(audio_dev, 1); audio_playing = false; audio_dry_count++; } /* ran dry: rebuffer */
        if (audio_playing && queued > q_high) step += frame_ticks / 50;
        else if (audio_playing && queued < q_low) step -= frame_ticks / 50;
      }
    }
    next += step;
    Uint64 now = SDL_GetPerformanceCounter();
    if (now < next) {
      Uint32 ms = (Uint32)((next - now) * 1000 / freq);
      if (ms > 1) SDL_Delay(ms - 1);
      while (SDL_GetPerformanceCounter() < next) { }
    } else if (now - next > 3 * frame_ticks) {
      next = now; /* fell behind by more than the sound queue holds (a hitch, a window drag): carry on from here, don't fast-forward */
    }
    /* More sound waiting than a quarter of a second: let the device catch
     * up. But a device that has stopped taking sound (the output is being
     * switched, the Mac just woke up) must not stop the game with it. */
    if (audio_playing && !audio_stalled) {
      Uint32 waited = SDL_GetTicks(), q;
      while ((q = SDL_GetQueuedAudioSize(audio_dev)) > q_cap) {
        if (SDL_GetTicks() - waited >= 250) {
          audio_stalled = true;
          stall_level = q;
          fprintf(stderr, "[player] the sound device has stopped taking sound: carrying on without it\n");
          break;
        }
        SDL_Delay(1);
      }
    }
    if (!test_frames && SDL_GetPerformanceCounter() >= report_at) {
      Uint64 t = SDL_GetPerformanceCounter();
      double secs = (double)(t - report_from) / (double)freq;
      fprintf(stderr, "[player] speed: %ld frames in %.1f s, %.0f%% of full speed; the sound ran dry %ld time%s so far\n", frame_no - report_frame, secs,
              secs > 0 ? 100.0 * (double)(frame_no - report_frame) / (secs * fps) : 0.0, audio_dry_count, audio_dry_count == 1 ? "" : "s");
      report_frame = frame_no;
      report_from = t;
      report_at = t + 60 * freq;
    }

    if (SDL_GetTicks() - last_sram > 10000) { save_sram(); last_sram = SDL_GetTicks(); }
  }

  save_sram();
  /* The game is saved. Shutting the core down lets it store its shader cache,
   * but if it, the sound device or the window faults or hangs on the way out
   * there is nothing left to lose. */
  signal(SIGSEGV, leave_quietly);
  signal(SIGBUS, leave_quietly);
  signal(SIGILL, leave_quietly);
  signal(SIGABRT, leave_quietly);
  signal(SIGALRM, leave_quietly);
  alarm(audio_stalled ? 2 : 5); /* closing a sound device that has stopped can take for ever */
  if (!test_frames && frame_no > 1) {
    double secs = (double)(SDL_GetPerformanceCounter() - play_from) / (double)freq;
    fprintf(stderr, "[player] played %ld frames in %.1f s (%.0f%% of full speed over the whole session); the sound ran dry %ld time%s\n", frame_no - 1, secs,
            secs > 0 ? 100.0 * (double)(frame_no - 1) / (secs * fps) : 0.0, audio_dry_count, audio_dry_count == 1 ? "" : "s");
  }
  if (audio_dev) SDL_CloseAudioDevice(audio_dev);
  core_shutdown();
  free(rom_data);
  SDL_GL_DeleteContext(glctx);
  SDL_DestroyWindow(window);
  SDL_Quit();
  return exit_code;
}
