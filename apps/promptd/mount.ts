/**
 * promptd mount — the prompt/input dialog service builder.
 *
 * Shared by the island app.ts (instanceName "promptd", io.Astal.promptd,
 * unit tinshell-promptd.service — the DEV island) and the shell instance.
 * ONE window is created at startup and shown on demand by the request
 * handlers (no window churn, launcher pattern).
 */
import "./commands" // side-effect: registers request handlers against the shared registry
import theme from "@common/shell/theme.css"
import { setControl } from "./commands"
import Prompt, { promptControl } from "./Prompt"
import style from "./style.css"

export const promptdCss = theme + "\n" + style

export function mountPromptd(): void {
  // Build the window once; hand its prompt control surface to the request
  // dispatcher (the window stays alive through the control closures).
  Prompt()
  setControl(promptControl())
}
