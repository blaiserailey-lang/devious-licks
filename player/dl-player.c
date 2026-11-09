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
 *   dl-player --check --core <core.dylib>   load the core, print what it is, exit
 *
 * Exit codes: 0 fine, 1 error, 2 bad usage, 3 self-test mismatch,
 * 4 this machine can't open a window with OpenGL 3.3.
 *
 * Keys: arrows = analog stick, X = A, C = B, Z = Z trigger, Q/E = L/R,
 * Enter = Start, I/J/K/L = C buttons, W/A/S/D = D-pad, F5 = save state,
 * F9 = load state, Cmd+F / F11 = fullscreen, Cmd+R = reset,
 * Esc = leave fullscreen (or quit when windowed).
 * Game controllers: the first one plays as player 1 (with the keyboard),
 * the next ones as players 2 to 4.
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
GLFN(void, glColorMask, (unsigned char, unsigned char, unsigned char, unsigned char))
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
static unsigned long n_hw_frames, n_sw_frames, n_audio_frames;

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

/* ---------- video ---------- */
static uintptr_t get_current_framebuffer(void) { return fbo; }
static retro_proc_address_t get_proc_address(const char *sym) { return (retro_proc_address_t)SDL_GL_GetProcAddress(sym); }

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

/* Reads back what draw_frame() just drew (before the swap) at the middle of
 * each quarter of the picture and at its centre, then checks --expect. */
