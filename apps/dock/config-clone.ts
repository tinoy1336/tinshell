/**
 * dock/config-clone.ts — the DETACHED copy every dock config write path stages
 * before handing a tree to `dock.queueWrite`.
 *
 * A write path never mutates the live config object: it clones, applies its
 * change to the clone, queues the write, and applies the clone to live only
 * once the file write succeeded. The clone is a JSON round-trip because the
 * dock config is plain JSON; a value the round-trip cannot carry (a cycle, a
 * bigint, `undefined`) falls back to the original rather than throwing in the
 * middle of a commit — the write then carries what the caller passed.
 *
 * ONE implementation: the move-mode snap persist (`dock-row.ts`) and the
 * `config set|update` batch commit (`commands/config.ts`) both stage through
 * here.
 */
export function safeClone<T>(v: T): T {
  try {
    return JSON.parse(JSON.stringify(v)) as T
  } catch {
    return v
  }
}
