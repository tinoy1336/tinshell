import "../overrides.js"
import Gdk from "gi://Gdk?version=4.0"
import Gio from "gi://Gio?version=2.0"
import Gtk from "gi://Gtk?version=4.0"
import GObject from "gnim/gobject"

type StartConfig = Partial<{
  instanceName: string
  css: string
  icons: string
  gtkTheme: string
  iconTheme: string
  cursorTheme: string
  main(...argv: string[]): void
  requestHandler(argv: string[], res: (response: any) => void): void
}>
interface AppSignals extends Gtk.Application.SignalSignatures {
  request: App["request"]
  "window-toggled": App["windowToggled"]
}
declare class App extends Gtk.Application {
  #private
  $signals: AppSignals
  get instanceName(): string
  /**
   * Get all monitors from {@link Gdk.Display}.
   */
  get_monitors(): Gdk.Monitor[]
  private windowToggled
  /**
   * Get all monitors from {@link Gdk.Display}.
   */
  get monitors(): Array<Gdk.Monitor>
  /**
   * Windows that has been added to this app
   * using {@link Gtk.Application.prototype.add_window}.
   */
  get windows(): Array<Gtk.Window>
  /**
   * Shortcut for {@link Gtk.Settings.prototype.gtkThemeName}
   */
  set gtkTheme(name: string)
  /**
   * Shortcut for {@link Gtk.Settings.prototype.gtkThemeName}
   */
  get gtkTheme(): string
  /**
   * Shortcut for {@link Gtk.Settings.prototype.gtkIconThemeName}
   */
  set iconTheme(name: string)
  /**
   * Shortcut for {@link Gtk.Settings.prototype.gtkIconThemeName}
   */
  get iconTheme(): string
  /**
   * Shortcut for {@link Gtk.Settings.prototype.gtkCursorThemeName}
   */
  set cursorTheme(name: string)
  /**
   * Shortcut for {@link Gtk.Settings.prototype.gtkCursorThemeName}
   */
  get cursorTheme(): string
  /**
   * Get a window by its {@link Gtk.Widget.prototype.name} that has been added to this app
   * using {@link Gtk.Application.prototype.add_window}.
   */
  get_window(name: string): Gtk.Window | undefined
  /**
   * Toggle the visibility of a window by its {@link Gtk.Widget.prototype.name}
   * that has been added to this app using {@link Gtk.Application.prototype.add_window}.
   */
  toggle_window(name: string): void
  /**
   * Reset previously set css providers with {@link App.prototype.apply_css}.
   */
  reset_css(): void
  /**
   * Add a new {@link Gtk.CssProvider}.
   * @param style Css string or a path to a css file.
   */
  apply_css(style: string, reset?: boolean): void
  /**
   * Shortcut for {@link Gtk.IconTheme.prototype.add_search_path}.
   */
  add_icons(path: string): void
  /**
   * Quit and exit the application.
   */
  quit(code?: number): void
  constructor()
  private request
  vfunc_command_line(cmd: Gio.ApplicationCommandLine): number
  start(config: StartConfig): void
  connect<S extends keyof AppSignals>(
    signal: S,
    callback: GObject.SignalCallback<this, AppSignals[S]>,
  ): number
}
declare const app: App
export default app
