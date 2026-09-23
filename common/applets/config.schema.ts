/**
 * Applet config schema slice — the config roots the applet machinery reads.
 *
 * `apps/dock/config.schema.ts` composes these roots with its own dock-only
 * roots (`applets`, `screengrab` minus `dir`) and stays the generated
 * artifact's source (scripts/gen-config-schemas.ts globs `apps/*`). The
 * composition preserves the original property order, so the emitted
 * config.schema.json is loader-identical to the pre-split file.
 *
 * Loaded by the schema generator under plain Node — import schema-build
 * relatively, never through the `@common` alias (no tsconfig-paths mapping
 * outside the bundler/tsc).
 */
import { arr, enumOf, mapOf, obj, type Static, Type } from "../config/schema-build.ts"

/** Dock placement + applet window metrics. */
export const layout = obj({
  // Mirrors common/applets/layout.ts POSITIONS (the 12 dock placements) —
  // invalid strings crash dockGeometry (g stays undefined).
  position: enumOf([
    "bottom-middle",
    "bottom-left",
    "bottom-right",
    "top-middle",
    "top-left",
    "top-right",
    "left-middle",
    "left-top",
    "left-bottom",
    "right-middle",
    "right-top",
    "right-bottom",
  ]),
  iconSize: Type.Number(),
  pillHeight: Type.Number(),
  spacing: Type.Number(),
  marginTop: Type.Number(),
  marginBottom: Type.Number(),
  marginLeft: Type.Number(),
  marginRight: Type.Number(),
})

/** Cairo text metrics for applet glyphs, labels and degree rings. */
export const fonts = obj({
  family: Type.String(),
  iconSize: Type.Number(),
  labelSize: Type.Number(),
  degreeSize: Type.Number(),
})

/** Animation + polling intervals. The dock-surface mechanics keys
 *  (overflowIdle, moveModeTimeout, recordingBlink, menuFade, moveSnap,
 *  tabletCloseMs) live in this root because the tier sidecar and the
 *  generated key order are per-root. */
export const timing = obj({
  framerate: Type.Number(),
  clockTickMs: Type.Number(),
  leaveGrace: Type.Number(),
  pillAnim: Type.Number(),
  externalChange: Type.Number(),
  stepSnap: Type.Number(),
  appearAnim: Type.Number(),
  appearOutAnim: Type.Number(),
  // Cross-fade of a fade-ELIGIBLE element (an applet declares one by painting
  // that element through common/applets/shared/element-fade.ts). 0 = every
  // change paints at once, with no tween. Read at transition start, so a live
  // config change takes effect on the next change.
  fadeAnim: Type.Number(),
  fadeEasing: enumOf(["linear", "easeOut", "easeInOut"]),
  // Walk span of an animated numeric READOUT (common/applets/shared/value-tick.ts:
  // the performance applet's temperature digits, the battery applet's wattage
  // digits): the ms the digits take to travel from the old reading to the new
  // one. 0 = the readout paints the new reading at once. Read at kick time, so a
  // live config change takes effect on the next walk.
  tickAnim: Type.Number(),
  overflowIdle: Type.Number(),
  moveModeTimeout: Type.Number(),
  recordingBlink: Type.Number(),
  menuFade: Type.Number(),
  poll: mapOf(Type.Number()),
  moveSnap: Type.Number(),
  tabletCloseMs: Type.Number(),
  workspacePoll: Type.Number(),
  mediaIdleMs: Type.Number(),
})

/** Applet palette: discs, rings, step colours, glyph set. The menu framework
 *  colours (`menu.*`) and `debugFill` are dock-only readers but belong to this
 *  root for the same reason as the dock-only timing keys. */
