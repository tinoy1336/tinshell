/*
 * tinshell-splash — the passphrase screen the boot draws, without a toolkit.
 *
 * It owns three things and nothing else: the framebuffer, the console's virtual
 * terminal, and the answer to the unlock's password request.
 *
 * During the passphrase the framebuffer belongs to simpledrm, which maps the
 * firmware's own framebuffer and copies the picture it is showing into that
 * memory when its plane commits: the commit is a memory copy, not a mode set on
 * the panel. The driver that can reprogram the panel, amdgpu, is deliberately
 * absent from the boot image and is loaded later, after the root volume is
 * unlocked. The program therefore paints the firmware's frame itself — the boot
 * graphics image, black ground and all — into the buffer it draws and commits it,
 * and then draws the passphrase field into the live picture, with what lies under
 * it saved so it can be put back.
 *
 * Every commit is checked. A refused commit, a framebuffer that is not
 * simpledrm's, or a missing image hands the screen to the text prompt instead of
 * drawing into a surface nobody scans.
 *
 * The request arrives the way systemd documents it: an ini file in
 * /run/systemd/ask-password names the question and a socket to reply on, and the
 * first agent to answer wins. Whether the answer was right is the boot's to say,
 * and it says it by unlocking the root volume or by asking again: the field stays
 * on screen until the volume appears, because a refused passphrase is followed by
 * another question. When the volume appears the field goes and the mark takes its
 * place in one refresh, and the picture the program leaves behind carries the mark
 * into whatever paints next.
 *
 * The console is left in graphics mode deliberately: the text console never
 * paints over the picture, at the cost of a boot message being invisible.
 *
 * If the framebuffer or the terminal cannot be taken, the program puts the
 * console back and exits without answering, so the ordinary text prompt can ask.
 */

#define _GNU_SOURCE

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/fb.h>
#include <linux/input.h>
#include <linux/kd.h>
#include <linux/vt.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/inotify.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/reboot.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#define ASK_DIR "/run/systemd/ask-password"
#define ASSET_DIR "/usr/libexec/tinshell-splash"
#define CONSOLE "/dev/tty1"

/* The deferred-IO worker behind a DRM framebuffer copies its shadow into the
 * scanout buffer on its own schedule; HZ/20 is 50 ms at HZ=1000, so the picture
 * is given more than one interval to appear before anything waits on it. */
#define FLUSH_MS 120

/* The fade, the mark's place and the frame's place come from the splash's config
 * (apps/greeter/boot/config.defaults.json): tinshell-boot-refresh compiles this file
 * with them. The values below are the ones that build ships and exist so the file
 * also compiles on its own. */
#ifndef FADE_STEPS
#define FADE_STEPS 10
#endif
#ifndef FADE_STEP_MS
#define FADE_STEP_MS 60
#endif

#define MAX_PASS 512
#define MAX_DOTS 24

/* How long the boot is given to answer a passphrase before its silence is read as
 * acceptance: a refused one is followed by another question within seconds, and an
 * accepted one by the root volume's device appearing. */
#define UNLOCK_VERDICT_MS 5000

/* The root volume, as the command line names it: rd.luks.name=<uuid>=cryptroot.
 * Its device exists only once the passphrase has been accepted, which is the only
 * record of a right answer anywhere in the exchange. */
#define ROOT_MAPPER "cryptroot"

/* How long a finished request is left to be followed by another before the text
 * console is given back. A successful unlock switches root within seconds, so
 * this only elapses when the unlock failed — and then an invisible machine is
 * worse than a boot message on top of the picture. */
#define IDLE_GIVE_BACK_MS 30000

/* Where the mark sits. The field is drawn in the same box: the screen carries one
 * thing at a time, asking for the passphrase first and wearing the mark after. */
#ifndef MARK_TOP_REF
#define MARK_TOP_REF 1112
#endif
#define PANEL_HEIGHT_REF 1800
#define PANEL_WIDTH_REF 2880

/* Where the firmware's boot graphics image sits on this panel, in the same
 * reference pixels as everything else. */
#ifndef FRAME_LEFT_REF
#define FRAME_LEFT_REF 1080
#endif
#ifndef FRAME_TOP_REF
#define FRAME_TOP_REF 720
#endif

struct image {
	uint32_t width, height;
	uint8_t *pixels; /* RGBA, row-major */
};

struct framebuffer {
	int fd;
	uint8_t *mem;
	size_t length;
	uint32_t width, height;
	uint32_t stride;
	uint32_t bytes_per_pixel;
};

struct saved_area {
	int active;
	uint32_t x, y, width, height;
	uint8_t *pixels;
};

struct request {
	int active;
	char path[PATH_MAX];
	char socket_path[PATH_MAX];
	pid_t pid;
	uint64_t not_after;
};

static struct framebuffer fb;
static struct image mark_image, well_image, dot_image, frame_image;

/* The boot journal is the only place this program can say anything: its own
 * output is discarded so the terminal stays clean for the request socket. */
static int log_fd = -1;

static void boot_log(const char *format, ...)
{
	if (log_fd < 0)
		return;

	char message[512];
	va_list arguments;
	va_start(arguments, format);
	vsnprintf(message, sizeof(message), format, arguments);
	va_end(arguments);

	dprintf(log_fd, "<6>tinshell-splash: %s\n", message);
}
static struct saved_area well_saved;

