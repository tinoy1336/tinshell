/**
 * autofill.probe — the Tab fill's CASING rule (common/path/autofill.ts).
 *
 * Completion matches case-insensitively, so a typed path can disagree with the
 * entry's real name in case. The entry then has to take the ENTRY's casing:
 * typing `~/bio/chapter` must fill `~/bio/Chapter 1 - Exploring Life.pdf`, and
 * the shaded ghost starts at that divergence so keyboarding on from the fill
 * lands on the real name. The probe drives the real cycle over its own fixture
 * directory, in both the `~` and absolute forms, with a bang prefix present, so
 * the display/expanded index mapping is exercised and not just the append case.
 *
 * Run (bundled — this module imports GLib/Gio through the autofill graph):
 *   ags bundle --gtk 4 common/path/autofill.probe.ts /tmp/autofill-probe.sh
 *   timeout 90 bash /tmp/autofill-probe.sh
 */
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { createPathAutofill, type PathAutofillResult } from "./autofill.ts"

const checks: [string, unknown, unknown][] = []
const check = (name: string, actual: unknown, expected: unknown): void => {
  checks.push([name, actual, expected])
}

const scratch = GLib.build_filenamev([
  GLib.get_tmp_dir(),
  `autofill-probe-${GLib.uuid_string_random()}`,
])
const bio = GLib.build_filenamev([scratch, "bio"])
const file = GLib.build_filenamev([bio, "Chapter 1 - Exploring Life.pdf"])
const pictures = GLib.build_filenamev([bio, "Pictures"])

const remove = (path: string): void => {
  if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return
  if (GLib.file_test(path, GLib.FileTest.IS_DIR)) {
    const dir = Gio.File.new_for_path(path)
    const children = dir.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
    for (;;) {
      const info = children.next_file(null)
      if (!info) break
      remove(GLib.build_filenamev([path, info.get_name()]))
    }
    children.close(null)
    GLib.rmdir(path)
    return
  }
  GLib.unlink(path)
}

// Fixture: a mixed-case file (a space in the name) and a mixed-case directory.
GLib.mkdir_with_parents(bio, 0o755)
GLib.file_set_contents(file, "")
GLib.mkdir_with_parents(pictures, 0o755)

// The `~` form is the real surface, so point home at the fixture root. Set
// before the first home lookup so GLib's cache seeds from it.
GLib.setenv("HOME", scratch, true)

// Extract: a `!p ` bang prefix stays outside the completed path.
const extract = (text: string): string | null => {
  const m = /^!p (.*)$/.exec(text)
  return m ? m[1] : text
}

const tab = (text: string): PathAutofillResult | null => {
  const autofill = createPathAutofill({ extract })
  return autofill.onTab(text, false)
}

try {
  check("home resolves to the fixture root", GLib.get_home_dir(), scratch)

  // ── the reported case: a typed lower-case name gets the ENTRY's casing ──
  check("tilde form takes the entry's casing", tab("!p ~/bio/chapter"), {
    text: "!p ~/bio/Chapter 1 - Exploring Life.pdf",
    committedLen: "!p ~/bio/".length,
  })
  check("absolute form takes the entry's casing", tab(`${bio}/chapter`), {
    text: file,
    committedLen: `${bio}/`.length,
  })
  check("a directory is filled in its own casing", tab("!p ~/bio/pict"), {
    text: "!p ~/bio/Pictures/",
    committedLen: "!p ~/bio/".length,
  })

  // ── no divergence: the typed casing is already the entry's, so the typed
  // part stays committed and only the remainder is the ghost ──
  check("an exactly-cased prefix stays committed", tab("!p ~/bio/Chap"), {
    text: "!p ~/bio/Chapter 1 - Exploring Life.pdf",
    committedLen: "!p ~/bio/Chap".length,
  })

  // ── the cycle: one candidate, so a second Tab keeps the same fill ──
  const cycle = createPathAutofill({ extract })
  const first = cycle.onTab("!p ~/bio/chapter", false)
  const second = cycle.onTab(first?.text ?? "", false)
  check("a repeated Tab keeps the fill", second, first)

  // ── accept commits the fill literally; a directory fill ends with "/" so the
  // next Tab descends into it ──
  const accept = createPathAutofill({ extract })
  const offered = accept.onTab("~/bio/pict", false)
  check("accept commits the filled directory", accept.onAccept(offered?.text ?? ""), {
    text: "~/bio/Pictures/",
    committedLen: "~/bio/Pictures/".length,
  })

  // ── nothing to complete stays nothing ──
  check("a name nobody has fills nothing", tab("!p ~/bio/nope"), null)
} finally {
  remove(scratch)
  check("the fixture directory is gone", GLib.file_test(scratch, GLib.FileTest.EXISTS), false)
}

const failed = checks.filter(
  ([, actual, expected]) => JSON.stringify(actual) !== JSON.stringify(expected),
)
for (const [name, actual, expected] of checks) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`,
  )
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`autofill probe failed: ${failed.length} check(s)`)
