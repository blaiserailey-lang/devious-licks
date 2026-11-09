/* Minimal software libretro core used to smoke-test dl-player. */
#include <stdint.h>
#include <string.h>
#include "../libretro.h"
static retro_video_refresh_t video; static retro_audio_sample_batch_t audio; static retro_environment_t env;
static retro_input_poll_t poll; static retro_input_state_t input;
static uint32_t fb[320 * 240]; static unsigned frame; static uint8_t sram[512];
void retro_set_environment(retro_environment_t cb) { env = cb; }
void retro_set_video_refresh(retro_video_refresh_t cb) { video = cb; }
void retro_set_audio_sample(retro_audio_sample_t cb) { (void)cb; }
void retro_set_audio_sample_batch(retro_audio_sample_batch_t cb) { audio = cb; }
void retro_set_input_poll(retro_input_poll_t cb) { poll = cb; }
void retro_set_input_state(retro_input_state_t cb) { input = cb; }
void retro_set_controller_port_device(unsigned p, unsigned d) { (void)p; (void)d; }
void retro_init(void) {} void retro_deinit(void) {} void retro_reset(void) { frame = 0; }
void retro_get_system_info(struct retro_system_info *i) { memset(i, 0, sizeof *i); i->library_name = "test"; i->library_version = "1"; i->valid_extensions = "bin"; }
void retro_get_system_av_info(struct retro_system_av_info *i) { memset(i, 0, sizeof *i); i->geometry.base_width = 320; i->geometry.base_height = 240; i->geometry.max_width = 320; i->geometry.max_height = 240; i->geometry.aspect_ratio = 4.0f / 3.0f; i->timing.fps = 60; i->timing.sample_rate = 44100; }
bool retro_load_game(const struct retro_game_info *g) { enum retro_pixel_format f = RETRO_PIXEL_FORMAT_XRGB8888; (void)g; return env(RETRO_ENVIRONMENT_SET_PIXEL_FORMAT, &f); }
void retro_unload_game(void) {}
void retro_run(void) {
  poll();
  int a = input(0, RETRO_DEVICE_JOYPAD, 0, RETRO_DEVICE_ID_JOYPAD_B);
  for (int y = 0; y < 240; y++) for (int x = 0; x < 320; x++) fb[y * 320 + x] = a ? 0x00ff3d7f : (y < 120 ? 0x0000ff00 : 0x000000ff);
  video(fb, 320, 240, 320 * 4);
  static int16_t s[735 * 2]; audio(s, 735); frame++; sram[0] = (uint8_t)frame;
}
size_t retro_serialize_size(void) { return 4; }
bool retro_serialize(void *d, size_t n) { (void)n; memcpy(d, &frame, 4); return true; }
bool retro_unserialize(const void *d, size_t n) { (void)n; memcpy(&frame, d, 4); return true; }
void *retro_get_memory_data(unsigned id) { return id == RETRO_MEMORY_SAVE_RAM ? sram : NULL; }
size_t retro_get_memory_size(unsigned id) { return id == RETRO_MEMORY_SAVE_RAM ? sizeof sram : 0; }
unsigned retro_api_version(void) { return RETRO_API_VERSION; }
