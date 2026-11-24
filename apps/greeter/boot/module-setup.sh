#!/bin/bash
# Put the tinshell boot screen into the initramfs: one static program, the pixels it
# draws, and the unit that starts it. Plymouth is not installed by this module
# and is not wanted in the image at all, because two programs cannot own the
# screen.
#
# The program and its images are built by tinshell-boot-refresh before dracut runs,
# so this module only carries them.

check() {
	# The binary is generated, not committed: refuse to build an image whose
	# passphrase screen would be missing, since the console prompt that would
	# otherwise appear is exactly what this replaces.
	[[ -x "$moddir/tinshell-splash" ]] || {
		echo "80tinshell-splash: $moddir/tinshell-splash is missing — run tinshell-boot-refresh" >&2
		return 1
	}
	[[ -r "$moddir/mark.rgba" && -r "$moddir/well.rgba" && -r "$moddir/dot.rgba" && \
	   -r "$moddir/frame.rgba" ]] || {
		echo "80tinshell-splash: the splash images are missing — run tinshell-boot-refresh" >&2
		return 1
	}
	return 0
}

depends() {
	echo systemd-udevd
	return 0
}

install() {
	# The program goes into a directory of its own: the images sit beside it, and a
	# binary installed as the directory's own path would make them uninstallable.
	inst_simple "$moddir/tinshell-splash" /usr/libexec/tinshell-splash/tinshell-splash
	inst_simple "$moddir/mark.rgba" /usr/libexec/tinshell-splash/mark.rgba
	inst_simple "$moddir/well.rgba" /usr/libexec/tinshell-splash/well.rgba
	inst_simple "$moddir/dot.rgba" /usr/libexec/tinshell-splash/dot.rgba
	# The frame is what the panel shows once the program commits the display:
	# without it the program leaves the firmware's own framebuffer in place and
	# draws onto a buffer nobody scans.
	inst_simple "$moddir/frame.rgba" /usr/libexec/tinshell-splash/frame.rgba
	inst_multiple "$systemdsystemunitdir/tinshell-splash.service" \
		"$systemdsystemunitdir/tinshell-splash-fallback.service"

	$SYSTEMCTL -q --root "$initdir" enable tinshell-splash.service
	$SYSTEMCTL -q --root "$initdir" enable tinshell-splash-fallback.service

	# systemd's own console agent must not run beside the splash. It takes
	# /dev/console, switches the terminal back to text and turns echo on before
	# it asks anything, which would both paint over the picture and print the
	# passphrase as it is typed.
	mkdir -p "$initdir/etc/systemd/system"
	ln -sf /dev/null "$initdir/etc/systemd/system/systemd-ask-password-console.path"
	ln -sf /dev/null "$initdir/etc/systemd/system/systemd-ask-password-console.service"
}
