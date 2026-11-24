# AGENTS.md — the boot screen

The passphrase screen the boot draws between the firmware and this greeter. It runs from the
initramfs, not from a session and not from the greeter bundle: dracut carries it into every boot
image, systemd starts it as `tinshell-splash.service` before the root volume is asked for, and it
owns the panel until the boot switches root.

## Files

```text
boot/
├── tinshell-splash.c                the program (C, no toolkit, no library)
├── config.defaults.json             the sizes, timings and positions it is built with
├── config.schema.ts                 their schema (generated: config.schema.json)
├── module-setup.sh                  the dracut module that packs program + pixels + units
├── tinshell-splash.service          starts it as the first units of the boot image run
├── tinshell-splash-fallback.service the way back: the text prompt when the splash is masked
├── 50-tinshell-splash.conf          adds the module to every image and keeps plymouth out
├── zz-tinshell-splash.conf          keeps amdgpu out of every image (see below)
└── tinshell-boot-refresh            derives everything else and rebuilds the images
```

`tinshell-boot-refresh` is the only build step. It paints the images the program reads at the
pixel size the panel draws them (the boot image has neither an image decoder nor a toolkit, so
nothing is resampled at boot), reduces them to raw RGBA beside the program, compiles it static
into the dracut module, then rebuilds the initramfs, the unified kernel image and the GRUB menu.
A missing program or a missing image fails the image build rather than producing a boot with no
passphrase screen.

`apps/greeter/install.sh` installs the files at `/usr/lib/dracut/modules.d/80tinshell-splash/`,
`/usr/lib/systemd/system/tinshell-splash{,-fallback}.service`, `/etc/dracut.conf.d/`, and
`/usr/local/src/tinshell-splash/` (program, config and its schema) plus
`/usr/local/sbin/tinshell-boot-refresh`, then runs the refresh. `--no-boot` skips all of it.

## Config

The splash declares its own settings the way every app in this tree does: `config.schema.ts` is the
TypeBox source, `config.schema.json` is generated from it by `scripts/gen-config-schemas.ts` (the
generator reads directories one level inside an app as well, which is how this one is found), and
`config.defaults.json` carries the values. They are all `baked`: `tinshell-boot-refresh` reads the
defaults, paints the images at those sizes and compiles the program with those timings and
positions, so nothing here is read after the boot images are built.

The images and colours are not in the tree. The mark is the distribution's artwork and the palette
is the machine's, so both come from the machine's own declaration; the refresh refuses to run when
either is missing rather than shipping a splash drawn in defaults.

## Why it is drawn this way

The firmware leaves its own frame on the panel and this program paints that same frame into the
buffer it draws, commits the buffer, and only then adds the passphrase well. A program that only
writes to `/dev/fb0` without committing draws into memory the display is not scanning, which is a
passphrase typed blind.

The commit is done on `simpledrm`, which maps the firmware's framebuffer and copies the picture
into it: it programs no display controller and cannot blank the panel. `amdgpu` is the driver on
this hardware that can blank it, so `zz-tinshell-splash.conf` keeps it out of every boot image
with a bare `force_drivers=` (dracut reads that after the package's own `eos_amd_amdgpu.conf`)
plus `omit_drivers+=" amdgpu "`. `amdgpu` stays in the real root and udev loads it after the root
volume is unlocked, which is why the splash's commit is a memory copy rather than a mode set.
Every commit is checked: a refused commit, an unexpected driver or a missing image hands the
console to systemd's text prompt instead of drawing into a surface nobody scans.

The console stays in graphics mode for the lifetime of the program, so nothing paints over the
picture; the program answers the unlock's request itself, from `/run/systemd/ask-password`, and
draws one dot per typed character.

## What it draws, and when

One thing at a time, in the same box. The passphrase field fades in ten steps of a tenth of the
picture sixty milliseconds apart; there is no mark on screen while it is up. The field leaves only
when a passphrase is accepted, which is read from the root volume's device appearing
(`rd.luks.name=…=cryptroot`) — a refused answer is followed by another question within seconds,
and the field has to be there for it.

On acceptance the field is replaced by the mark in a single refresh: the pixels the field covered
are put back, the mark is drawn where the field was, and one commit shows the result, so the screen
never carries half of each. The mark is never saved or restored — it is the picture the program
leaves behind, and the teardown keeps it by restoring nothing but the field. Everything the splash
holds back therefore stays inside the box that was the field.

There is no animation on that path and no second, independent phase, because there is nowhere for
one to run: the answer reaches cryptsetup, the volume activates and systemd stops the unit at the
switch of root within a few hundred milliseconds, so anything after the reveal is cut off by the
boot itself. Everything after that — until the graphics driver initialises and greetd paints — has
no process owning the display.

## Verifying it shipped

Both images carry their own copy of the program, so check the contents, never the install:

```sh
sudo lsinitrd /boot/initramfs-linux.img | grep -oE '(usr/libexec/tinshell-splash/[a-z.-]*|sysinit.target.wants/tinshell-splash[a-z-]*\.service)' | sort -u
sudo sh -c 'objcopy -O binary --only-section=.initrd /efi/EFI/Linux/arch.efi /tmp/uki.img'
sudo lsinitrd /tmp/uki.img | grep -cE 'tinshell-splash'
```

The program logs one line per stage to the boot journal under the `tinshell-splash` prefix: the
driver behind `fb0`, the framebuffer geometry, the display commit, and the frame asset. A failure
names itself there instead of showing as a frozen picture. `systemd.mask=tinshell-splash.service`
on the kernel command line makes the fallback unit ask for the passphrase on the text console.