static int console_fd = -1;
static int inotify_fd = -1;
static int power_fd = -1;
static struct termios console_saved_termios;
static int console_saved_kbmode = -1;
static int console_have_termios = 0;

static volatile sig_atomic_t stop_requested = 0;

static void handle_power(int fd);
static void fall_back_to_console_prompt(void);
static int activate_framebuffer(void);
static int draw_commit(int delay_ms);
static int read_fb_driver(char *out, size_t size);
static uint32_t well_left(void);
static uint32_t well_top(void);
static int another_question(const struct request *answered);

/* The driver that owned the framebuffer when the program started. Every later
 * draw checks it again: a driver that binds mid-request would leave the well and
 * the dots in a buffer nobody scans, which is a passphrase typed blind. */
static char fb_driver[64];

static void on_signal(int signal_number)
{
	(void)signal_number;
	stop_requested = 1;
}

/* The framebuffer can go away under a mapping: the graphics driver taking the
 * display unregisters the one the firmware left, and the next store faults. The
 * handler does only what is safe there — put the console back and hand the boot
 * to the text prompt — because the alternative is a dead process with the
 * terminal in graphics mode and nobody able to answer. */
static void on_fault(int signal_number)
{
	(void)signal_number;

	if (console_fd >= 0) {
		ioctl(console_fd, KDSETMODE, KD_TEXT);
		if (console_saved_kbmode >= 0)
			ioctl(console_fd, KDSKBMODE, console_saved_kbmode);
	}
	execl("/usr/bin/systemd-tty-ask-password-agent", "systemd-tty-ask-password-agent",
	      "--watch", "--console", (char *)NULL);
	_exit(1);
}

static void sleep_ms(int milliseconds)
{
	struct timespec delay = { milliseconds / 1000, (milliseconds % 1000) * 1000000L };
	nanosleep(&delay, NULL);
}

static uint64_t monotonic_usec(void)
{
	struct timespec now;
	clock_gettime(CLOCK_MONOTONIC, &now);
	return (uint64_t)now.tv_sec * 1000000ull + (uint64_t)now.tv_nsec / 1000ull;
}

static uint64_t monotonic_ms(void)
{
	return monotonic_usec() / 1000ull;
}

/* When the last request finished. */
static uint64_t last_answer_ms = 0;

/* ---------------------------------------------------------------- images */

static int load_image(const char *name, struct image *image)
{
	char path[PATH_MAX];
	snprintf(path, sizeof(path), "%s/%s", ASSET_DIR, name);

	int fd = open(path, O_RDONLY | O_CLOEXEC);
	if (fd < 0)
		return -1;

	struct stat status;
	if (fstat(fd, &status) != 0 || status.st_size < 8) {
		close(fd);
		return -1;
	}

	uint8_t *buffer = malloc((size_t)status.st_size);
	if (buffer == NULL) {
		close(fd);
		return -1;
	}

	ssize_t got = 0;
	while (got < status.st_size) {
		ssize_t taken = read(fd, buffer + got, (size_t)(status.st_size - got));
		if (taken <= 0) {
			free(buffer);
			close(fd);
			return -1;
		}
		got += taken;
	}
	close(fd);

	memcpy(&image->width, buffer, 4);
	memcpy(&image->height, buffer + 4, 4);
	size_t expected = 8 + (size_t)image->width * image->height * 4;
	if (expected != (size_t)status.st_size) {
		free(buffer);
		return -1;
	}

	image->pixels = malloc(expected - 8);
	if (image->pixels == NULL) {
		free(buffer);
		return -1;
	}
	memcpy(image->pixels, buffer + 8, expected - 8);
	free(buffer);
	return 0;
}

static void free_image(struct image *image)
{
	free(image->pixels);
	image->pixels = NULL;
}

/* ----------------------------------------------------------- framebuffer */

static int open_framebuffer(void)
{
	fb.fd = open("/dev/fb0", O_RDWR | O_CLOEXEC);
	if (fb.fd < 0)
		return -1;

	struct fb_fix_screeninfo fix;
	struct fb_var_screeninfo var;
	if (ioctl(fb.fd, FBIOGET_FSCREENINFO, &fix) != 0 ||
	    ioctl(fb.fd, FBIOGET_VSCREENINFO, &var) != 0) {
		close(fb.fd);
		fb.fd = -1;
		return -1;
	}

	/* Only the layout the panel actually uses is handled: 32 bits per pixel,
	 * red in the second byte from the top. Anything else steps aside rather
	 * than drawing the wrong colours. */
	if (var.bits_per_pixel != 32 || var.red.offset != 16 || var.green.offset != 8 ||
	    var.blue.offset != 0) {
		close(fb.fd);
		fb.fd = -1;
		return -1;
	}

	fb.width = var.xres;
	fb.height = var.yres;
	fb.stride = fix.line_length;
	fb.bytes_per_pixel = 4;
	fb.length = (size_t)fix.line_length * var.yres;

	fb.mem = mmap(NULL, fb.length, PROT_READ | PROT_WRITE, MAP_SHARED, fb.fd, 0);
	if (fb.mem == MAP_FAILED) {
		fb.mem = NULL;
		close(fb.fd);
		fb.fd = -1;
		return -1;
	}
	return 0;
}

