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
 *
 * Keys: arrows = analog stick, X = A, C = B, Z = Z trigger, Q/E = L/R,
 * Enter = Start, I/J/K/L = C buttons, F5 = save state, F9 = load state,
 * Cmd+F / F11 = fullscreen, Esc = leave fullscreen (or quit when windowed).
 */
#include <SDL.h>
#include <dlfcn.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

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

static bool load_gl(void) {
#define LOAD(name) if (!(name##_ = (PFN_##name)SDL_GL_GetProcAddress(#name))) { fprintf(stderr, "[player] missing GL function %s\n", #name); return false; }
  LOAD(glGenFramebuffers) LOAD(glDeleteFramebuffers) LOAD(glBindFramebuffer) LOAD(glFramebufferTexture2D)
  LOAD(glGenRenderbuffers) LOAD(glDeleteRenderbuffers) LOAD(glBindRenderbuffer) LOAD(glRenderbufferStorage)
  LOAD(glFramebufferRenderbuffer) LOAD(glCheckFramebufferStatus) LOAD(glBlitFramebuffer)
  LOAD(glGenTextures) LOAD(glDeleteTextures) LOAD(glBindTexture) LOAD(glTexImage2D) LOAD(glTexSubImage2D)
  LOAD(glTexParameteri) LOAD(glPixelStorei) LOAD(glViewport) LOAD(glClearColor) LOAD(glClear)
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
static SDL_Window *window;
static SDL_GLContext glctx;
static SDL_AudioDeviceID audio_dev;
static SDL_GameController *pad;
static struct retro_hw_render_callback hw;
static bool use_hw;
static enum retro_pixel_format pixel_format = RETRO_PIXEL_FORMAT_0RGB1555;
static struct retro_system_av_info av;
static GLuint fbo, fbo_tex, fbo_depth;
static GLuint sw_tex, sw_fbo;
static unsigned fb_w, fb_h;           /* size of the last frame */
static unsigned tex_w, tex_h;         /* allocated FBO / texture size */
static float aspect = 4.0f / 3.0f;
static bool frame_ready;
static bool running = true;
static char save_dir[1024] = ".";
static char system_dir[1024] = ".";
static char sram_path[2048];
static char state_path[2048];
static char rom_base[512] = "game";

/* Options handed to the core. Anything not listed uses the core's default. */
static const struct { const char *key, *value; } options[] = {
  { "mupen64plus-rdp-plugin", "gliden64" },
  { "mupen64plus-rsp-plugin", "hle" },
  { "mupen64plus-cpucore", "cached_interpreter" },
  { "mupen64plus-43screensize", "960x720" },
  { "mupen64plus-BilinearMode", "standard" },
  { "mupen64plus-MultiSampling", "0" },
  { "mupen64plus-EnableFBEmulation", "True" },
  { "mupen64plus-EnableOverscan", "Enabled" },
  { "mupen64plus-OverscanTop", "0" },
  { "mupen64plus-OverscanBottom", "0" },
  { "mupen64plus-OverscanLeft", "0" },
  { "mupen64plus-OverscanRight", "0" },
  { "mupen64plus-pak1", "memory" },
  { NULL, NULL },
};

static void die(const char *fmt, ...) {
  char buf[1024];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  fprintf(stderr, "[player] %s\n", buf);
  SDL_ShowSimpleMessageBox(SDL_MESSAGEBOX_ERROR, "Devious Licks", buf, window);
  exit(1);
}

static void core_log(enum retro_log_level level, const char *fmt, ...) {
  if (level < RETRO_LOG_INFO) return;
  va_list ap;
  va_start(ap, fmt);
  fprintf(stderr, "[core] ");
  vfprintf(stderr, fmt, ap);
  va_end(ap);
}

/* ---------- video ---------- */
static uintptr_t get_current_framebuffer(void) { return fbo; }
static retro_proc_address_t get_proc_address(const char *sym) { return (retro_proc_address_t)SDL_GL_GetProcAddress(sym); }

static void create_hw_fbo(unsigned w, unsigned h) {
  if (fbo) { glDeleteFramebuffers_(1, &fbo); glDeleteTextures_(1, &fbo_tex); if (fbo_depth) glDeleteRenderbuffers_(1, &fbo_depth); }
  fbo = fbo_tex = fbo_depth = 0;
  tex_w = w; tex_h = h;
  glGenTextures_(1, &fbo_tex);
  glBindTexture_(GL_TEXTURE_2D, fbo_tex);
  glTexImage2D_(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
  glTexParameteri_(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri_(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glGenFramebuffers_(1, &fbo);
  glBindFramebuffer_(GL_FRAMEBUFFER, fbo);
  glFramebufferTexture2D_(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, fbo_tex, 0);
  if (hw.depth) {
    glGenRenderbuffers_(1, &fbo_depth);
    glBindRenderbuffer_(GL_RENDERBUFFER, fbo_depth);
    glRenderbufferStorage_(GL_RENDERBUFFER, hw.stencil ? GL_DEPTH24_STENCIL8 : GL_DEPTH_COMPONENT24, w, h);
    glFramebufferRenderbuffer_(GL_FRAMEBUFFER, hw.stencil ? GL_DEPTH_STENCIL_ATTACHMENT : GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, fbo_depth);
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
  glTexImage2D_(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
  glGenFramebuffers_(1, &sw_fbo);
  glBindFramebuffer_(GL_READ_FRAMEBUFFER, sw_fbo);
  glFramebufferTexture2D_(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, sw_tex, 0);
  glBindFramebuffer_(GL_READ_FRAMEBUFFER, 0);
}

static void video_refresh(const void *data, unsigned w, unsigned h, size_t pitch) {
  if (!data) return; /* duped frame: keep showing the last one */
  fb_w = w; fb_h = h;
  if (data != RETRO_HW_FRAME_BUFFER_VALID) {
    unsigned bpp = pixel_format == RETRO_PIXEL_FORMAT_XRGB8888 ? 4 : 2;
    ensure_sw_texture(w, h);
    glBindTexture_(GL_TEXTURE_2D, sw_tex);
    glPixelStorei_(GL_UNPACK_ALIGNMENT, 1);
    glPixelStorei_(GL_UNPACK_ROW_LENGTH, (GLint)(pitch / bpp));
    if (pixel_format == RETRO_PIXEL_FORMAT_XRGB8888)
      glTexSubImage2D_(GL_TEXTURE_2D, 0, 0, 0, w, h, GL_BGRA, GL_UNSIGNED_INT_8_8_8_8_REV, data);
    else if (pixel_format == RETRO_PIXEL_FORMAT_RGB565)
      glTexSubImage2D_(GL_TEXTURE_2D, 0, 0, 0, w, h, GL_RGB, GL_UNSIGNED_SHORT_5_6_5, data);
    else
      glTexSubImage2D_(GL_TEXTURE_2D, 0, 0, 0, w, h, GL_BGRA, GL_UNSIGNED_SHORT_1_5_5_5_REV, data);
    glPixelStorei_(GL_UNPACK_ROW_LENGTH, 0);
  }
  frame_ready = true;
}

static void present(void) {
  int dw, dh;
  SDL_GL_GetDrawableSize(window, &dw, &dh);
  glBindFramebuffer_(GL_DRAW_FRAMEBUFFER, 0);
  glViewport_(0, 0, dw, dh);
  glClearColor_(0, 0, 0, 1);
  glClear_(GL_COLOR_BUFFER_BIT);
  if (fb_w && fb_h) {
    /* letterbox to the core's aspect ratio */
    int vw = dw, vh = (int)(dw / aspect);
    if (vh > dh) { vh = dh; vw = (int)(dh * aspect); }
    int x = (dw - vw) / 2, y = (dh - vh) / 2;
    if (use_hw) {
      glBindFramebuffer_(GL_READ_FRAMEBUFFER, fbo);
      /* bottom_left_origin = standard GL; otherwise the image is upside down */
      if (hw.bottom_left_origin)
        glBlitFramebuffer_(0, 0, fb_w, fb_h, x, y, x + vw, y + vh, GL_COLOR_BUFFER_BIT, GL_LINEAR);
      else
        glBlitFramebuffer_(0, 0, fb_w, fb_h, x, y + vh, x + vw, y, GL_COLOR_BUFFER_BIT, GL_LINEAR);
    } else {
      glBindFramebuffer_(GL_READ_FRAMEBUFFER, sw_fbo);
      glBlitFramebuffer_(0, 0, fb_w, fb_h, x, y + vh, x + vw, y, GL_COLOR_BUFFER_BIT, GL_NEAREST);
    }
    glBindFramebuffer_(GL_READ_FRAMEBUFFER, 0);
  }
  SDL_GL_SwapWindow(window);
}

/* ---------- audio ---------- */
static size_t audio_batch(const int16_t *data, size_t frames) {
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

static int16_t pad_button(unsigned id) {
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

static int16_t key_axis(SDL_Scancode neg, SDL_Scancode pos) {
  return (int16_t)((keys[pos] ? 0x7fff : 0) - (keys[neg] ? 0x7fff : 0));
}

static int16_t analog(unsigned index, unsigned id) {
  int16_t v = 0;
  if (index == RETRO_DEVICE_INDEX_ANALOG_LEFT)
    v = id == RETRO_DEVICE_ID_ANALOG_X ? key_axis(SDL_SCANCODE_LEFT, SDL_SCANCODE_RIGHT) : key_axis(SDL_SCANCODE_UP, SDL_SCANCODE_DOWN);
  else if (index == RETRO_DEVICE_INDEX_ANALOG_RIGHT) /* C buttons */
    v = id == RETRO_DEVICE_ID_ANALOG_X ? key_axis(SDL_SCANCODE_J, SDL_SCANCODE_L) : key_axis(SDL_SCANCODE_I, SDL_SCANCODE_K);
  if (pad) {
    SDL_GameControllerAxis ax = index == RETRO_DEVICE_INDEX_ANALOG_LEFT
      ? (id == RETRO_DEVICE_ID_ANALOG_X ? SDL_CONTROLLER_AXIS_LEFTX : SDL_CONTROLLER_AXIS_LEFTY)
      : (id == RETRO_DEVICE_ID_ANALOG_X ? SDL_CONTROLLER_AXIS_RIGHTX : SDL_CONTROLLER_AXIS_RIGHTY);
    int16_t p = SDL_GameControllerGetAxis(pad, ax);
    if (abs(p) > abs(v)) v = p;
  }
  return v;
}

static void input_poll(void) { SDL_PumpEvents(); }

static int16_t input_state(unsigned port, unsigned device, unsigned index, unsigned id) {
  if (port != 0) return 0;
  if (device == RETRO_DEVICE_JOYPAD) {
    if (id == RETRO_DEVICE_ID_JOYPAD_MASK) {
      int16_t mask = 0;
      for (unsigned i = 0; i < 16; i++) if (key_button(i) || pad_button(i)) mask |= (int16_t)(1 << i);
      return mask;
    }
    return key_button(id) || pad_button(id);
  }
  if (device == RETRO_DEVICE_ANALOG) return analog(index, id);
  return 0;
}

/* ---------- environment ---------- */
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
    case RETRO_ENVIRONMENT_GET_VARIABLE: {
      struct retro_variable *var = data;
      for (int i = 0; options[i].key; i++) {
        if (strcmp(options[i].key, var->key) == 0) { var->value = options[i].value; return true; }
      }
      var->value = NULL;
      return false;
    }
    case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
      *(bool *)data = false;
      return true;
    case RETRO_ENVIRONMENT_SET_VARIABLES:
    case RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME:
    case RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL:
    case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
    case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
    case RETRO_ENVIRONMENT_SET_SUBSYSTEM_INFO:
    case RETRO_ENVIRONMENT_SET_MEMORY_MAPS:
      return true;
    case RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION:
      *(unsigned *)data = 0; /* core falls back to SET_VARIABLES / GET_VARIABLE */
      return true;
    case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS:
      return true;
    case RETRO_ENVIRONMENT_SET_GEOMETRY: {
      const struct retro_game_geometry *g = data;
      av.geometry = *g;
      aspect = g->aspect_ratio > 0 ? g->aspect_ratio : (float)g->base_width / g->base_height;
      return true;
    }
    case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO:
      av = *(const struct retro_system_av_info *)data;
      aspect = av.geometry.aspect_ratio > 0 ? av.geometry.aspect_ratio : (float)av.geometry.base_width / av.geometry.base_height;
      if (use_hw && (av.geometry.max_width > tex_w || av.geometry.max_height > tex_h)) create_hw_fbo(av.geometry.max_width, av.geometry.max_height);
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

static void load_sram(void) {
  size_t size = core.get_memory_size(RETRO_MEMORY_SAVE_RAM);
  void *mem = core.get_memory_data(RETRO_MEMORY_SAVE_RAM);
  if (!size || !mem) return;
  size_t len;
  void *buf = read_file(sram_path, &len);
  if (buf) { memcpy(mem, buf, len < size ? len : size); free(buf); }
}

static void save_sram(void) {
  size_t size = core.get_memory_size(RETRO_MEMORY_SAVE_RAM);
  void *mem = core.get_memory_data(RETRO_MEMORY_SAVE_RAM);
  if (size && mem) write_file(sram_path, mem, size);
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

static void load_core(const char *path) {
  core.handle = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  if (!core.handle) die("Could not load the emulator core: %s", dlerror());
#define S(f) *(void **)&core.f = sym("retro_" #f)
  S(init); S(deinit); S(get_system_info); S(get_system_av_info); S(set_environment); S(set_video_refresh);
  S(set_audio_sample); S(set_audio_sample_batch); S(set_input_poll); S(set_input_state);
  S(set_controller_port_device); S(run); S(reset); S(load_game); S(unload_game);
  S(serialize_size); S(serialize); S(unserialize); S(get_memory_data); S(get_memory_size);
#undef S
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

int main(int argc, char **argv) {
  const char *core_path = NULL, *rom_path = NULL, *title = "Devious Licks";
  bool fullscreen = false;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--core") && i + 1 < argc) core_path = argv[++i];
    else if (!strcmp(argv[i], "--rom") && i + 1 < argc) rom_path = argv[++i];
    else if (!strcmp(argv[i], "--title") && i + 1 < argc) title = argv[++i];
    else if (!strcmp(argv[i], "--save-dir") && i + 1 < argc) snprintf(save_dir, sizeof save_dir, "%s", argv[++i]);
    else if (!strcmp(argv[i], "--system-dir") && i + 1 < argc) snprintf(system_dir, sizeof system_dir, "%s", argv[++i]);
    else if (!strcmp(argv[i], "--fullscreen")) fullscreen = true;
  }
  if (!core_path || !rom_path) { fprintf(stderr, "usage: %s --core <core> --rom <file> [--title t] [--save-dir d] [--system-dir d]\n", argv[0]); return 2; }

  mkdir_p(save_dir);
  mkdir_p(system_dir);
  const char *base = strrchr(rom_path, '/');
  snprintf(rom_base, sizeof rom_base, "%s", base ? base + 1 : rom_path);
  char *dot = strrchr(rom_base, '.');
  if (dot) *dot = 0;
  snprintf(sram_path, sizeof sram_path, "%s/%s.srm", save_dir, rom_base);
  snprintf(state_path, sizeof state_path, "%s/%s.state", save_dir, rom_base);

  if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO | SDL_INIT_GAMECONTROLLER) != 0) die("SDL init failed: %s", SDL_GetError());
  SDL_SetHint(SDL_HINT_MAC_CTRL_CLICK_EMULATE_RIGHT_CLICK, "1");

  load_core(core_path);

  struct retro_system_info sys = { 0 };
  core.get_system_info(&sys);
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
  window = SDL_CreateWindow(title, SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, 960, 720,
                            SDL_WINDOW_OPENGL | SDL_WINDOW_RESIZABLE | SDL_WINDOW_ALLOW_HIGHDPI);
  if (!window) die("Could not open the game window: %s", SDL_GetError());
  glctx = SDL_GL_CreateContext(window);
  if (!glctx) die("Your Mac's graphics driver couldn't start OpenGL: %s", SDL_GetError());
  SDL_GL_MakeCurrent(window, glctx);
  SDL_GL_SetSwapInterval(0); /* audio paces the loop */
  if (!load_gl()) die("Your Mac's graphics driver is missing features this game needs.");
  glClearColor_(0, 0, 0, 1);
  glClear_(GL_COLOR_BUFFER_BIT);
  SDL_GL_SwapWindow(window);

  if (!core.load_game(&game)) die("The emulator couldn't start this game file.");
  core.get_system_av_info(&av);
  aspect = av.geometry.aspect_ratio > 0 ? av.geometry.aspect_ratio : (float)av.geometry.base_width / av.geometry.base_height;
  if (use_hw) {
    create_hw_fbo(av.geometry.max_width ? av.geometry.max_width : 1920, av.geometry.max_height ? av.geometry.max_height : 1440);
    if (hw.context_reset) hw.context_reset();
  }
  core.set_controller_port_device(0, RETRO_DEVICE_JOYPAD);
  load_sram();

  SDL_AudioSpec want = { 0 }, have;
  want.freq = (int)(av.timing.sample_rate > 0 ? av.timing.sample_rate : 44100);
  want.format = AUDIO_S16SYS;
  want.channels = 2;
  want.samples = 1024;
  audio_dev = SDL_OpenAudioDevice(NULL, 0, &want, &have, 0);
  if (audio_dev) SDL_PauseAudioDevice(audio_dev, 0);

  for (int i = 0; i < SDL_NumJoysticks(); i++) if (SDL_IsGameController(i)) { pad = SDL_GameControllerOpen(i); break; }
  keys = SDL_GetKeyboardState(NULL);
  if (fullscreen) toggle_fullscreen();

  const double fps = av.timing.fps > 0 ? av.timing.fps : 60.0;
  const Uint32 max_queued = (Uint32)(want.freq * 4 * 0.08); /* ~80 ms of audio */
  const Uint64 freq = SDL_GetPerformanceFrequency();
  const Uint64 frame_ticks = (Uint64)(freq / fps);
  Uint64 next = SDL_GetPerformanceCounter();
  Uint32 last_sram = SDL_GetTicks();

  while (running) {
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
      if (e.type == SDL_QUIT) running = false;
      else if (e.type == SDL_CONTROLLERDEVICEADDED && !pad) pad = SDL_GameControllerOpen(e.cdevice.which);
      else if (e.type == SDL_CONTROLLERDEVICEREMOVED && pad && e.cdevice.which == SDL_JoystickInstanceID(SDL_GameControllerGetJoystick(pad))) { SDL_GameControllerClose(pad); pad = NULL; }
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

    frame_ready = false;
    core.run();
    if (frame_ready || use_hw) present();

    /* Pace to the console's frame rate, and let audio catch up if it's ahead. */
    next += frame_ticks;
    Uint64 now = SDL_GetPerformanceCounter();
    if (now < next) {
      Uint32 ms = (Uint32)((next - now) * 1000 / freq);
      if (ms > 1) SDL_Delay(ms - 1);
      while (SDL_GetPerformanceCounter() < next) { }
    } else if (now - next > freq / 4) {
      next = now; /* fell far behind (e.g. window dragged): resync */
    }
    while (audio_dev && SDL_GetQueuedAudioSize(audio_dev) > max_queued) SDL_Delay(1);

    if (SDL_GetTicks() - last_sram > 10000) { save_sram(); last_sram = SDL_GetTicks(); }
  }

  save_sram();
  core.unload_game();
  core.deinit();
  free(rom_data);
  if (audio_dev) SDL_CloseAudioDevice(audio_dev);
  SDL_GL_DeleteContext(glctx);
  SDL_DestroyWindow(window);
  SDL_Quit();
  return 0;
}