static int selftest_report(double seconds) {
  static const char *const names[5] = { "tl", "tr", "bl", "br", "c" };
  static const float px[5] = { 0.25f, 0.75f, 0.25f, 0.75f, 0.5f };
  static const float py[5] = { 0.75f, 0.75f, 0.25f, 0.25f, 0.5f }; /* GL's y runs upward */
  unsigned got[5];
  int failed = 0;
  glBindFramebuffer_(GL_READ_FRAMEBUFFER, 0);
  glReadBuffer_(GL_BACK);
  for (int i = 0; i < 5; i++) got[i] = read_px(view_x + (int)(view_w * px[i]), view_y + (int)(view_h * py[i]));
  printf("[selftest] frames=%ld seconds=%.2f hw_frames=%lu sw_frames=%lu audio_frames=%lu picture=%ux%u view=%dx%d gl_error=0x%x\n",
         test_frames, seconds, n_hw_frames, n_sw_frames, n_audio_frames, fb_w, fb_h, view_w, view_h, (unsigned)glGetError_());
  printf("[selftest] screen tl=%06x tr=%06x bl=%06x br=%06x c=%06x\n", got[0], got[1], got[2], got[3], got[4]);
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

static size_t audio_batch(const int16_t *data, size_t frames) {
  n_audio_frames += frames;
  if (audio_dev) SDL_QueueAudio(audio_dev, data, (Uint32)(frames * 4));
  return frames;
}
static void audio_sample(int16_t l, int16_t r) {
  int16_t s[2] = { l, r };
  audio_batch(s, 1);
}

/* ---------- input ---------- */
static const Uint8 *keys;

static int16_t key_button(unsigned id) {
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
    case RETRO_DEVICE_ID_JOYPAD_L2: return SDL_GameControllerGetAxis(pad, SDL_CONTROLLER_AXIS_TRIGGERLEFT) > 12000;
    case RETRO_DEVICE_ID_JOYPAD_R2: return SDL_GameControllerGetAxis(pad, SDL_CONTROLLER_AXIS_TRIGGERRIGHT) > 12000;
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
  if (port == 0) {
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

static void input_poll(void) { SDL_PumpEvents(); }

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
  if (free_slot < 0 || !SDL_IsGameController(device_index)) return;
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
  if (buf && core.serialize(buf, size) && write_file(state_path, buf, size)) fprintf(stderr, "[player] state saved\n");
  free(buf);
}

static void load_state(void) {
  size_t len;
  void *buf = read_file(state_path, &len);
  if (buf && core.unserialize(buf, len)) fprintf(stderr, "[player] state loaded\n");
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

static void toggle_fullscreen(void) {
  bool fs = SDL_GetWindowFlags(window) & SDL_WINDOW_FULLSCREEN_DESKTOP;
  SDL_SetWindowFullscreen(window, fs ? 0 : SDL_WINDOW_FULLSCREEN_DESKTOP);
  SDL_ShowCursor(fs ? SDL_ENABLE : SDL_DISABLE);
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

/* Once the game is saved, a fault while the core shuts down costs nothing. */
static void leave_quietly(int sig) {
  static const char msg[] = "[player] the core faulted while shutting down (ignored)\n";
  (void)sig;
  if (write(2, msg, sizeof msg - 1) < 0) { /* nothing to do about it */ }
  _exit(exit_code);
}

int main(int argc, char **argv) {
  const char *core_path = NULL, *rom_path = NULL, *title = "Devious Licks", *icon = NULL;
  bool fullscreen = false, check_only = false;
  signal(SIGURG, on_front_request);
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
  glctx = SDL_GL_CreateContext(window);
  if (!glctx) die("Your Mac's graphics driver couldn't start OpenGL: %s", SDL_GetError());
  SDL_GL_MakeCurrent(window, glctx);
  SDL_GL_SetSwapInterval(0); /* the loop below does the pacing */
  if (!load_gl()) die("Your Mac's graphics driver is missing features this game needs.");
  die_status = 1;
  fprintf(stderr, "[player] OpenGL %s, %s\n", (const char *)glGetString_(GL_VERSION), (const char *)glGetString_(GL_RENDERER));
  set_dock_icon(icon);
  glClearColor_(0, 0, 0, 1);
  glClear_(GL_COLOR_BUFFER_BIT);
  SDL_GL_SwapWindow(window);
  bring_to_front();

  if (!core.load_game(&game)) die("The emulator couldn't start this game file.");
  core.get_system_av_info(&av);
  set_geometry(&av.geometry);
  if (use_hw) {
    create_hw_fbo(av.geometry.max_width ? av.geometry.max_width : 1920, av.geometry.max_height ? av.geometry.max_height : 1440);
    if (hw.context_reset) hw.context_reset();
  }
  load_sram();
  fprintf(stderr, "[player] video %ux%u at %.2f fps, audio %.0f Hz, %s rendering\n", av.geometry.base_width, av.geometry.base_height,
          av.timing.fps, av.timing.sample_rate, use_hw ? "hardware" : "software");

  SDL_AudioSpec want = { 0 }, have;
  want.freq = (int)(av.timing.sample_rate > 0 ? av.timing.sample_rate : 44100);
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
  Uint32 last_sram = SDL_GetTicks();
  long frame_no = 0;

  while (running) {
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
      if (e.type == SDL_QUIT) running = false;
      else if (e.type == SDL_CONTROLLERDEVICEADDED) pad_added(e.cdevice.which);
      else if (e.type == SDL_CONTROLLERDEVICEREMOVED) pad_removed(e.cdevice.which);
      else if (e.type == SDL_KEYDOWN && !e.key.repeat) {
        SDL_Keycode k = e.key.keysym.sym;
        bool cmd = e.key.keysym.mod & (KMOD_GUI | KMOD_CTRL);
        if (k == SDLK_F11 || (cmd && k == SDLK_f)) toggle_fullscreen();
        else if (k == SDLK_ESCAPE) {
          if (SDL_GetWindowFlags(window) & SDL_WINDOW_FULLSCREEN_DESKTOP) toggle_fullscreen();
          else running = false;
        } else if (cmd && (k == SDLK_q || k == SDLK_w)) running = false;
        else if (k == SDLK_F5) save_state();
        else if (k == SDLK_F9) load_state();
        else if (cmd && k == SDLK_r) core.reset();
      }
    }
    if (!running) break;
    if (front_requested) { front_requested = 0; bring_to_front(); }

    frame_ready = false;
    core.run();
    frame_no++;
    if (want_w) { create_hw_fbo(want_w, want_h); want_w = want_h = 0; }

    if (test_frames && frame_no >= test_frames) {
      draw_frame();
      exit_code = selftest_report((double)(SDL_GetPerformanceCounter() - started) / (double)freq);
      SDL_GL_SwapWindow(window);
      break;
    }
    if (frame_ready || use_hw) present();

    Uint64 step = frame_ticks;
    if (audio_dev) {
      Uint32 queued = SDL_GetQueuedAudioSize(audio_dev);
      if (!audio_playing && queued >= q_start) { SDL_PauseAudioDevice(audio_dev, 0); audio_playing = true; }
      else if (audio_playing && queued == 0) { SDL_PauseAudioDevice(audio_dev, 1); audio_playing = false; } /* ran dry: rebuffer */
      if (audio_playing && queued > q_high) step += frame_ticks / 50;
      else if (audio_playing && queued < q_low) step -= frame_ticks / 50;
    }
    next += step;
    Uint64 now = SDL_GetPerformanceCounter();
    if (now < next) {
      Uint32 ms = (Uint32)((next - now) * 1000 / freq);
      if (ms > 1) SDL_Delay(ms - 1);
      while (SDL_GetPerformanceCounter() < next) { }
    } else if (now - next > freq / 4) {
      next = now; /* fell far behind (e.g. window dragged): resync */
    }
    while (audio_playing && SDL_GetQueuedAudioSize(audio_dev) > q_cap) SDL_Delay(1);

    if (SDL_GetTicks() - last_sram > 10000) { save_sram(); last_sram = SDL_GetTicks(); }
  }

  save_sram();
  if (audio_dev) SDL_CloseAudioDevice(audio_dev);
  /* The game is saved. Shutting the core down lets it store its shader cache,
   * but if it faults or hangs while doing so there is nothing left to lose. */
  signal(SIGSEGV, leave_quietly);
  signal(SIGBUS, leave_quietly);
  signal(SIGILL, leave_quietly);
  signal(SIGABRT, leave_quietly);
  signal(SIGALRM, leave_quietly);
  alarm(5);
  core.unload_game();
  core.deinit();
  alarm(0);
  free(rom_data);
  SDL_GL_DeleteContext(glctx);
  SDL_DestroyWindow(window);
  SDL_Quit();
  return exit_code;
}