static void close_framebuffer(void)
{
	if (fb.mem != NULL)
		munmap(fb.mem, fb.length);
	if (fb.fd >= 0)
		close(fb.fd);
	fb.mem = NULL;
	fb.fd = -1;
}

static void save_area(struct saved_area *area, uint32_t x, uint32_t y, uint32_t width, uint32_t height)
{
	if (x >= fb.width || y >= fb.height)
		return;
	if (x + width > fb.width)
		width = fb.width - x;
	if (y + height > fb.height)
		height = fb.height - y;

	free(area->pixels);
	area->pixels = malloc((size_t)width * height * 4);
	if (area->pixels == NULL) {
		area->active = 0;
		return;
	}
	area->x = x;
	area->y = y;
	area->width = width;
	area->height = height;
	area->active = 1;

	for (uint32_t row = 0; row < height; row++)
		memcpy(area->pixels + (size_t)row * width * 4,
		       fb.mem + (size_t)(y + row) * fb.stride + (size_t)x * 4,
		       (size_t)width * 4);
}

/* Writes a saved rectangle back without releasing it, so a fade can blend the
 * next step against the picture that was there before the fade. */
static void repaint_saved(const struct saved_area *area)
{
	if (!area->active || area->pixels == NULL)
		return;

	for (uint32_t row = 0; row < area->height; row++)
		memcpy(fb.mem + (size_t)(area->y + row) * fb.stride + (size_t)area->x * 4,
		       area->pixels + (size_t)row * area->width * 4,
		       (size_t)area->width * 4);
}

static void restore_area(struct saved_area *area)
{
	if (!area->active || area->pixels == NULL)
		return;

	repaint_saved(area);
	free(area->pixels);
	area->pixels = NULL;
	area->active = 0;
}

/* Blends one image over the framebuffer at a position and an overall opacity. */
static void draw_image(const struct image *image, uint32_t left, uint32_t top, double opacity)
{
	if (image->pixels == NULL || opacity <= 0)
		return;

	for (uint32_t row = 0; row < image->height; row++) {
		uint32_t y = top + row;
		if (y >= fb.height)
			break;
		uint32_t *destination = (uint32_t *)(fb.mem + (size_t)y * fb.stride);

		for (uint32_t column = 0; column < image->width; column++) {
			uint32_t x = left + column;
			if (x >= fb.width)
				break;

			const uint8_t *source = image->pixels + ((size_t)row * image->width + column) * 4;
			unsigned source_alpha = (unsigned)(source[3] * opacity);
			if (source_alpha == 0)
				continue;

			uint32_t behind = destination[x];
			unsigned behind_red = (behind >> 16) & 0xff;
			unsigned behind_green = (behind >> 8) & 0xff;
			unsigned behind_blue = behind & 0xff;

			unsigned red = (source[0] * source_alpha + behind_red * (255 - source_alpha)) / 255;
			unsigned green = (source[1] * source_alpha + behind_green * (255 - source_alpha)) / 255;
			unsigned blue = (source[2] * source_alpha + behind_blue * (255 - source_alpha)) / 255;

			destination[x] = (red << 16) | (green << 8) | blue;
		}
	}
}

/* Writing into the buffer only reaches the panel when the driver commits it:
 * simpledrm copies the picture it is showing into the firmware's framebuffer at
 * that point, and it cannot reprogram the panel. Every finished paint therefore
 * ends here, and a refused commit is not ignored — the result would be a frame
 * nobody scans while the program keeps drawing into it. */
static int draw_commit(int delay_ms)
{
	if (fb.mem == NULL)
		return -1;

	if (msync(fb.mem, fb.length, MS_ASYNC) != 0) {
		boot_log("cannot write the framebuffer back: %s", strerror(errno));
		return -1;
	}
	if (delay_ms > 0)
		sleep_ms(delay_ms);
	return activate_framebuffer();
}

/* The name of the driver behind fb0, or a failure when /sys cannot be read. */
static int read_fb_driver(char *out, size_t size)
{
	int fd = open("/sys/class/graphics/fb0/name", O_RDONLY | O_CLOEXEC);
	if (fd < 0)
		return -1;

	ssize_t got = read(fd, out, size - 1);
	close(fd);
	if (got <= 0)
		return -1;
	out[got] = '\0';
	for (ssize_t index = 0; index < got; index++) {
		if (out[index] == '\n')
			out[index] = '\0';
	}
	return 0;
}

static uint32_t fraction_of_height(uint32_t reference)
{
	return (uint32_t)((uint64_t)fb.height * reference / PANEL_HEIGHT_REF);
}

static uint32_t fraction_of_width(uint32_t reference)
{
	return (uint32_t)((uint64_t)fb.width * reference / PANEL_WIDTH_REF);
}

/* Makes the buffer this program draws into the surface the panel scans. Until a
 * mode change is asked for, the graphics driver has only allocated that buffer:
 * the display still scans the firmware's own framebuffer, so pixels written here
 * are never shown. Asking for a mode change is the commit that attaches it, and
 * it is what the text console would trigger by taking over. Forcing the
 * assignment past the driver's unchanged-values shortcut is what makes the
 * request reach the commit at all. */