export const appearance = obj({
  disc: obj({
    rgb: arr(Type.Number(), 3, 3),
    // Tracks backdrop.alpha: disc.alpha − backdrop.alpha is the disc's
    // on-surface weight (draw-utils compensatedAlpha).
    alpha: Type.Number(),
  }),
  unfilled: obj({
    rgb: arr(Type.Number(), 3, 3),
    alpha: Type.Number(),
  }),
  ringThickness: Type.Number(),
  // The pill backdrop band behind the applets (DockSurface draw_func): the
  // dock's base glass. The bar's visible tone is this base + the lift
  // (`draw-utils` backdropLiftColour) painted between the discs; the discs
  // composite over the base only.
  backdrop: obj({
    rgb: arr(Type.Number(), 3, 3),
    alpha: Type.Number(),
  }),
  // Opt-in translucent window-bounds fill for geometry debugging.
  debugFill: Type.Boolean(),
  textShadow: obj({
    rgb: arr(Type.Number(), 3, 3),
    alpha: Type.Number(),
    offset: Type.Number(),
  }),
  glyphColour: obj({
    rgb: arr(Type.Number(), 3, 3),
    alpha: Type.Number(),
  }),
  pctTextColour: obj({
    rgb: arr(Type.Number(), 3, 3),
    alpha: Type.Number(),
  }),
  uptimeTextColour: obj({
    rgb: arr(Type.Number(), 3, 3),
    alpha: Type.Number(),
  }),
  disabledDisc: obj({
    rgb: arr(Type.Number(), 3, 3),
    alpha: Type.Number(),
  }),
  disabledGlyph: obj({
    rgb: arr(Type.Number(), 3, 3),
    alpha: Type.Number(),
  }),
  icons: obj({
    volumeSilent: Type.String(),
    volumeLow: Type.String(),
    volumeHigh: Type.String(),
    brightness: Type.String(),
    batteryIdle: Type.String(),
    sleepBlocked: Type.String(),
    sleepAllowed: Type.String(),
    autoProfile: Type.String(),
    powerSaver: Type.String(),
    balanced: Type.String(),
    performanceProfile: Type.String(),
    hibernate: Type.String(),
    restart: Type.String(),
    shutdown: Type.String(),
    wifiDisabled: Type.String(),
    wifiScanningWeak: Type.String(),
    wifiScanningFair: Type.String(),
    wifiScanningGood: Type.String(),
    wifiScanningStrong: Type.String(),
    wifiConnectedWeak: Type.String(),
    wifiConnectedFair: Type.String(),
    wifiConnectedGood: Type.String(),
    wifiConnectedStrong: Type.String(),
    wifiNoInternetWeak: Type.String(),
    wifiNoInternetFair: Type.String(),
    wifiNoInternetGood: Type.String(),
    wifiNoInternetStrong: Type.String(),
    wifiOff: Type.String(),
    wifiOn: Type.String(),
    wifiReconnect: Type.String(),
    wifiOpen: Type.String(),
    bluetoothDisabled: Type.String(),
    bluetoothIdle: Type.String(),
    bluetoothConnected: Type.String(),
    bluetoothOff: Type.String(),
    bluetoothOn: Type.String(),
    bluetoothReconnect: Type.String(),
    bluetoothOpen: Type.String(),
    volumeMuted: Type.String(),
    mediaPlaying: Type.String(),
    mediaPaused: Type.String(),
    mediaPrev: Type.String(),
    mediaNext: Type.String(),
    mediaPause: Type.String(),
    lock: Type.String(),
    logout: Type.String(),
    sleep: Type.String(),
    overflow: Type.String(),
    overflowShowAll: Type.String(),
    overflowHideAll: Type.String(),
    menuWifiWeak: Type.String(),
    menuWifiFair: Type.String(),
    menuWifiGood: Type.String(),
    menuWifiStrong: Type.String(),
    menuLock: Type.String(),
    menuCheck: Type.String(),
    menuForget: Type.String(),
    menuBluetooth: Type.String(),
    menuAudio: Type.String(),
    menuKeyboard: Type.String(),
    menuMouse: Type.String(),
    menuPhone: Type.String(),
    menuWatch: Type.String(),
    menuHeadphones: Type.String(),
    overflowAuto: Type.String(),
    overflowMove: Type.String(),
    screengrabStill: Type.String(),
    screengrabVideo: Type.String(),
    screengrabFiles: Type.String(),
    screengrabSettings: Type.String(),
    screengrabRecording: Type.String(),
    screengrabFullscreen: Type.String(),
    screengrabIdle: Type.String(),
    screengrabWindow: Type.String(),
    screengrabSelect: Type.String(),
    screengrabCancel: Type.String(),
    menuSpinner: Type.String(),
    screengrabStorage: Type.String(),
    menuEye: Type.String(),
    menuEyeOff: Type.String(),
    mediaOpen: Type.String(),
    notifications: Type.String(),
    mediaReturn: Type.String(),
    keyboardShow: Type.String(),
    keyboardHide: Type.String(),
    keyboardCycle: Type.String(),
  }),
  performanceTempColours: mapOf(
    obj({
      rgb: arr(Type.Number(), 3, 3),
      alpha: Type.Number(),
    }),
  ),
  batteryWattColours: mapOf(
    obj({
      rgb: arr(Type.Number(), 3, 3),
      alpha: Type.Number(),
    }),
  ),
  ringColours: obj({
    volume: obj({
      rgb: arr(Type.Number(), 3, 3),
      alpha: Type.Number(),
    }),
    brightness: obj({
      rgb: arr(Type.Number(), 3, 3),
      alpha: Type.Number(),
    }),
    // Keys the battery colour policy selects by name
    // (common/applets/shared/battery-colour): `charging` while sysfs status reads
    // Charging; `plugged` while AC is present with the pack neither filling nor
    // draining (status `Full` or `Not charging`); `ok` / `warn` / `low` by
    // `thresholds` for every other status. `cap` is the charge-limit segment,
    // which no level policy selects.
    battery: mapOf(
      obj({
        rgb: arr(Type.Number(), 3, 3),
        alpha: Type.Number(),
      }),
    ),
    cpu: mapOf(
      obj({
        rgb: arr(Type.Number(), 3, 3),
        alpha: Type.Number(),
      }),
    ),
    ram: obj({
      rgb: arr(Type.Number(), 3, 3),
      alpha: Type.Number(),
    }),
    wifiRate: mapOf(
      obj({
        rgb: arr(Type.Number(), 3, 3),
        alpha: Type.Number(),
      }),
    ),
    media: obj({
      rgb: arr(Type.Number(), 3, 3),
      alpha: Type.Number(),
    }),
    volumeByType: mapOf(
      obj({
        rgb: arr(Type.Number(), 3, 3),
        alpha: Type.Number(),
      }),
    ),
    mediaByPlayer: mapOf(
      obj({
        rgb: arr(Type.Number(), 3, 3),
        alpha: Type.Number(),
      }),
    ),
  }),
  stepColours: obj({
    performance: arr(
      obj({
        rgb: arr(Type.Number(), 3, 3),
        alpha: Type.Number(),
      }),
      4,
      4,
    ),
    lockSession: arr(
      obj({
        rgb: arr(Type.Number(), 3, 3),
        alpha: Type.Number(),
      }),
      4,
      4,
    ),
    power: arr(
      obj({
        rgb: arr(Type.Number(), 3, 3),
        alpha: Type.Number(),
      }),
      4,
      4,
    ),
    wifi: arr(
      obj({
        rgb: arr(Type.Number(), 3, 3),
        alpha: Type.Number(),
      }),
      4,
      4,
    ),
    bluetooth: arr(
      obj({
        rgb: arr(Type.Number(), 3, 3),
        alpha: Type.Number(),
      }),
      4,
      4,
    ),
    media: arr(
      obj({
        rgb: arr(Type.Number(), 3, 3),
        alpha: Type.Number(),
      }),
      4,
      4,
    ),
    overflow: arr(
      obj({
        rgb: arr(Type.Number(), 3, 3),
        alpha: Type.Number(),
      }),
      4,
      4,
    ),
    screengrab: arr(
      obj({
        rgb: arr(Type.Number(), 3, 3),
        alpha: Type.Number(),
      }),
      4,
      4,
    ),
    keyboard: arr(
      obj({
        rgb: arr(Type.Number(), 3, 3),
        alpha: Type.Number(),
      }),
      4,
      4,
    ),
  }),
  // Level thresholds, in percent: `batteryLow` / `batteryWarn` are the battery
  // ring's colour levels (common/applets/shared/battery-colour), and
  // `batteryNotifyPct` is the level whose DESCENT raises the battery applet's
  // low-battery notification (common/applets/battery/low-warning.ts).
  thresholds: mapOf(Type.Number()),
  wifi: mapOf(Type.Number()),
  menu: obj({
    width: Type.Number(),
    maxWidth: Type.Number(),
    cornerRadius: Type.Number(),
    rowHeight: Type.Number(),
    fontSize: Type.Number(),
    emojiSize: Type.Number(),
    maxRows: Type.Number(),
    bg: obj({
      rgb: arr(Type.Number(), 3, 3),
      alpha: Type.Number(),
    }),
    rowHighlight: obj({
      rgb: arr(Type.Number(), 3, 3),
      alpha: Type.Number(),
    }),
    rowActive: obj({
      rgb: arr(Type.Number(), 3, 3),
      alpha: Type.Number(),
    }),
    text: obj({
      rgb: arr(Type.Number(), 3, 3),
      alpha: Type.Number(),
    }),
    mutedText: obj({
      rgb: arr(Type.Number(), 3, 3),
      alpha: Type.Number(),
    }),
    accent: obj({
      rgb: arr(Type.Number(), 3, 3),
      alpha: Type.Number(),
    }),
    glowAlpha: Type.Number(),
    danger: obj({
      rgb: arr(Type.Number(), 3, 3),
      alpha: Type.Number(),
    }),
  }),
  recordingColour: obj({
    rgb: arr(Type.Number(), 3, 3),
    alpha: Type.Number(),
  }),
  clock: obj({
    enabled: Type.Boolean(),
    reappearMs: Type.Number(),
    /** How long a transient volume/brightness reading stays on the dial after
     *  the last change before it fades back to the idle battery readout. */
    transientHoldMs: Type.Number(),
    /** Sub-ticks drawn between adjacent rim markers on the tick dials
     *  (analogue + digital), each gap divided into this + 1: the value lights
     *  them by the same run as the markers, so the ring reads finer. 0 =
     *  majors alone. */
    minorTicksPerGap: Type.Number(),
    mode: enumOf(["analogue", "clean", "digital"]),
    digitalLayout: enumOf(["stacked", "one-line"]),
    text: obj({
      rgb: arr(Type.Number(), 3, 3),
      alpha: Type.Number(),
    }),
    hour: obj({
      rgb: arr(Type.Number(), 3, 3),
      alpha: Type.Number(),
    }),
    minute: obj({
      rgb: arr(Type.Number(), 3, 3),
      alpha: Type.Number(),
    }),
    second: obj({
      rgb: arr(Type.Number(), 3, 3),
      alpha: Type.Number(),
    }),
    centre: obj({
      rgb: arr(Type.Number(), 3, 3),
      alpha: Type.Number(),
    }),
    dot: obj({
      rgb: arr(Type.Number(), 3, 3),
      alpha: Type.Number(),
    }),
  }),
})

/** Capture output settings — the ScreenGrab applet's own settings menu is the
 *  only reader and writer of this root. */
export const screengrab = obj({
  dir: Type.String(),
  format: enumOf(["png", "jpg"]),
  jpegQuality: Type.Number(),
  codec: enumOf(["h264", "vp9", "av1"]),
  framerate: Type.Number(),
  videoQuality: enumOf(["low", "medium", "high"]),
  nameTemplate: Type.String(),
  audio: Type.Boolean(),
  cursor: Type.Boolean(),
  notify: Type.Boolean(),
  showDock: Type.Boolean(),
  overlayPos: enumOf(["top", "bottom"]),
  overlayOffset: Type.Number(),
  captureMode: enumOf(["fullscreen", "window", "select"]),
  hwEncode: Type.Boolean(),
  vaapiDevice: Type.String(),
})

/** The applet-facing config shape, composed for the `AppletConfig` type.
 *  Never generated — apps/dock/config.schema.ts owns the emitted artifact. */
export const appletSchema = obj({
  layout,
  fonts,
  timing,
  appearance,
  screengrab,
})

export type AppletConfig = Static<typeof appletSchema>
