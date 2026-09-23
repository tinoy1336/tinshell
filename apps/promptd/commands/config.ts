/**
 * promptd config request handlers — `ags -i promptd request "config get|set|reload"`.
 */
import { registerConfigCommands } from "@common/commands/config-commands"
import { all, get as getConfig, reloadConfig, set as setConfigRaw } from "../config"

registerConfigCommands("promptd", {
  get: getConfig,
  set: setConfigRaw,
  reloadConfig,
  all,
})