static int activate_framebuffer(void)
{
	struct fb_var_screeninfo var;
	if (ioctl(fb.fd, FBIOGET_VSCREENINFO, &var) != 0) {
		boot_log("cannot read the screen information: %s", strerror(errno));
		return -1;
	}

	var.activate = FB_ACTIVATE_NOW | FB_ACTIVATE_FORCE;
	if (ioctl(fb.fd, FBIOPUT_VSCREENINFO, &var) == 0)
		return 0;

	/* No pan fallback: this surface has no headroom to pan into, so the call can
	 * only return success without copying anything, which is the silent failure
	 * this whole path exists to avoid. */
	boot_log("cannot commit the display: %s", strerror(errno));
	return -1;
}

/* Paints the firmware's frame onto the buffer and commits the display, so the
 * panel changes from the firmware's framebuffer to an identical picture rather
 * than to an empty one. Without the frame image there is nothing to paint that
 * would not be a guess, so the display is left as the firmware set it. */
static int prime_framebuffer(void)
{
	if (fb.mem == NULL)
		return -1;

	if (frame_image.pixels == NULL) {
		boot_log("no frame image, leaving the panel on the firmware's framebuffer");
		return -1;
	}

	/* The frame is painted before anything is cleared: this surface reaches the
	 * panel at the commit, so clearing it first would show a black flash. */
	uint32_t left = fraction_of_width(FRAME_LEFT_REF);
	uint32_t top = fraction_of_height(FRAME_TOP_REF);
	uint32_t right = left + frame_image.width;
	uint32_t bottom = top + frame_image.height;

	draw_image(&frame_image, left, top, 1.0);

	for (uint32_t row = 0; row < fb.height; row++) {
		if (row < top || row >= bottom) {
			memset(fb.mem + (size_t)row * fb.stride, 0, (size_t)fb.width * 4);
			continue;
		}
		if (left > 0)
			memset(fb.mem + (size_t)row * fb.stride, 0, (size_t)left * 4);
		if (right < fb.width)
			memset(fb.mem + (size_t)row * fb.stride + (size_t)right * 4, 0,
			       (size_t)(fb.width - right) * 4);
	}

	if (draw_commit(FLUSH_MS) != 0)
		return -1;

	boot_log("display committed: this buffer is what the panel scans");
	return 0;
}

/* -------------------------------------------- the field and the mark */

static void fade_in(void)
{
	if (well_image.pixels == NULL || fb.mem == NULL)
		return;

	/* The field arrives on its own: the mark is not on screen until a passphrase has
	 * been accepted. The pixels underneath the field are put back between steps, so
	 * each step blends against what was there before the fade rather than against
	 * the previous step's opacity, and ten steps is short enough to read as a fade
	 * and long enough that a single frame is not mistaken for a flash. The field's
	 * background is recorded here and not again by draw_well, which would otherwise
	 * save the fading field as the picture to return to. */
	save_area(&well_saved, well_left(), well_top(), well_image.width, well_image.height);
	for (int step = 1; step <= FADE_STEPS; step++) {
		double opacity = (double)step / FADE_STEPS;
		repaint_saved(&well_saved);
		draw_image(&well_image, well_left(), well_top(), opacity);
		if (draw_commit(FADE_STEP_MS) != 0)
			fall_back_to_console_prompt();
	}
}

/* --------------------------------------------------------------- the well */

static uint32_t well_left(void)
{
	return (fb.width - well_image.width) / 2;
}

static uint32_t well_top(void)
{
	uint32_t mark_top = fraction_of_height(MARK_TOP_REF);
	if (mark_image.height <= well_image.height)
		return mark_top;
	return mark_top + (mark_image.height - well_image.height) / 2;
}

static void draw_well(void)
{
	if (well_image.pixels == NULL || fb.mem == NULL)
		return;
	/* The fade recorded the picture under the field; a request that arrives
	 * without one has to record it here instead, and recording it twice would
	 * return the field itself to the panel when the request ends. */
	if (!well_saved.active)
		save_area(&well_saved, well_left(), well_top(), well_image.width, well_image.height);
	draw_image(&well_image, well_left(), well_top(), 1.0);
	if (draw_commit(0) != 0)
		fall_back_to_console_prompt();
}

/* ------------------------------------------------- after an accepted answer */

/* What the screen does once the root volume is unlocked: the field is replaced by
 * the mark in a single refresh. The pixels the field covered go back first, the
 * mark is drawn in the same box at full strength, and one commit shows the result,
 * so the screen never carries half of each. The mark is not saved anywhere: it is
 * the picture the splash leaves behind, and the teardown keeps it.
 *
 * A refused commit is worth a journal line rather than a text prompt here: the
 * boot is past the point where a console prompt would help anyone. */
static void show_mark(void)
{
	if (mark_image.pixels == NULL || fb.mem == NULL)
		return;

	restore_area(&well_saved);

	uint32_t left = (fb.width - mark_image.width) / 2;
	uint32_t top = fraction_of_height(MARK_TOP_REF);
	draw_image(&mark_image, left, top, 1.0);

	if (draw_commit(0) != 0)
		boot_log("the display did not take the mark: %s", strerror(errno));
}

