/** [notifications]-prefixed logger. The sink is process-global (common/log/debug-log). */
import { createLogger } from "@common/log/logger"

export const { log, ignore } = createLogger("[notifications]")
