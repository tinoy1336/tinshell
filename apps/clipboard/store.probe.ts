/**
 * store.probe — the clipboard duplicate rule (hash dedupe) exercised directly.
 *
 * Why it exists: `append` accepts a capture by moving an EXACT content-hash
 * duplicate's existing row to the front instead of adding a second copy, and
 * the picker reads its order straight off that list — a rule no warm path
 * reports: a duplicate that wrongly appends, or a duplicate that wrongly drops
 * the capture, both look like "the picker shows what was copied". The probe
 * drives the pure decision (`promotedOrder` / `findDuplicate` / `entryHash`)
 * and the tolerant loader (`parseHistory`) that `append` is built from:
 *
 *  - an exact-hash duplicate lands at the front with its ORIGINAL id, imagePath
 *    and thumbnail and no second row,
 *  - a non-duplicate is prepended,
 *  - history written before the `hash` field existed still loads, and its text
 *    rows take part in the rule through the lazily-computed hash,
 *  - matching is exact: a whitespace difference is NOT a duplicate,
 *  - a removal drops the entry from the history AND its id from the pinned set,
 *    and an id that is not there removes nothing (the caller gets null, so no
 *    file is rewritten) instead of throwing.
 *
 * What the probe cannot pin (it writes no file): the blob and cached thumbnail
 * of a removed id are unlinked by `remove` itself — `deleteImage`, the same
 * drop the maxEntries trim and clear() perform — and they must be checked
 * against a real store (see the module's report).
 *
 * Headless and side-effect free: the pure functions only — no clipboard history
 * is read, written or deleted (the store paths are fixed, so a probe that
 * called `append` would rewrite the user's real history). The probe must stay
 * import-only for that reason.
 *
 * Run:
 *   ags bundle --gtk 4 apps/clipboard/store.probe.ts /tmp/store-probe.sh
 *   bash /tmp/store-probe.sh          # exit 1 on any violated invariant
 */
import {
  type ClipboardEntry,
  contentHash,
  entryHash,
  findDuplicate,
  parseHistory,
  promotedOrder,
  withoutEntry,
  withoutPin,
} from "./store"

const checks: [string, unknown, unknown][] = []
function check(name: string, actual: unknown, expected: unknown): void {
  checks.push([name, actual, expected])
}

// ── fixtures ──
const legacyText = '{"id":"old1","ts":1700000000000,"mime":"text","text":"hello world"}'
const hashedText = `{"id":"new1","ts":1700000001000,"mime":"text","text":"second","hash":"${contentHash("second")}"}`
const legacyImage = '{"id":"imgOld","ts":1700000002000,"mime":"image","imagePath":"img/imgOld.png"}'

// ── a hash-less legacy row still loads ──
const legacy = parseHistory(`${legacyText}\n`)
check("a legacy row with no hash loads", legacy.length, 1)
check("its id survives", legacy[0]?.id, "old1")
check("its text survives", legacy[0]?.text, "hello world")
check("it carries no stored hash", legacy[0]?.hash, undefined)
check(
  "a hashed row loads with its hash",
  parseHistory(`${hashedText}\n`)[0]?.hash,
  contentHash("second"),
)
check("both shapes load together", parseHistory(`${hashedText}\n${legacyText}\n`).length, 2)

// ── the legacy row's hash is resolved lazily from its own text ──
check(
  "a legacy text row's hash is computed from its text",
  entryHash(legacy[0]),
  contentHash("hello world"),
)
check(
  "a stored hash wins over a recomputed one",
  entryHash({ ...legacy[0], hash: "stored" }),
  "stored",
)

// ── the duplicate is found by exact hash ──
const history: ClipboardEntry[] = parseHistory(`${hashedText}\n${legacyText}\n`)
check(
  "a legacy row is found by its computed hash",
  findDuplicate(history, contentHash("hello world")),
  1,
)
check("an unknown hash is not a duplicate", findDuplicate(history, contentHash("nope")), -1)

// ── a duplicate pops to front: same row, same id, no second copy ──
const recopied: ClipboardEntry = {
  id: "fresh-id",
  ts: 1700000009000,
  mime: "text",
  text: "hello world",
  hash: contentHash("hello world"),
}
const popped = promotedOrder(history, recopied)
check("a duplicate does not grow history", popped.length, history.length)
check(
  "the duplicate's own entry is not stored",
  popped.some((e) => e.id === "fresh-id"),
  false,
)
check("the existing row keeps its id", popped[0]?.id, "old1")
check("the existing row keeps its ts", popped[0]?.ts, 1700000000000)
check("the duplicate is now the first row", popped[0]?.text, "hello world")
check("the rest keeps its order", popped.map((e) => e.id).join(","), "old1,new1")

// ── re-copying the row already at the front is a no-op, not a second row ──
const again = promotedOrder(popped, { ...recopied, id: "fresh-id-2" })
check("a front-row re-copy stays one row", again.length, popped.length)
check("and keeps the same front id", again[0]?.id, "old1")

// ── a non-duplicate is prepended ──
const fresh: ClipboardEntry = {
  id: "brand-new",
  ts: 1700000010000,
  mime: "text",
  text: "third",
  hash: contentHash("third"),
}
const appended = promotedOrder(history, fresh)
check("a non-duplicate grows history", appended.length, history.length + 1)
check("it lands at the front", appended[0]?.id, "brand-new")
check(
  "nothing else moves",
  appended
    .slice(1)
    .map((e) => e.id)
    .join(","),
  "new1,old1",
)

// ── exact matching: no trimming, no whitespace normalisation ──
const padded: ClipboardEntry = {
  id: "padded",
  ts: 1700000011000,
  mime: "text",
  text: "hello world ",
  hash: contentHash("hello world "),
}
check("a trailing space is a different content", promotedOrder(history, padded)[0]?.id, "padded")
check("so it is not a duplicate", findDuplicate(history, contentHash("hello world ")), -1)

// ── a hash-less image row takes no part in the rule (its PNG is not re-read) ──
const withLegacyImage = parseHistory(`${legacyImage}\n`)
check("a hash-less image row still loads", withLegacyImage.length, 1)
check("its hash stays unresolved", entryHash(withLegacyImage[0]), null)
check(
  "an image capture is not matched against it",
  findDuplicate(withLegacyImage, contentHash("image bytes")),
  -1,
)

// ── removal: the entry goes, its pin goes, an unknown id is a no-op ──
const remaining = withoutEntry(history, "old1")
check("removing an entry leaves the rest", remaining?.length, history.length - 1)
check(
  "the removed id is gone from the parsed history",
  remaining?.some((e) => e.id === "old1"),
  false,
)
check("the surviving rows keep their order", remaining?.map((e) => e.id).join(","), "new1")
check("an unknown id removes nothing", withoutEntry(history, "no-such-id"), null)
check("removing history that is already empty is a no-op", withoutEntry([], "old1"), null)
check(
  "removing the LAST row yields an empty list, not a no-op",
  withoutEntry(parseHistory(`${legacyText}\n`), "old1")?.length,
  0,
)

const pinSet = new Set(["old1", "new1"])
const unpinned = withoutPin(pinSet, "old1")
check("a removal unpins the id", unpinned?.has("old1"), false)
check("and keeps every other pin", unpinned?.has("new1"), true)
check("an unknown id is not a pin removal", withoutPin(pinSet, "no-such-id"), null)
check("the caller's pin set is left untouched", pinSet.has("old1"), true)

const failed = checks.filter(([, actual, expected]) => actual !== expected)
for (const [name, actual, expected] of checks) {
  const ok = actual === expected
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`,
  )
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`store probe failed: ${failed.length} check(s)`)