static void draw_dots(unsigned count)
{
	if (dot_image.pixels == NULL || well_image.pixels == NULL)
		return;

	uint32_t slot_width = well_image.width / MAX_DOTS;
	uint32_t row_top = well_top() + well_image.height / 2 - dot_image.height / 2;
	/* The row is centred on the field, so every new dot lands at its right end and
	 * the dots already drawn move half a slot to the left. Recentring in whole
	 * slots instead would put every other dot at the left end of the row. */
	uint32_t row_left = well_left() + (well_image.width - count * slot_width) / 2;

	/* The row is repainted whole so a deleted character leaves nothing behind. */
	draw_image(&well_image, well_left(), well_top(), 1.0);
	for (unsigned index = 0; index < count; index++) {
		uint32_t x = row_left + index * slot_width + slot_width / 2 - dot_image.width / 2;
		draw_image(&dot_image, x, row_top, 1.0);
	}
	/* No artificial delay on this path: the commit itself paces typing, and the
	 * caller commits once more when the input queue drains. */
	if (draw_commit(0) != 0)
		fall_back_to_console_prompt();
}

/* ------------------------------------------------------ the answer socket */

static int reply_to(const struct request *request, int entered, const char *password)
{
	int fd = socket(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0);
	if (fd < 0)
		return -1;

	struct sockaddr_un address;
	memset(&address, 0, sizeof(address));
	address.sun_family = AF_UNIX;
	if (strlen(request->socket_path) >= sizeof(address.sun_path)) {
		close(fd);
		return -1;
	}
	memcpy(address.sun_path, request->socket_path, strlen(request->socket_path) + 1);

	char payload[MAX_PASS + 2];
	size_t length = strlen(password);
	if (length > MAX_PASS)
		length = MAX_PASS;
	payload[0] = entered ? '+' : '-';
	memcpy(payload + 1, password, length);
	payload[length + 1] = '\0';

	ssize_t sent = sendto(fd, payload, length + 2, 0, (struct sockaddr *)&address, sizeof(address));
	explicit_bzero(payload, sizeof(payload));
	close(fd);
	return sent < 0 ? -1 : 0;
}

/* ------------------------------------------------------------- ask files */

static uint64_t read_number(const char *text)
{
	return strtoull(text, NULL, 10);
}

static int parse_request(const char *path, struct request *request){
	FILE *file = fopen(path, "re");
	if (file == NULL)
		return -1;

	memset(request, 0, sizeof(*request));
	snprintf(request->path, sizeof(request->path), "%s", path);
	request->not_after = 0;

	char line[PATH_MAX + 64];
	int in_ask = 0;
	while (fgets(line, sizeof(line), file) != NULL) {
		char *trimmed = line;
		while (*trimmed == ' ' || *trimmed == '\t')
			trimmed++;

		if (*trimmed == '[') {
			in_ask = strncmp(trimmed, "[Ask]", 5) == 0;
			continue;
		}
		if (!in_ask)
			continue;

		char *equals = strchr(trimmed, '=');
		if (equals == NULL)
			continue;
		*equals = '\0';
		char *value = equals + 1;
		char *end = value + strlen(value);
		while (end > value && (end[-1] == '\n' || end[-1] == '\r'))
			*--end = '\0';

		if (strcmp(trimmed, "Socket") == 0)
			snprintf(request->socket_path, sizeof(request->socket_path), "%s", value);
		else if (strcmp(trimmed, "PID") == 0)
			request->pid = (pid_t)read_number(value);
		else if (strcmp(trimmed, "NotAfter") == 0)
			request->not_after = read_number(value);
	}
	fclose(file);

	if (request->socket_path[0] == '\0')
		return -1;

	/* A request whose asker has gone, or whose deadline has passed, is not
	 * answered: the screen must not be taken for a question nobody waits on. */
	if (request->pid > 0) {
		int alive = kill(request->pid, 0);
		if (alive != 0 && errno == ESRCH)
			return -1;
	}
	if (request->not_after > 0 && monotonic_usec() > request->not_after)
		return -1;

	request->active = 1;
	return 0;
}

static int request_still_there(const struct request *request)
{
	struct stat status;
	return stat(request->path, &status) == 0;
}

/* Whether the boot has asked a question other than this one. A refused passphrase
 * announces itself that way: the requester takes its ask file away as soon as it has
 * an answer and writes a new one when the answer it tried was wrong. */
static int another_question(const struct request *answered)
{
	DIR *directory = opendir(ASK_DIR);
	if (directory == NULL)
		return 0;

	const char *own = answered != NULL ? strrchr(answered->path, '/') : NULL;
	if (own != NULL)
		own++;

	int found = 0;
	struct dirent *entry;
	while (!found && (entry = readdir(directory)) != NULL) {
		if (strncmp(entry->d_name, "ask.", 4) != 0)
			continue;
		if (own != NULL && strcmp(own, entry->d_name) == 0)
			continue;
		found = 1;
	}
	closedir(directory);
	return found;
}

/* Whether the root volume's device is there. It appears only once the passphrase has
 * been accepted, and it is the one place the boot records that verdict: the exchange
 * itself looks the same whether the answer was right or refused. The name comes from
 * the command line, rd.luks.name=<uuid>=cryptroot, and the root volume is the only
 * volume this splash is ever asked about. */
static int root_volume_present(void)
{
	DIR *class = opendir("/sys/class/block");
	if (class == NULL)
		return 0;

	int present = 0;
	struct dirent *entry;
	while (!present && (entry = readdir(class)) != NULL) {
		char path[PATH_MAX];
		snprintf(path, sizeof(path), "/sys/class/block/%s/dm/name", entry->d_name);

		int fd = open(path, O_RDONLY | O_CLOEXEC);
		if (fd < 0)
			continue;

		char name[64];
		ssize_t got = read(fd, name, sizeof(name) - 1);
		close(fd);
		if (got <= 0)
			continue;
		name[got] = '\0';
		name[strcspn(name, "\n")] = '\0';
		present = strcmp(name, ROOT_MAPPER) == 0;
	}
	closedir(class);
	return present;
}

