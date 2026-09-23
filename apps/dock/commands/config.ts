/**
 * dock/commands/config.ts — config subcommand handlers.
 *
 * Registers `config reload`, `config get`, `config set`, and `config update`
 * with the command registry. Owns the atomic mutation serialization chain
 * (`setChain` / `commitBatch`) — no other module touches live config mutation
 * through the command interface.
 */

import { geo } from "@common/applets/utils/geo-log"
import { register } from "@common/commands/registry"
import { setDottedPath } from "@common/config/loader"
import { config, dock } from "../config"
import { safeClone } from "../config-clone"
import { rebuildDocks, redrawAllDocks } from "../Dock"

// ── Registration (runs at import time) ──

register(["dock", "config", "reload"], handleReload)
register(["dock", "config", "get"], handleGet)
register(["dock", "config", "set"], handleSet)
register(["dock", "config", "update"], handleUpdate)

// ── Serialization chain ──
// All config mutations (set + update) serialize through one Promise chain so
// clone→validate→write→apply runs as a critical section per request.

let setChain: Promise<void> = Promise.resolve()

// ── Handlers ──

type Respond = (response: string) => void

async function handleReload(_args: string[], res: Respond): Promise<void> {
  const { ok, error, warnings } = await dock.reload()
  if (!ok) {
    const detail = warnings.length ? " — " + warnings.join("; ") : ""
    res("error: " + (error ?? "reload failed") + detail)
    return
  }
  geo("config", { event: "reload", position: (config as any).layout?.position ?? "?" })
  rebuildDocks()
  res("reloaded")
}

function handleGet(args: string[], res: Respond): void {
  const path = args[0]
  if (!path) {
    res("error: usage: config get <path>")
    return
  }
  const v = dock.get(path)
  if (v === undefined) {
    res("error: unknown path: " + path)
    return
  }
  res(JSON.stringify(v))
}

function handleSet(args: string[], res: Respond): void {
  const path = args[0]
  const valueRaw = args.slice(1).join(" ")
  if (!path || !valueRaw) {
    res("error: usage: config set <path> <value>")
    return
  }
  let value: any
  try {
    value = JSON.parse(valueRaw)
  } catch {
    value = valueRaw
  }
  runBatch([{ path, value }], res)
}

function handleUpdate(args: string[], res: Respond): void {
  const raw = args.join(" ")
  let obj: any
  try {
    obj = JSON.parse(raw)
  } catch (e) {
    res("error: malformed JSON: " + e)
    return
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    res('error: update requires a JSON object of { "path": value }')
    return
  }
  const pairs = Object.entries(obj).map(([path, value]) => ({ path, value }))
  if (pairs.length === 0) {
    res("error: update object was empty")
    return
  }
  runBatch(pairs, res)
}

// ── Batch commit ──

/** Serialize a batch through setChain so set/update can't interleave. */
function runBatch(pairs: { path: string; value: any }[], res: Respond): void {
  setChain = setChain
    .then(() => commitBatch(pairs))
    .then(
      (msg) => res(msg),
      (msg) => res(msg),
    )
}

/** Atomic batch commit: validate all → write → apply → dispatch by tier. */
async function commitBatch(pairs: { path: string; value: any }[]): Promise<string> {
  // 1. Validate every pair against the schema before touching anything.
  const { ok, errors } = dock.validateBatch(pairs)
  if (!ok) return "error: " + errors.join("; ")

  // 2. Clone live config, apply each pair (the clone is the commit target; the
  //    live tree mutates only after the write, step 4).
  const clone = safeClone(config)
  for (const { path, value } of pairs) {
    if (!setDottedPath(clone, path, safeClone(value))) {
      return "error: cannot set " + path
    }
  }

  // 3. Write. Live config mutates only after a successful file write. The
  //    write is serialized with other writers (move-mode snap, Position)
  //    so an earlier in-flight write can't clobber this one.
  if (!(await dock.queueWrite(clone))) return "error: write failed"

  // 4. Apply to live in place.
  dock.applyToLive(clone)

  // 5. Dispatch by tier.
  const tiers = pairs.map((p) => dock.tierOf(p.path))
  if (tiers.includes("baked")) {
    const paths = pairs.map((p) => p.path).join(", ")
    geo("config", { event: "set-baked", paths, position: (clone as any).layout?.position ?? "?" })
    rebuildDocks()
  } else if (tiers.includes("live")) redrawAllDocks()
  const note = tiers.includes("restart") ? " (poll intervals take effect on restart)" : ""
  return "ok" + note
}
