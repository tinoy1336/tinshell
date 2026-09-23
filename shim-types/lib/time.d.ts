import { Accessor } from "gnim"
import GObject from "gnim/gobject"
export declare namespace Timer {
  interface SignalSignatures extends GObject.Object.SignalSignatures {
    now(): void
    cancelled(): void
  }
}
export declare class Timer extends GObject.Object {
  $signals: Timer.SignalSignatures
  protected now(): void
  protected cancelled(): void
  static interval(interval: number, callback?: () => void): Timer
  static timeout(interval: number, callback?: () => void): Timer
  static idle(callback?: () => void): Timer
  private static new
  connect<S extends keyof Timer.SignalSignatures>(
    signal: S,
    callback: GObject.SignalCallback<this, Timer.SignalSignatures[S]>,
  ): number
  cancel(): void
}
export declare const interval: typeof Timer.interval,
  timeout: typeof Timer.timeout,
  idle: typeof Timer.idle
export declare function createPoll(
  init: string,
  interval: number,
  exec: string | string[],
): Accessor<string>
export declare function createPoll<T>(
  init: T,
  interval: number,
  exec: string | string[],
  transform: (stdout: string, prev: T) => T,
): Accessor<T>
export declare function createPoll<T>(
  init: T,
  interval: number,
  fn: (prev: T) => T | Promise<T>,
): Accessor<T>