/* The boot's verdict on the passphrase just sent. A new question means the answer was
 * refused; the root volume's device means it was taken. Silence is read as accepted,
 * because a question that does not come back is one the boot was satisfied with. */
static int passphrase_accepted(const struct request *answered)
{
	uint64_t deadline = monotonic_ms() + UNLOCK_VERDICT_MS;

	while (monotonic_ms() < deadline) {
		if (stop_requested)
			return 0;
		if (root_volume_present())
			return 1;
		if (another_question(answered))
			return 0;
		sleep_ms(50);
	}
	return 1;
}

/* The screen while a passphrase is being asked for. Returns once the request is
 * gone or answered; the pixels underneath the well are put back either way. */
static void answer_request(struct request *request)
{
	char password[MAX_PASS + 1];
	unsigned length = 0;
	int submitted = 0;
	int cancelled = 0;
	memset(password, 0, sizeof(password));

	/* A driver that took the framebuffer since the program started would leave the
	 * well and dots in a buffer nobody scans: the passphrase would be typed blind.
	 * Check before anything is drawn for this question. */
	char current[64];
	if (read_fb_driver(current, sizeof(current)) != 0 ||
	    strcmp(current, fb_driver) != 0) {
		boot_log("framebuffer driver changed to '%s': handing over to the text prompt", current);
		fall_back_to_console_prompt();
	}

	draw_well();
	draw_dots(0);

	while (!stop_requested && request_still_there(request)) {
		struct pollfd watches[2];
		int count = 0;
		int console_slot, power_slot = -1;

		watches[count] = (struct pollfd){ .fd = console_fd, .events = POLLIN };
		console_slot = count++;
		if (power_fd >= 0) {
			watches[count] = (struct pollfd){ .fd = power_fd, .events = POLLIN };
			power_slot = count++;
		}

		int ready = poll(watches, (nfds_t)count, 200);

		/* The power button has to work while the box is up: a boot that cannot
		 * be interrupted is worse than one that cannot be typed into. */
		if (power_slot >= 0 && (watches[power_slot].revents & POLLIN))
			handle_power(power_fd);

		if (ready > 0 && (watches[console_slot].revents & POLLIN)) {
			unsigned char keys[64];
			ssize_t got = read(console_fd, keys, sizeof(keys));
			for (ssize_t index = 0; index < got; index++) {
				unsigned char key = keys[index];

				if (key == '\r' || key == '\n') {
					submitted = 1;
					break;
				}
				if (key == 0x03) { /* interrupt: hand the question to the text prompt */
					cancelled = 1;
					break;
				}
				if (key == 0x7f || key == 0x08) {
					if (length > 0) {
						password[--length] = '\0';
						draw_dots(length > MAX_DOTS ? MAX_DOTS : length);
					}
					continue;
				}
				if (key == 0x15) { /* kill line */
					explicit_bzero(password, sizeof(password));
					length = 0;
					draw_dots(0);
					continue;
				}
				if (key >= 0x20 && key != 0x7f && length < MAX_PASS) {
					password[length++] = (char)key;
					password[length] = '\0';
					draw_dots(length > MAX_DOTS ? MAX_DOTS : length);
				}
			}
			explicit_bzero(keys, sizeof(keys));
		}

		if (submitted || cancelled)
			break;
	}

	if (cancelled) {
		/* A password request has no answer that means "no": the way out is the
		 * text prompt, where the question can be dropped and the boot recovered. */
		explicit_bzero(password, sizeof(password));
		restore_area(&well_saved);
		fall_back_to_console_prompt();
		return;
	}

	int accepted = 0;
	if (submitted) {
		/* The answer is sent once, and the socket can vanish between the question
		 * and the answer; a dropped reply would leave the boot waiting with the box
		 * hidden, so it is retried while the request is still there. */
		for (int attempt = 0; attempt < 100 && request_still_there(request); attempt++) {
			if (reply_to(request, 1, password) == 0)
				break;
			sleep_ms(100);
		}
		/* Then wait for the boot to say whether it was right. The field stays drawn
		 * until it does: a refused passphrase is followed by another question, and a
		 * field that had already gone would leave it with nothing to type into. */
		accepted = passphrase_accepted(request);
	}

	explicit_bzero(password, sizeof(password));

	if (!accepted) {
		request->active = 0;
		last_answer_ms = monotonic_ms();
		return;
	}

	/* Accepted: the field leaves and the mark takes its place, in one refresh. From
	 * here the screen carries the mark until the greeter paints over it, and the
	 * teardown leaves it in place. */
	show_mark();
	request->active = 0;
	last_answer_ms = monotonic_ms();
}

/* ------------------------------------------------------------- the power */

static int open_power_button(void){
	uint8_t capabilities[(KEY_MAX + 8) / 8] = { 0 };

	for (int index = 0; index < 32; index++) {
		char path[64];
		snprintf(path, sizeof(path), "/dev/input/event%d", index);

		int fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
		if (fd < 0)
			continue;

		memset(capabilities, 0, sizeof(capabilities));
		if (ioctl(fd, EVIOCGBIT(EV_KEY, sizeof(capabilities)), capabilities) >= 0 &&
		    (capabilities[KEY_POWER / 8] & (1 << (KEY_POWER % 8)))) {
			return fd;
		}
		close(fd);
	}
	return -1;
}

