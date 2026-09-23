#!/usr/bin/env node
import { execFileSync } from "node:child_process"
// check-paths — the portability gate: no tracked file may name where this
// checkout happens to live.
//
//   node scripts/check-paths.mjs [--allow-owner-home=<user>] [--allow-file=<path>] [--quiet]
//
// The reader's own runtime environment is not a hit: the home directory (`~`,
// `$HOME`, the `__HOME__` install-time token), the XDG directories, a tool's
// own state dir, `/etc`, `/usr`, `/var`, `/tmp`. What is a hit is a reference
// that only resolves on the machine this was written on.
//
// Detectors (a hit is one line matching one detector):
//   D1 foreign-home       /home/<name>/… or /Users/<name>/… — a home that is not
//                         the reader's. A machine-configuration repository (a
//                         dotfiles home) passes --allow-owner-home=<user> for its
//                         own home, which its README documents as machine-specific
//   D2 checkout-location  ~/<dev|src|code|projects|git|repos|checkout|workspace>/…
//                         and the same under $HOME/, ${HOME}/, __HOME__/ — the
//                         class that assumes where the tree was cloned
//   D3 runtime-id         /run/user/<uid>, uid[-_]<digits>
//   D4 foreign-uid-home   /home/<digits>/…
//
// Accepted exceptions live in `.portability-allow.txt` at the repository root,
// one per line, with the reason written on the same line so an accepted
// reference is justified in the diff that adds it:
//
//   <path>:<line>|<detector>|<reason>
//
// `--allow-file=<path>` reads that record from somewhere else, for a repository
// whose root is not the place to keep it. An entry that matches nothing is
// reported as stale — the reference it excused has moved or gone.
//
// Exit 1 on any unaccepted hit, 0 clean.
import { existsSync, readFileSync } from "node:fs"

const args = process.argv.slice(2)
const ownerHome =
  (args.find((a) => a.startsWith("--allow-owner-home=")) || "").split("=")[1] || null
const allowFile =
  (args.find((a) => a.startsWith("--allow-file=")) || "").split("=")[1] || ".portability-allow.txt"
const quiet = args.includes("--quiet")

const CHECKOUT = "dev|src|code|projects|git|repos|checkout|workspace"
const DETECTORS = [
  ["D1", "foreign-home", /(?<![\w.-])\/home\/(?!\d)[A-Za-z0-9._-]+\//],
  ["D1", "foreign-home", /(?<![\w.-])\/Users\/[A-Za-z0-9._-]+\//],
  ["D4", "foreign-uid-home", /(?<![\w.-])\/home\/\d+\//],
  ["D2", "checkout-location", new RegExp(`(?<![\\w.-])~/(${CHECKOUT})/`)],
  ["D2", "checkout-location", new RegExp(`\\$(?:\\{HOME\\}|HOME)/(${CHECKOUT})/`)],
  ["D2", "checkout-location", new RegExp(`__HOME__/(${CHECKOUT})/`)],
  ["D3", "runtime-id", /\/run\/user\/\d+/],
  ["D3", "runtime-id", /uid[-_]?\d{3,}/],
]

const ALLOW_FILE = allowFile

/** `path:line|detector|reason` — the reason is required. */
function readAllowlist() {
  if (!existsSync(ALLOW_FILE)) return []
  return readFileSync(ALLOW_FILE, "utf8")
    .split("\n")
    .map((raw) => raw.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [target, detector, ...reason] = line.split("|")
      const at = target.lastIndexOf(":")
      return {
        target,
        rel: target.slice(0, at),
        line: Number(target.slice(at + 1)),
        detector,
        reason: reason.join("|").trim(),
        raw: line,
      }
    })
}

const allow = readAllowlist()
const used = new Set()
const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
const findings = []
let scanned = 0
for (const rel of files) {
  // The allowlist is the record of accepted references — its own reason lines
  // name the paths they excuse, so it is never scanned as content.
  if (rel === ALLOW_FILE) continue
  if (!existsSync(rel)) continue
  let buf
  try {
    buf = readFileSync(rel)
  } catch {
    continue
  }
  if (buf.includes(0)) continue // binary
  if (buf.length > 4 * 1024 * 1024) continue
  scanned++
  const lines = buf.toString("utf8").split("\n")
  for (let i = 0; i < lines.length; i++) {
    for (const [cls, name, rx] of DETECTORS) {
      const m = rx.exec(lines[i])
      if (!m) continue
      if (cls === "D1" && ownerHome) {
        const home = (lines[i].match(/\/home\/([A-Za-z0-9._-]+)\//) || [])[1]
        if (home === ownerHome) continue // this machine-config repository's own home
      }
      const entry = allow.find((a) => a.rel === rel && a.line === i + 1 && a.detector === name)
      if (entry) {
        used.add(entry.raw)
        continue
      }
      findings.push({
        cls,
        name,
        rel,
        line: i + 1,
        ref: m[0],
        text: lines[i].trim().slice(0, 160),
        target: `${rel}:${i + 1}`,
      })
    }
  }
}

if (!quiet) {
  for (const f of findings) {
    console.log(`${f.rel}:${f.line}: ${f.cls} ${f.name}: \`${f.ref}\` — ${f.text}`)
    console.log(`    fix it, or accept it with \`${f.target}|${f.name}|<reason>\` in ${ALLOW_FILE}`)
  }
}
const stale = allow.filter((a) => !used.has(a.raw))
if (stale.length && !quiet) {
  for (const a of stale) console.log(`stale ${ALLOW_FILE} entry (nothing matched): ${a.raw}`)
}
const accepted = used.size
console.log(
  `\nportability: ${findings.length} hit(s) in ${new Set(findings.map((f) => f.rel)).size} file(s), ${scanned} tracked text file(s) scanned, ${accepted} accepted` +
    (stale.length ? `, ${stale.length} stale entr(ies)` : "") +
    (findings.length
      ? " — fix, or accept one with a `.portability-allow.txt` entry"
      : " — no unaccepted hit"),
)
process.exit(findings.length ? 1 : 0)
