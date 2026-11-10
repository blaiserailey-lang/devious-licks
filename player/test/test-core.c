/*
 * Minimal libretro core used to smoke-test dl-player. It shows four coloured
 * quarters (red, green / blue, white): as software frames by default, or
 * drawn with OpenGL when the core option test-mode is "hw". That exercises
 * both of the player's video paths, its core-option handling, audio (a quiet
 * 441 Hz tone) and saves without needing a real game.
 */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "../libretro.h"

#define GL_FRAMEBUFFER 0x8D40
#define GL_SCISSOR_TEST 0x0C11
#define GL_COLOR_BUFFER_BIT 0x00004000

static retro_video_refresh_t video;
static retro_audio_sample_batch_t audio;
static retro_environment_t env;
static retro_input_poll_t poll_input;
static retro_input_state_t input;
static retro_log_printf_t logf_cb;
static struct retro_hw_render_callback hw;
static bool hw_mode, gl_ready;
static uint32_t fb[320 * 240];
static unsigned frame;
static uint8_t sram[512];

static void (*gl_bind_framebuffer)(unsigned, unsigned);
static void (*gl_viewport)(int, int, int, int);
static void (*gl_scissor)(int, int, int, int);
static void (*gl_enable)(unsigned);
static void (*gl_clear_color)(float, float, float, float);
static void (*gl_clear)(unsigned);

static struct retro_core_option_v2_definition option_defs[] = {
  { "test-mode", "Mode", NULL, "How frames are produced.", NULL, NULL, { { "software", NULL }, { "hw", NULL }, { NULL, NULL } }, "software" },
  { "test-greeting", "Greeting", NULL, "Only here to check defaults.", NULL, NULL, { { "nope", NULL }, { "hello", NULL }, { NULL, NULL } }, "hello" },
  { NULL, NULL, NULL, NULL, NULL, NULL, { { NULL, NULL } }, NULL },
};
static struct retro_core_options_v2 options = { NULL, option_defs };

static const char *variable(const char *key) {
  struct retro_variable var = { key, NULL };
  return env(RETRO_ENVIRONMENT_GET_VARIABLE, &var) && var.value ? var.value : "(none)";
}

void retro_set_environment(retro_environment_t cb) {
  static const struct retro_variable legacy[] = { { "test-mode", "Mode; software|hw" }, { "test-greeting", "Greeting; hello|nope" }, { NULL, NULL } };
  struct retro_core_options_v2_intl intl = { &options, NULL };
  unsigned version = 0;
  env = cb;
  if (!cb(RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION, &version)) version = 0;
  if (version >= 2) cb(RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2_INTL, &intl);
  else cb(RETRO_ENVIRONMENT_SET_VARIABLES, (void *)legacy);
}
void retro_set_video_refresh(retro_video_refresh_t cb) { video = cb; }
void retro_set_audio_sample(retro_audio_sample_t cb) { (void)cb; }
void retro_set_audio_sample_batch(retro_audio_sample_batch_t cb) { audio = cb; }
void retro_set_input_poll(retro_input_poll_t cb) { poll_input = cb; }
void retro_set_input_state(retro_input_state_t cb) { input = cb; }
void retro_set_controller_port_device(unsigned p, unsigned d) { (void)p; (void)d; }
void retro_init(void) {
  struct retro_log_callback log;
  if (env(RETRO_ENVIRONMENT_GET_LOG_INTERFACE, &log)) logf_cb = log.log;
}
void retro_deinit(void) {}
void retro_reset(void) { frame = 0; }
void retro_get_system_info(struct retro_system_info *i) {
  memset(i, 0, sizeof *i);
  i->library_name = "Devious Licks test core";
  i->library_version = "2";
  i->valid_extensions = "bin|z64";
}
void retro_get_system_av_info(struct retro_system_av_info *i) {
  memset(i, 0, sizeof *i);
  i->geometry.base_width = i->geometry.max_width = hw_mode ? 640 : 320;
  i->geometry.base_height = i->geometry.max_height = hw_mode ? 480 : 240;
  i->geometry.aspect_ratio = 4.0f / 3.0f;
  i->timing.fps = 60;
  i->timing.sample_rate = 44100;
}