static void handle_power(int fd)
{
	struct input_event events[16];
	ssize_t got = read(fd, events, sizeof(events));
	if (got <= 0)
		return;

	for (ssize_t index = 0; index < got / (ssize_t)sizeof(events[0]); index++) {
		if (events[index].type == EV_KEY && events[index].code == KEY_POWER &&
		    events[index].value == 1) {
			/* Power down the way the kernel asks for it: sync first, because
			 * this path does not unmount anything. */
			sync();
			reboot(RB_POWER_OFF);
		}
	}
}

/* ------------------------------------------------------------ the console */

static int take_console(void)
{
	console_fd = open(CONSOLE, O_RDWR | O_NOCTTY | O_CLOEXEC);
	if (console_fd < 0)
		return -1;

	if (tcgetattr(console_fd, &console_saved_termios) == 0)
		console_have_termios = 1;

	struct termios raw;
	if (console_have_termios) {
		raw = console_saved_termios;
		cfmakeraw(&raw);
		raw.c_cc[VMIN] = 1;
		raw.c_cc[VTIME] = 0;
		tcsetattr(console_fd, TCSANOW, &raw);
	}

	ioctl(console_fd, KDGKBMODE, &console_saved_kbmode);
	ioctl(console_fd, KDSKBMODE, K_UNICODE);

	/* The splash draws on the terminal it activated; without this the picture
	 * could land on a terminal nobody is looking at. */
	ioctl(console_fd, VT_ACTIVATE, 1);
	ioctl(console_fd, VT_WAITACTIVE, 1);

	/* Graphics mode is what keeps the text console from painting over the
	 * firmware's picture, so it is set before anything is drawn. */
	ioctl(console_fd, KDSETMODE, KD_GRAPHICS);
	return 0;
}

static void release_console(int restore_text)
{
	if (console_fd < 0)
		return;

	if (restore_text)
		ioctl(console_fd, KDSETMODE, KD_TEXT);
	if (console_saved_kbmode >= 0)
		ioctl(console_fd, KDSKBMODE, console_saved_kbmode);
	if (console_have_termios)
		tcsetattr(console_fd, TCSANOW, &console_saved_termios);

	close(console_fd);
	console_fd = -1;
}

/* ---------------------------------------------------------------- boot up */

static void clean_up(void)
{
	/* Only the field is put back. Once the mark has replaced it there is nothing to
	 * undo: the mark is the picture the program hands over, not something drawn over
	 * it. */
	restore_area(&well_saved);
	close_framebuffer();
	/* The terminal goes back to text on the way out: whatever happens next — a
	 * failed unlock's rescue shell, an error nobody can see otherwise — has to be
	 * readable. */
	release_console(1);
	free_image(&mark_image);
	free_image(&well_image);
	free_image(&dot_image);
	free_image(&frame_image);
}

static void fall_back_to_console_prompt(void)
{
	/* The screen is handed back and systemd's own console agent is started by
	 * hand: the path unit that would normally start it is masked so it cannot
	 * reset the terminal while the splash owns it, and this is the one case that
	 * needs it anyway. A boot that can always be unlocked matters more than a
	 * pretty one. */
	release_console(1);
	execl("/usr/bin/systemd-tty-ask-password-agent", "systemd-tty-ask-password-agent",
	      "--watch", "--console", (char *)NULL);
	/* The exec is the only way back to an answerable machine; if it fails the
	 * process must leave rather than return into a loop with no console. */
	_exit(1);
}

/* Set once the terminal has been put back to text after a finished request that
 * nothing followed: an unlock that failed must leave an error visible. */

