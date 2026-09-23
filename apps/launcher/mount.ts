/**
 * launcher app — the launcher surface as a REAL standalone app
 * (bus io.Astal.launcher). Sources live here (Launcher.tsx, sources,
 * combiner, types, utils). Production runs inside the shell (universal entry); this
 * island is the DEV shape.
 *
 * Config: the launcher's OWN store + facade (apps/launcher/config.ts owns
 * the createConfigStore instance; generic facade from common/config/facade.ts).
 */
import "./commands"
import "@common/log/debug-log" // sets the ONE sink (file /tmp/tinshell-debug.log)
import theme from "@common/shell/theme.css"
import { setControl } from "./commands"
import { buildLauncherEmojiCss } from "./emoji-style"
import Launcher, { launcherControl } from "./Launcher"
import { reload as appsReload } from "./sources/apps"
import style from "./style.css"

export const launcherCss = `${theme}\n${style}\n${buildLauncherEmojiCss()}`

/** Launcher: window once + control surface + eager app index. */
export function launcherMount(): void {
  // Build the window once; its $ callback publishes the control surface,
  // which the dispatcher gets here.
  Launcher()
  setControl(launcherControl())
  // Index apps eagerly so the first query is instant.
  appsReload()
}
