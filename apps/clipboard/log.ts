/** [clipboard]-prefixed logger. The sink is process-global (common/log/debug-log). */
import { createLogger } from "@common/log/logger"

export const { log } = createLogger("[clipboard]")
