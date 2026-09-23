/**
 * exec-fields.probe — reproducible probe for the Exec field-code expansion
 * (apps/launcher/sources/exec-fields.ts).
 *
 * Pure module, no gi, no GTK: it asserts what each field code expands to, what
 * a launch omits when it carries no file, and that a literal `%%` is never
 * mistaken for a placeholder. The defect it pins: an entry whose Exec declares
 * `%f` must receive the file the launch carries, and must run WITHOUT an
 * argument when the launch carries none (never an empty one).
 *
 * Run:  node --experimental-strip-types apps/launcher/sources/exec-fields.probe.ts
 */
import { type ExecFields, expandExec } from "./exec-fields.ts"

const one = (files: string[]): ExecFields => ({ files })

const checks: [string, unknown, unknown][] = []
function check(name: string, actual: unknown, expected: unknown): void {
  checks.push([name, actual, expected])
}
const eq = (name: string, argv: string[], fields: ExecFields, expected: string[]): void =>
  check(name, JSON.stringify(expandExec(argv, fields)), JSON.stringify(expected))

// ── the reported defect: a file placeholder gets the launch's file ──
eq("%f takes the file", ["/e.sh", "%f"], one(["/tmp/shot.png"]), ["/e.sh", "/tmp/shot.png"])
eq("%f keeps a path with spaces one argument", ["/e.sh", "%f"], one(["/tmp/a b.png"]), [
  "/e.sh",
  "/tmp/a b.png",
])
eq("no file omits the argument", ["/e.sh", "%f"], {}, ["/e.sh"])
eq("no file omits it from the middle", ["/e.sh", "%f", "--x"], {}, ["/e.sh", "--x"])
eq("no file omits %F", ["/e.sh", "%F"], {}, ["/e.sh"])
eq("%F takes every file", ["/e.sh", "%F"], one(["a.png", "b.png"]), ["/e.sh", "a.png", "b.png"])
eq("%f of several files takes the first", ["/e.sh", "%f"], one(["a", "b"]), ["/e.sh", "a"])

// ── URLs ──
eq("%u takes the url", ["/b", "%u"], { urls: ["https://x/y"] }, ["/b", "https://x/y"])
eq("%U takes every url", ["/b", "%U"], { urls: ["https://x", "https://y"] }, [
  "/b",
  "https://x",
  "https://y",
])
eq("no url omits %u", ["/b", "%u"], {}, ["/b"])

// ── name / desktop path / icon ──
eq("%c takes the name", ["/e.sh", "%c"], { name: "Annotate" }, ["/e.sh", "Annotate"])
eq("%c of an unnamed entry is omitted", ["/e.sh", "%c"], {}, ["/e.sh"])
eq("%k takes the entry path", ["/e.sh", "%k"], { desktopPath: "/x/y.desktop" }, [
  "/e.sh",
  "/x/y.desktop",
])
eq("%k of an entry with no file is omitted", ["/e.sh", "%k"], {}, ["/e.sh"])
eq("%i becomes --icon plus the icon", ["/a", "%i"], { iconName: "applications-graphics" }, [
  "/a",
  "--icon",
  "applications-graphics",
])
eq("%i without an icon is omitted", ["/a", "%i"], {}, ["/a"])

// ── literal percent ──
eq("%% is a literal percent", ["/e.sh", "100%%"], {}, ["/e.sh", "100%"])
eq("%%f is not a placeholder", ["/e.sh", "%%f"], one(["file"]), ["/e.sh", "%f"])
eq("a lone percent survives", ["/e.sh", "%"], {}, ["/e.sh", "%"])

// ── dropped codes: deprecated or unknown ──
for (const code of ["%d", "%D", "%n", "%N", "%v", "%m", "%x"]) {
  eq(`${code} is dropped`, ["/e.sh", code], one(["f"]), ["/e.sh"])
}

// ── tokens without a code are passed through untouched ──
eq("plain argv is untouched", ["/e.sh", "--flag", "value"], one(["f"]), [
  "/e.sh",
  "--flag",
  "value",
])
eq("an empty argument without a code survives", ["/e.sh", ""], {}, ["/e.sh", ""])
eq("an embedded code is substituted in place", ["/e.sh", "--file=%f"], one(["/tmp/a.png"]), [
  "/e.sh",
  "--file=/tmp/a.png",
])
eq("an embedded code with no value leaves its prefix", ["/e.sh", "--file=%f"], {}, [
  "/e.sh",
  "--file=",
])
eq("every code of a token expands", ["%c-%k"], { name: "Annotate", desktopPath: "/x.desktop" }, [
  "Annotate-/x.desktop",
])

const failed = checks.filter(([, actual, expected]) => actual !== expected)
for (const [name, actual, expected] of checks) {
  const ok = actual === expected
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${actual}, want ${expected}`}`)
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`exec-fields probe failed: ${failed.length} check(s)`)