int main(void)
{
	/* The boot journal is where a failed stage is named; the terminal and this
	 * program's own output belong to the request, not to diagnostics. */
	log_fd = open("/dev/kmsg", O_WRONLY | O_CLOEXEC);

	struct sigaction action;
	memset(&action, 0, sizeof(action));
	action.sa_handler = on_signal;
	sigaction(SIGTERM, &action, NULL);
	sigaction(SIGINT, &action, NULL);
	sigaction(SIGHUP, &action, NULL);

	/* A store into a framebuffer the kernel has already taken away raises SIGBUS;
	 * without a handler the process dies with the terminal in graphics mode. */
	memset(&action, 0, sizeof(action));
	action.sa_handler = on_fault;
	action.sa_flags = SA_RESETHAND;
	sigaction(SIGBUS, &action, NULL);
	sigaction(SIGSEGV, &action, NULL);

	/* The framebuffer belongs to whichever driver holds the display, and only one
	 * of them can blank the panel. Take the console only after checking: a boot
	 * whose display driver is not the one this program can draw on has nothing to
	 * gain from a splash, and a passphrase typed into a surface nobody scans is
	 * worse than the plain text prompt. */
	if (read_fb_driver(fb_driver, sizeof(fb_driver)) != 0) {
		boot_log("cannot read the framebuffer driver name");
		fall_back_to_console_prompt();
		return 0;
	}
	boot_log("framebuffer driver %s", fb_driver);
	if (strcmp(fb_driver, "simpledrmdrmfb") != 0) {
		boot_log("not simpledrm's framebuffer: handing over to the text prompt");
		fall_back_to_console_prompt();
		return 0;
	}

	if (take_console() != 0) {
		fall_back_to_console_prompt();
		return 0;
	}
	boot_log("console taken");

	if (open_framebuffer() != 0) {
		/* No screen to draw on: hand the console back so the text prompt can
		 * ask, rather than leaving an unanswerable boot. */
		boot_log("cannot open the framebuffer: %s", strerror(errno));
		fall_back_to_console_prompt();
		return 0;
	}
	boot_log("framebuffer %ux%u, stride %u, %u bytes per pixel", fb.width, fb.height, fb.stride,
		 fb.bytes_per_pixel);

	/* Without the well there is nothing to type into on a screen that never
	 * changes, so a missing image is a reason to leave the asking to the text
	 * prompt rather than to draw half a splash. */
	if (load_image("well.rgba", &well_image) != 0) {
		boot_log("no passphrase field image: %s", strerror(errno));
		fall_back_to_console_prompt();
		return 0;
	}
	if (load_image("frame.rgba", &frame_image) != 0) {
		boot_log("no frame image: %s", strerror(errno));
		fall_back_to_console_prompt();
		return 0;
	}
	if (prime_framebuffer() != 0) {
		boot_log("the display could not be committed");
		fall_back_to_console_prompt();
		return 0;
	}
	if (load_image("mark.rgba", &mark_image) != 0 ||
	    load_image("dot.rgba", &dot_image) != 0) {
		boot_log("a drawing asset is missing: %s", strerror(errno));
		fall_back_to_console_prompt();
		return 0;
	}

	fade_in();

	power_fd = open_power_button();

	inotify_fd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
	if (inotify_fd >= 0)
		inotify_add_watch(inotify_fd, ASK_DIR, IN_CLOSE_WRITE | IN_MOVED_TO | IN_DELETE);

	/* A request may already be waiting from before this started. */
	struct request pending;
	memset(&pending, 0, sizeof(pending));
	DIR *directory = opendir(ASK_DIR);
	if (directory != NULL) {
		struct dirent *entry;
		while ((entry = readdir(directory)) != NULL) {
			if (strncmp(entry->d_name, "ask.", 4) != 0)
				continue;
			char path[PATH_MAX];
			snprintf(path, sizeof(path), "%s/%s", ASK_DIR, entry->d_name);
			if (parse_request(path, &pending) == 0)
				break;
			memset(&pending, 0, sizeof(pending));
		}
		closedir(directory);
	}
	if (pending.active)
		answer_request(&pending);

	while (!stop_requested) {
		struct pollfd watches[3];
		int count = 0;
		int inotify_slot = -1;
		int console_slot = -1;
		int power_slot = -1;

		if (inotify_fd >= 0) {
			watches[count] = (struct pollfd){ .fd = inotify_fd, .events = POLLIN };
			inotify_slot = count++;
		}
		watches[count] = (struct pollfd){ .fd = console_fd, .events = POLLIN };
		console_slot = count++;
		if (power_fd >= 0) {
			watches[count] = (struct pollfd){ .fd = power_fd, .events = POLLIN };
			power_slot = count++;
		}

		int ready = poll(watches, (nfds_t)count, 1000);
		if (ready < 0 && errno != EINTR)
			break;

		if (power_slot >= 0 && (watches[power_slot].revents & POLLIN))
			handle_power(power_fd);

		if (inotify_slot >= 0 && (watches[inotify_slot].revents & POLLIN)) {
			char buffer[4096] __attribute__((aligned(__alignof__(struct inotify_event))));
			ssize_t got;
			while ((got = read(inotify_fd, buffer, sizeof(buffer))) > 0) {
				for (char *at = buffer; at < buffer + got;) {
					struct inotify_event *event = (struct inotify_event *)at;
					if ((event->mask & (IN_CLOSE_WRITE | IN_MOVED_TO)) != 0 &&
					    strncmp(event->name, "ask.", 4) == 0) {
						char path[PATH_MAX];
						snprintf(path, sizeof(path), "%s/%.*s", ASK_DIR,
							 (int)event->len, event->name);
						struct request incoming;
						if (parse_request(path, &incoming) == 0)
							answer_request(&incoming);
					}
					at += sizeof(struct inotify_event) + event->len;
				}
			}
		}

		/* A finished request that nothing followed means the unlock failed: the
		 * rescue shell the boot prints then must be visible, so the terminal is
		 * given back to the text console. A successful unlock switches root within
		 * seconds and never reaches this. Once the console is text again this program
		 * has no way to answer a later question, and the service's trailing
		 * `exec systemd-tty-ask-password-agent --watch --console` takes over when it
		 * exits — so it exits here instead of running on with a console it cannot
		 * read. */
		if (last_answer_ms > 0 && monotonic_ms() - last_answer_ms > IDLE_GIVE_BACK_MS) {
			boot_log("no further request: giving the console back");
			clean_up();
			return 0;
		}

		/* A keystroke with no question on screen is dropped; the console is in
		 * graphics mode, so nothing else would show it anyway. */
		if (console_slot >= 0 && (watches[console_slot].revents & POLLIN)) {
			char discard[64];
			read(console_fd, discard, sizeof(discard));
		}
	}

	clean_up();
	return 0;
}
