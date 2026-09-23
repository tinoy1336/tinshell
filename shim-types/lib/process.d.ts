import { Accessor } from "gnim"
import GObject from "gnim/gobject"
export declare namespace Process {
  interface SignalSignatures extends GObject.Object.SignalSignatures {
    stdout: Process["stdout"]
    stderr: Process["stderr"]
    exit: Process["exit"]
  }
  interface ConstructorProps extends GObject.Object.ConstructorProps {
    argv: string[]
  }
}
export declare class Process extends GObject.Object {
  #private
  protected stdout(out: string): void
  protected stderr(err: string): void
  protected exit(code: number, signaled: boolean): void
  connect<S extends keyof Process.SignalSignatures>(
    signal: S,
    callback: GObject.SignalCallback<this, Process.SignalSignatures[S]>,
  ): number
  /**
   * Force quit the subprocess.
   */
  kill(): void
  /**
   * Send a signal to the subprocess.
   *
   * @param signal Signal number to be sent
   */
  signal(signal: number): void
  /**
   * Write a line to the subprocess' stdin synchronously.
   * See {@link Gio.DataOutputStream.prototype.write_bytes_async}
   *
   * @param str String to be written to stdin
   */
  write(str: string): Promise<[boolean, number]>
  /**
   * Write a line to the subprocess' stdin asynchronously.
   *
   * @param str String to be written to stdin
   */
  writeAsync(str: string): Promise<void>
  constructor({ argv }: Process.ConstructorProps)
  /**
   * Start a new subprocess with the given command.
   * The first element of the vector is executed with the remaining
   * elements as the argument list.
   */
  static subprocessv(cmd: string[]): Process
  /**
   * Start a new subprocess with the given command
   * which is parsed using {@link GLib.shell_parse_argv}.
   */
  static subprocess(cmd: string): Process
  /**
   * Execute a command synchronously.
   * The first element of the vector is executed with the remaining
   * elements as the argument list.
   *
   * @throws stderr
   * @return stdout of the subprocess
   */
  static execv(cmd: string[]): string
  /**
   * Execute a command synchronously.
   * The command is parsed using {@link GLib.shell_parse_argv}.
   *
   * @throws stderr
   * @return stdout of the subprocess
   */
  static exec(cmd: string): string
  /**
   * Execute a command asynchronously.
   * The first element of the vector is executed with the remaining
   * elements as the argument list.
   *
   * @throws stderr
   * @return stdout of the subprocess
   */
  static execAsyncv(cmd: string[]): Promise<string>
  /**
   * Execute a command asynchronously.
   * The command is parsed using {@link GLib.shell_parse_argv}.
   *
   * @throws stderr
   * @return stdout of the subprocess
   */
  static execAsync(cmd: string): Promise<string>
}
type Args = {
  cmd: string | string[]
  out?: (stdout: string) => void
  err?: (stderr: string) => void
}
export declare function subprocess(args: Args): Process
export declare function subprocess(
  cmd: string | string[],
  onOut?: (stdout: string) => void,
  onErr?: (stderr: string) => void,
): Process
/** @throws {Error} Throws stderr */
export declare function exec(cmd: string | string[]): string
export declare function execAsync(cmd: string | string[]): Promise<string>
export declare function createSubprocess(init: string, exec: string | string[]): Accessor<string>
export declare function createSubprocess<T>(
  init: T,
  exec: string | string[],
  transform: (stdout: string, prev: T) => T,
): Accessor<T>
