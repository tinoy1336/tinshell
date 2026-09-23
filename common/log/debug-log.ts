/**
 * Shell logger — ONE sink for the merged shell process.
 *
 * Each surface (dock, launcher, notifications, keyboard, clipboard) calls
 * setSink() at import with its own sink + prefix. In one process those calls
 * would clobber each other (the shared logger's sink/prefix are process-global,
 * last import wins). THIS module sets the single sink — file
 * /tmp/tinshell-debug.log — with
 * NO global prefix; the per-app tag comes from each surface's own
 * `log.ts` (common/log/logger `createLogger`, e.g. [launcher]). Shared modules
 * that log through common/log/logger directly (subprocess, config loader)
 * write unprefixed to the same file.
 */
import { fileSink, setSink } from "@common/log/logger"

setSink(fileSink("/tmp/tinshell-debug.log"))
