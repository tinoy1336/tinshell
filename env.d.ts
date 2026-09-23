declare module "*.css" {
  const content: string
  export default content
}

// gjs runtime globals — provided by the gjs engine, not lib.dom (tsconfig lib is ES2023).
// Declared here so LSP type-checks every app; esbuild/gjs resolve at runtime.
declare function print(...args: unknown[]): void
declare class TextDecoder {
  constructor(label?: string, options?: TextDecoderOptions)
  decode(input?: ArrayBufferView | ArrayBuffer | null, options?: TextDecodeOptions): string
  readonly encoding: string
  readonly fatal: boolean
  readonly ignoreBOM: boolean
}

// Astal sub-libraries imported unconditionally by the bundled `ags` library
// (node_modules/ags/lib/overrides.ts) but whose typelibs are NOT generated into
// @girs here. Typed loosely (any) — gjs resolves the real shape at runtime.
// Suppresses the third-party 'Cannot find module gi://AstalX' noise in tsc.
declare module "gi://AstalApps" {
  export const Apps: any
  export const Application: any
}
declare module "gi://AstalBattery" {
  export const UPower: any
}
declare module "gi://AstalBluetooth" {
  export const Adapter: any
  export const Bluetooth: any
  export const Device: any
}
declare module "gi://AstalHyprland" {
  export const Hyprland: any
  export const Monitor: any
  export const Workspace: any
}
declare module "gi://AstalMpris" {
  export const Mpris: any
  export const Player: any
}
declare module "gi://AstalNetwork" {
  export const Wifi: any
}
declare module "gi://AstalPowerProfiles" {
  export const PowerProfiles: any
}
declare module "gi://AstalTray" {
  export const Tray: any
}