static void context_reset(void) {
  gl_bind_framebuffer = (void (*)(unsigned, unsigned))hw.get_proc_address("glBindFramebuffer");
  gl_viewport = (void (*)(int, int, int, int))hw.get_proc_address("glViewport");
  gl_scissor = (void (*)(int, int, int, int))hw.get_proc_address("glScissor");
  gl_enable = (void (*)(unsigned))hw.get_proc_address("glEnable");
  gl_clear_color = (void (*)(float, float, float, float))hw.get_proc_address("glClearColor");
  gl_clear = (void (*)(unsigned))hw.get_proc_address("glClear");
  gl_ready = gl_bind_framebuffer && gl_viewport && gl_scissor && gl_enable && gl_clear_color && gl_clear;
}
static void context_destroy(void) { gl_ready = false; }

bool retro_load_game(const struct retro_game_info *g) {
  enum retro_pixel_format f = RETRO_PIXEL_FORMAT_XRGB8888;
  const char *mode = variable("test-mode");
  (void)g;
  if (logf_cb) logf_cb(RETRO_LOG_INFO, "test core: mode=%s greeting=%s\n", mode, variable("test-greeting"));
  if (!env(RETRO_ENVIRONMENT_SET_PIXEL_FORMAT, &f)) return false;
  hw_mode = !strcmp(mode, "hw");
  if (hw_mode) {
    hw.context_type = RETRO_HW_CONTEXT_OPENGL_CORE;
    hw.version_major = 3;
    hw.version_minor = 3;
    hw.context_reset = context_reset;
    hw.context_destroy = context_destroy;
    hw.depth = true;
    hw.bottom_left_origin = true;
    if (!env(RETRO_ENVIRONMENT_SET_HW_RENDER, &hw)) return false;
  }
  return true;
}
void retro_unload_game(void) {}

static void quarter(int x, int y, int w, int h, float r, float g, float b) {
  gl_scissor(x, y, w, h);
  gl_clear_color(r, g, b, 1);
  gl_clear(GL_COLOR_BUFFER_BIT);
}

void retro_run(void) {
  static int16_t sound[735 * 2];
  static unsigned long sample_no;
  poll_input();
  int a = input(0, RETRO_DEVICE_JOYPAD, 0, RETRO_DEVICE_ID_JOYPAD_B);
  if (hw_mode) {
    if (gl_ready) {
      /* y runs upward here. The scissor test and the framebuffer binding are
       * left as they are on purpose: the player has to cope with that. */
      gl_bind_framebuffer(GL_FRAMEBUFFER, (unsigned)hw.get_current_framebuffer());
      gl_viewport(0, 0, 640, 480);
      gl_enable(GL_SCISSOR_TEST);
      quarter(0, 240, 320, 240, 1, 0, 0);
      quarter(320, 240, 320, 240, 0, 1, 0);
      quarter(0, 0, 320, 240, 0, 0, 1);
      quarter(320, 0, 320, 240, 1, 1, 1);
      video(RETRO_HW_FRAME_BUFFER_VALID, 640, 480, 0);
    } else {
      video(NULL, 640, 480, 0);
    }
  } else {
    for (int y = 0; y < 240; y++)
      for (int x = 0; x < 320; x++)
        fb[y * 320 + x] = a ? 0x00ff3d7f : y < 120 ? (x < 160 ? 0x00ff0000 : 0x0000ff00) : (x < 160 ? 0x000000ff : 0x00ffffff);
    video(fb, 320, 240, 320 * 4);
  }
  /* a steady, quiet 441 Hz tone (100 samples per cycle at 44100 Hz), so the
   * player's self-test has a pitch to measure */
  for (int i = 0; i < 735; i++, sample_no++) sound[i * 2] = sound[i * 2 + 1] = sample_no % 100 < 50 ? 2000 : -2000;
  audio(sound, 735);
  frame++;
  sram[0] = (uint8_t)(frame / 60);
}
size_t retro_serialize_size(void) { return 4; }
bool retro_serialize(void *d, size_t n) { (void)n; memcpy(d, &frame, 4); return true; }
bool retro_unserialize(const void *d, size_t n) { (void)n; memcpy(&frame, d, 4); return true; }
void *retro_get_memory_data(unsigned id) { return id == RETRO_MEMORY_SAVE_RAM ? sram : NULL; }
size_t retro_get_memory_size(unsigned id) { return id == RETRO_MEMORY_SAVE_RAM ? sizeof sram : 0; }
unsigned retro_api_version(void) { return RETRO_API_VERSION; }
