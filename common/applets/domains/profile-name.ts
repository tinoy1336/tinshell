import type { TlpProfile } from "@common/applets/types"

/** Map the power daemon's `ActiveProfile` string onto the applet's union.
 *
 *  Anything the daemon does not name — a spelling it never uses, a profile a
 *  future release adds, an empty reply — is `unknown`, NEVER `balanced`: a
 *  silent default is then applied downstream as a reading. Two consumers depend
 *  on that distinction — `domains/tlp.ts` arms its `tlp-stat` fallback only on
 *  `unknown`, and the performance applet refuses to switch profiles from an
 *  unanswered read.
 *
 *  gi-free on purpose: the mapping is pure, so it lives beside its DBus owner
 *  rather than inside it and is covered by a plain-node probe. */
export function profileFromString(value: string): TlpProfile {
  if (value === "performance") return "performance"
  if (value === "balanced") return "balanced"
  if (value === "power-saver") return "power-saver"
  return "unknown"
}
