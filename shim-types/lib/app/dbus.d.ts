import { Service } from "gnim/dbus"
export interface AppDBusImpl {
  insector(): void
  toggleWindow(name: string): void
  quit(): void
  request(argv: string[]): Promise<string>
}
export declare class AppDBus extends Service {
  private impl
  Inspector(): Promise<void>
  ToggleWindow(name: string): Promise<void>
  Quit(): Promise<void>
  Request(argv: string[]): Promise<[string]>
  constructor(impl: AppDBusImpl)
  static proxy(instanceName: string): Promise<AppDBus>
}
