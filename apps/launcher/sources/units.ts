/**
 * Unit conversions — the curated unit table and the query grammar behind the
 * launcher's conversion rows (wired by `sources/calc.ts` `unitRows`).
 *
 * Pure module (no gi): the table, the arithmetic and the spellings are
 * probeable under plain Node —
 * `node --experimental-strip-types apps/launcher/sources/units.probe.ts`.
 *
 * Why a table when the calculator already shells out to qalc: qalc costs a
 * subprocess per keystroke and misses the compact shapes — "20C" is not 20 °C
 * to qalc, and a bare scale ("20 °C") states no conversion intent at all. The
 * table answers instantly, answers EVERY companion scale at once, and states
 * the readings people get wrong (bit vs byte, 1000 vs 1024, US customary,
 * calorie vs thermochemical calorie, metric vs imperial horsepower). qalc
 * stays the fallback for everything the table does not parse: the combiner
 * suppresses implicit qalc while this source produced rows.
 *
 * Shapes:
 *   "<amount> <unit>"                     one row per companion unit
 *   "<amount> <unit> (to|into|in|as|=|->|→) <unit>"
 *   "0xff" / "0b1011" / "0o377" [to <base>]
 *   "<decimal> to hex|binary|octal|roman|char"
 *   "MMXXVI" [to decimal]                 uppercase Roman numerals only
 *   "<amount> <data unit> in <amount> <time unit>"     a transfer rate
 *   "<amount> <volume unit> <ingredient> [to <mass unit>]"  a kitchen measure
 *   "1920x1080"                           an aspect ratio
 *
 * A spelling always resolves through the shared fuzzy matcher
 * (`common/text`) after the exact, case-folded and normalized passes, so
 * abbreviations and dropped letters land on a unit (`cel`, `kilometr`) while a
 * spelling TWO units share is never guessed (b/B, Mbps/MBps). Plurals resolve
 * by dropping a trailing `s`.
 *
 * Two readings the table settles by CONTEXT rather than by a table lookup:
 *   - the cooking measures are metric (`cup` 250 mL, `tbsp` 15 mL, `tsp`
 *     5 mL), and the US customary ones are spelled with an explicit `us `
 *     prefix (`us cup`, `us tbsp`, `us tsp`); every row names the convention
 *     it answered in.
 *   - a bare `k` names no unit (it reads as "thousand": `4k`, `10k`); it is a
 *     kelvin source only when the query names a conversion target
 *     (`100k to c`) or carries a degree marker (`5 degK`).
 *
 * Four more spellings are resolved the same way, because another unit owns
 * the spelling outright: `g` is the gram unless the other side of the
 * separator is an acceleration unit (`1 g to m/s2`), `pt` is the pint unless
 * the other side is a typographic unit (`12 pt to px`), `nm` is the nanometre
 * unless the other side is a torque unit (`10 Nm to ftlb`), and `k` follows
 * the temperature rule above.
 */

import { fuzzyScore, rank } from "@common/text"

/** One conversion row: the result line plus what qualifies it. */
export interface UnitConversion {
  title: string
  description?: string
}

type FamilyKey =
  | "length"
  | "mass"
  | "volume"
  | "data"
  | "datarate"
  | "speed"
  | "time"
  | "energy"
  | "power"
  | "pressure"
  | "force"
  | "frequency"
  | "torque"
  | "typography"
  | "acceleration"

interface Unit {
  /** Display symbol used in the row. */
  display: string
  /** Multiplier to the family's base unit. */
  factor: number
  /** Resolvable spellings. */
  names: string[]
  /**
   * Companion units offered when the query names no target, in row order: the
   * SI answer first, the imperial equivalent underneath.
   */
  to: string[]
  /**
   * The convention this unit's number follows, named in every row it appears
   * in (`metric (Canadian)`, `US customary`, `thermochemical`). Unset where
   * the unit reads the same in every convention (mL, L, kPa).
   */
  note?: string
}

interface Family {
  units: Unit[]
}

/**
 * The table. Factors are exact where the definition is exact (the
 * international yard/pound agreements, IEC binary prefixes, the ISO 80000
 * constants) and the family base is the SI unit the factors multiply to.
 */
const FAMILIES: Record<FamilyKey, Family> = {
  // base: metre
  length: {
    units: [
      { display: "mm", factor: 0.001, names: ["mm", "millimetre", "millimeter"], to: ["cm", "in"] },
      { display: "cm", factor: 0.01, names: ["cm", "centimetre", "centimeter"], to: ["mm", "in"] },
      { display: "m", factor: 1, names: ["m", "metre", "meter"], to: ["cm", "ft"] },
      { display: "km", factor: 1000, names: ["km", "kilometre", "kilometer"], to: ["m", "mi"] },
      { display: "in", factor: 0.0254, names: ["in", "inch", "inches"], to: ["cm", "mm"] },
      { display: "ft", factor: 0.3048, names: ["ft", "foot", "feet"], to: ["m", "in"] },
      { display: "yd", factor: 0.9144, names: ["yd", "yard"], to: ["m", "ft"] },
      { display: "mi", factor: 1609.344, names: ["mi", "mile"], to: ["km", "m"] },
      { display: "nmi", factor: 1852, names: ["nmi", "nauticalmile"], to: ["km", "mi"] },
      // The micrometre is also spelled `micron`; the nanometre owns `nm`
      // (the torque unit reads it only where the query says torque).
      {
        display: "µm",
        factor: 1e-6,
        names: ["µm", "um", "micrometre", "micrometer", "micron"],
        to: ["mm", "in"],
      },
      { display: "nm", factor: 1e-9, names: ["nm", "nanometre", "nanometer"], to: ["µm", "mm"] },
      // IAU 2012 definitions: the astronomical unit is exact, the light-year
      // is that value through the Julian year.
      { display: "au", factor: 149597870700, names: ["au", "astronomicalunit"], to: ["km", "mi"] },
      {
        display: "ly",
        factor: 9460730472580800,
        names: ["ly", "lightyear"],
        to: ["km", "au"],
      },
    ],
  },
  // base: kilogram
  mass: {
    units: [
      { display: "mg", factor: 1e-6, names: ["mg", "milligramme", "milligram"], to: ["g", "oz"] },
      { display: "g", factor: 0.001, names: ["g", "gramme", "gram"], to: ["mg", "oz"] },
      { display: "kg", factor: 1, names: ["kg", "kilogramme", "kilogram"], to: ["g", "lb"] },
      { display: "t", factor: 1000, names: ["t", "tonne", "metricton"], to: ["kg", "lb"] },
      { display: "lb", factor: 0.45359237, names: ["lb", "pound"], to: ["kg", "g"] },
      {
        display: "oz",
        factor: 0.028349523125,
        names: ["oz", "ounce"],
        to: ["g", "lb"],
      },
      { display: "st", factor: 6.35029318, names: ["st", "stone"], to: ["kg", "lb"] },
      // A bare `ton` is the North American short ton (2000 lb); the metric
      // tonne keeps `tonne`/`t`, and the imperial ton is named in full.
      {
        display: "ton",
        factor: 907.18474,
        names: ["ton", "shortton", "uston"],
        to: ["kg", "lb"],
        note: "US customary (2000 lb)",
      },
      {
        display: "long ton",
        factor: 1016.0469088,
        names: ["longton", "imperialton"],
        to: ["kg", "lb"],
        note: "imperial (2240 lb)",
      },
      {
        display: "µg",
        factor: 1e-9,
        names: ["µg", "ug", "microgramme", "microgram"],
        to: ["mg", "g"],
      },
      // Exact trade units: the carat is 200 mg and the grain is 64.79891 mg by
      // definition; the slug is the mass accelerated at 1 ft/s² by 1 lbf.
      { display: "ct", factor: 0.0002, names: ["ct", "carat"], to: ["g", "mg"] },
      { display: "gr", factor: 0.00006479891, names: ["gr", "grain"], to: ["mg", "g"] },
      // The slug is the mass accelerated at 1 ft/s² by 1 lbf.
      {
        display: "slug",
        factor: (0.45359237 * 9.80665) / 0.3048,
        names: ["slug"],
        to: ["kg", "lb"],
      },
    ],
  },
  // base: litre — the COOKING measures are metric (cup 250 mL, tbsp 15 mL, tsp
  // 5 mL: the Canadian convention), so the US customary ones carry an explicit
  // `us ` prefix. The heavier US measures (fl oz, pint, qt, gal) are the US
  // customary ones outright: those have no kitchen counterpart in metric, and
  // a row names the convention of every unit it touches. The imperial
  // measures carry the `imp ` prefix and their own note.
  volume: {
    units: [
      {
        display: "mL",
        factor: 0.001,
        names: ["ml", "millilitre", "milliliter"],
        to: ["L", "fl oz"],
      },
      { display: "L", factor: 1, names: ["l", "litre", "liter"], to: ["mL", "gal"] },
      {
        display: "tsp",
        factor: 0.005,
        names: ["tsp", "teaspoon"],
        to: ["mL", "US tsp"],
        note: "metric (Canadian)",
      },
      {
        display: "tbsp",
        factor: 0.015,
        names: ["tbsp", "tablespoon"],
        to: ["mL", "US tbsp"],
        note: "metric (Canadian)",
      },
      {
        display: "cup",
        factor: 0.25,
        names: ["cup"],
        to: ["mL", "US cup"],
        note: "metric (Canadian)",
      },
      {
        display: "US tsp",
        factor: 0.00492892159375,
        names: ["us tsp", "us teaspoon"],
        to: ["mL", "tsp"],
        note: "US customary",
      },
      {
        display: "US tbsp",
        factor: 0.01478676478125,
        names: ["us tbsp", "us tablespoon"],
        to: ["mL", "tbsp"],
        note: "US customary",
      },
      {
        display: "US cup",
        factor: 0.2365882365,
        names: ["us cup"],
        to: ["mL", "cup"],
        note: "US customary",
      },
      {
        display: "fl oz",
        factor: 0.0295735295625,
        names: ["fl oz", "fluidounce", "us fl oz"],
        to: ["mL", "tbsp"],
        note: "US customary",
      },
      {
        display: "pint",
        factor: 0.473176473,
        names: ["pint", "pt", "us pint"],
        to: ["mL", "cup"],
        note: "US customary",
      },
      {
        display: "qt",
        factor: 0.946352946,
        names: ["qt", "quart", "us qt", "us quart"],
        to: ["L", "cup"],
        note: "US customary",
      },
      {
        display: "gal",
        factor: 3.785411784,
        names: ["gal", "gallon", "us gal", "us gallon"],
        to: ["L", "pint"],
        note: "US customary",
      },
      // A US butter stick is half a US cup by definition (113 g of butter).
      {
        display: "stick",
        factor: 0.11829411825,
        names: ["stick"],
        to: ["US cup", "mL"],
        note: "US customary (1/2 US cup)",
      },
      // Imperial (UK) measures: 4.54609 L exact for the gallon, the pint and
      // fluid ounce being its exact subdivisions.
      {
        display: "imp gal",
        factor: 4.54609,
        names: ["imp gal", "imperial gallon", "imp gallon"],
        to: ["L", "gal"],
        note: "imperial",
      },
      {
        display: "imp pint",
        factor: 0.56826125,
        names: ["imp pint", "imperial pint"],
        to: ["mL", "pint"],
        note: "imperial",
      },
      {
        display: "imp fl oz",
        factor: 0.0284130625,
        names: ["imp fl oz", "imperial fluid ounce", "imp fluid ounce"],
        to: ["mL", "fl oz"],
        note: "imperial",
      },
    ],
  },
  // base: byte — decimal (SI) and binary (IEC) prefixes side by side
  data: {
    units: [
      { display: "bit", factor: 0.125, names: ["bit", "b"], to: ["B"] },
      { display: "kbit", factor: 125, names: ["kbit", "kilobit"], to: ["kB", "bit"] },
      { display: "Mbit", factor: 125000, names: ["mbit", "megabit"], to: ["MB", "kbit"] },
      { display: "Gbit", factor: 125000000, names: ["gbit", "gigabit"], to: ["MB", "Mbit"] },
      { display: "B", factor: 1, names: ["B", "byte"], to: ["KB", "KiB"] },
      { display: "KB", factor: 1000, names: ["KB", "kilobyte"], to: ["MB", "KiB"] },
      { display: "MB", factor: 1e6, names: ["MB", "megabyte"], to: ["GB", "MiB"] },
      { display: "GB", factor: 1e9, names: ["GB", "gigabyte"], to: ["TB", "GiB"] },
      { display: "TB", factor: 1e12, names: ["TB", "terabyte"], to: ["GB", "TiB"] },
      { display: "PB", factor: 1e15, names: ["PB", "petabyte"], to: ["TB", "PiB"] },
      { display: "KiB", factor: 1024, names: ["KiB", "kibibyte"], to: ["kB", "B"] },
      { display: "MiB", factor: 1048576, names: ["MiB", "mebibyte"], to: ["MB", "KiB"] },
      { display: "GiB", factor: 1073741824, names: ["GiB", "gibibyte"], to: ["GB", "MiB"] },
      {
        display: "TiB",
        factor: 1099511627776,
        names: ["TiB", "tebibyte"],
        to: ["TB", "GiB"],
      },
      {
        display: "PiB",
        factor: 1125899906842624,
        names: ["PiB", "pebibyte"],
        to: ["PB", "TiB"],
      },
    ],
  },
  // base: byte per second — a bit rate and a byte rate are not the same number
  datarate: {
    units: [
      { display: "bit/s", factor: 0.125, names: ["bit/s", "bps"], to: ["B/s"] },
      { display: "kbit/s", factor: 125, names: ["kbit/s", "kbps"], to: ["kB/s"] },
      { display: "Mbit/s", factor: 125000, names: ["Mbit/s", "Mbps"], to: ["MB/s", "Gbit/s"] },
      { display: "Gbit/s", factor: 125000000, names: ["Gbit/s", "Gbps"], to: ["MB/s", "GB/s"] },
      { display: "B/s", factor: 1, names: ["B/s", "byte/s", "Bps"], to: ["bit/s", "kB/s"] },
      { display: "kB/s", factor: 1000, names: ["kB/s", "kilobyte/s"], to: ["kbit/s", "MB/s"] },
      { display: "MB/s", factor: 1e6, names: ["MB/s", "MBps"], to: ["Mbit/s", "GB/s"] },
      { display: "GB/s", factor: 1e9, names: ["GB/s", "GBps"], to: ["MB/s", "Gbit/s"] },
      { display: "TB/s", factor: 1e12, names: ["TB/s", "TBps"], to: ["GB/s", "Gbit/s"] },
    ],
  },
  // base: metre per second
  speed: {
    units: [
      { display: "m/s", factor: 1, names: ["m/s", "metre/s", "meter/s"], to: ["km/h", "mph"] },
      {
        display: "km/h",
        factor: 1000 / 3600,
        names: ["km/h", "kmh", "kmph", "kph", "km/hr", "kilometre/h", "kilometer/h"],
        to: ["m/s", "mph"],
      },
      {
        display: "mph",
        factor: 1609.344 / 3600,
        names: ["mph", "mi/hr", "mile/h", "miles/h"],
        to: ["km/h", "m/s"],
      },
      { display: "kn", factor: 1852 / 3600, names: ["kn", "knot"], to: ["km/h", "mph"] },
      { display: "ft/s", factor: 0.3048, names: ["ft/s", "foot/s", "feet/s"], to: ["m/s", "km/h"] },
    ],
  },
  // base: second — the year is the Julian year (365.25 d), the unit the
  // light-year and every other astronomical definition is stated in.
  time: {
    units: [
      { display: "ns", factor: 1e-9, names: ["ns", "nanosecond"], to: ["µs", "ms"] },
      { display: "µs", factor: 1e-6, names: ["µs", "us", "microsecond"], to: ["ms", "s"] },
      { display: "ms", factor: 0.001, names: ["ms", "millisecond"], to: ["s"] },
      { display: "s", factor: 1, names: ["s", "sec", "second"], to: ["min", "h"] },
      { display: "min", factor: 60, names: ["min", "minute"], to: ["h", "s"] },
      { display: "h", factor: 3600, names: ["h", "hr", "hour"], to: ["min", "d"] },
      { display: "d", factor: 86400, names: ["d", "day"], to: ["h", "wk"] },
      { display: "wk", factor: 604800, names: ["wk", "week"], to: ["d", "h"] },
      { display: "fortnight", factor: 1209600, names: ["fortnight"], to: ["d", "wk"] },
      {
        display: "yr",
        factor: 31557600,
        names: ["yr", "year", "julianyear"],
        to: ["d", "wk"],
        note: "Julian year (365.25 d)",
      },
      { display: "decade", factor: 315576000, names: ["decade"], to: ["yr", "d"] },
      { display: "century", factor: 3155760000, names: ["century"], to: ["decade", "yr"] },
    ],
  },
  // base: joule — the calorie is the thermochemical one (4.184 J) and the BTU
  // the IT one (1055.05585262 J), each named in every row it appears in
  energy: {
    units: [
      { display: "J", factor: 1, names: ["j", "joule"], to: ["kJ", "cal"] },
      { display: "kJ", factor: 1000, names: ["kj", "kilojoule"], to: ["J", "kcal"] },
      { display: "MJ", factor: 1e6, names: ["mj", "megajoule"], to: ["kJ", "kWh"] },
      {
        display: "cal",
        factor: 4.184,
        names: ["cal", "calorie"],
        to: ["J", "kJ"],
        note: "thermochemical (4.184 J)",
      },
      {
        display: "kcal",
        factor: 4184,
        names: ["kcal", "kilocalorie", "foodcalorie"],
        to: ["kJ", "cal"],
        note: "thermochemical (4184 J)",
      },
      { display: "Wh", factor: 3600, names: ["wh", "watthour"], to: ["J", "kWh"] },
      { display: "kWh", factor: 3.6e6, names: ["kwh", "kilowatthour"], to: ["MJ", "kcal"] },
      {
        display: "BTU",
        factor: 1055.05585262,
        names: ["btu", "britishthermalunit"],
        to: ["J", "kJ"],
        note: "IT (1055.05585262 J)",
      },
      {
        display: "therm",
        factor: 105505585.262,
        names: ["therm"],
        to: ["kWh", "MJ"],
        note: "IT (100 000 BTU)",
      },
      // The SI defining constant, exact since the 2019 revision.
      { display: "eV", factor: 1.602176634e-19, names: ["ev", "electronvolt"], to: ["J"] },
    ],
  },
  // base: watt — the mechanical horsepower (550 ft·lbf/s) and the metric one
  // (75 kgf·m/s) are 1.4 % apart, so a row always names which it answered.
  power: {
    units: [
      { display: "W", factor: 1, names: ["w", "watt"], to: ["kW", "hp"] },
      { display: "kW", factor: 1000, names: ["kw", "kilowatt"], to: ["W", "hp"] },
      { display: "MW", factor: 1e6, names: ["mw", "megawatt"], to: ["kW", "hp"] },
      {
        display: "hp",
        // 550 ft·lbf/s, the mechanical horsepower.
        factor: 550 * 0.3048 * 0.45359237 * 9.80665,
        names: ["hp", "horsepower", "mechanicalhorsepower"],
        to: ["kW", "W"],
        note: "mechanical (550 ft·lbf/s)",
      },
      {
        display: "PS",
        factor: 735.49875,
        names: ["ps", "metrichorsepower"],
        to: ["kW", "hp"],
        note: "metric (75 kgf·m/s)",
      },
      { display: "BTU/h", factor: 0.2930710701722222, names: ["btu/h", "btuh"], to: ["W", "kW"] },
    ],
  },
  // base: pascal
  pressure: {
    units: [
      { display: "Pa", factor: 1, names: ["pa", "pascal"], to: ["kPa", "psi"] },
      { display: "hPa", factor: 100, names: ["hpa", "hectopascal"], to: ["Pa", "mmHg"] },
      { display: "kPa", factor: 1000, names: ["kpa", "kilopascal"], to: ["Pa", "psi"] },
      { display: "MPa", factor: 1e6, names: ["mpa", "megapascal"], to: ["bar", "psi"] },
      { display: "bar", factor: 1e5, names: ["bar"], to: ["psi", "kPa"] },
      { display: "mbar", factor: 100, names: ["mbar", "millibar"], to: ["hPa", "Pa"] },
      { display: "atm", factor: 101325, names: ["atm", "atmosphere"], to: ["kPa", "psi"] },
      {
        display: "psi",
        // 1 lbf over 1 in².
        factor: (0.45359237 * 9.80665) / 0.0254 ** 2,
        names: ["psi", "poundpersquareinch"],
        to: ["bar", "kPa"],
      },
      { display: "torr", factor: 101325 / 760, names: ["torr"], to: ["Pa", "mmHg"] },
      {
        display: "mmHg",
        factor: 133.322387415,
        names: ["mmhg", "millimetreofmercury", "millimeterofmercury"],
        to: ["Pa", "torr"],
        note: "conventional (133.322387415 Pa)",
      },
      {
        display: "inHg",
        factor: 3386.388640341,
        names: ["inhg", "inchofmercury"],
        to: ["kPa", "hPa"],
      },
    ],
  },
  // base: newton
  force: {
    units: [
      { display: "N", factor: 1, names: ["n", "newton"], to: ["lbf", "kgf"] },
      { display: "kN", factor: 1000, names: ["kilonewton"], to: ["N", "lbf"] },
      { display: "dyn", factor: 1e-5, names: ["dyn", "dyne"], to: ["N", "lbf"] },
      {
        display: "lbf",
        factor: 0.45359237 * 9.80665,
        names: ["lbf", "poundforce"],
        to: ["N", "kgf"],
      },
      {
        display: "kgf",
        factor: 9.80665,
        names: ["kgf", "kilogramforce", "kilopond"],
        to: ["N", "lbf"],
      },
    ],
  },
  // base: hertz — a rotation rate is cycles per second (1 rpm = 1/60 Hz); an
  // angular velocity in rad/s is a different quantity and is not in the table.
  frequency: {
    units: [
      { display: "Hz", factor: 1, names: ["hz", "hertz"], to: ["kHz", "rpm"] },
      { display: "kHz", factor: 1000, names: ["khz", "kilohertz"], to: ["Hz", "MHz"] },
      { display: "MHz", factor: 1e6, names: ["mhz", "megahertz"], to: ["kHz", "GHz"] },
      { display: "GHz", factor: 1e9, names: ["ghz", "gigahertz"], to: ["MHz", "Hz"] },
      { display: "THz", factor: 1e12, names: ["thz", "terahertz"], to: ["GHz", "MHz"] },
      { display: "rpm", factor: 1 / 60, names: ["rpm", "revolutionsperminute"], to: ["Hz", "kHz"] },
    ],
  },
  // base: newton metre
  torque: {
    units: [
      {
        display: "N·m",
        factor: 1,
        names: ["newtonmetre", "newtonmeter", "n·m"],
        to: ["ft·lb", "in·lb"],
      },
      {
        display: "ft·lb",
        // 1 ft·lb is 1 ft × 1 lbf in SI.
        factor: 0.3048 * 0.45359237 * 9.80665,
        names: ["ftlb", "ft·lb", "lbft", "lbf·ft", "footpound"],
        to: ["N·m", "in·lb"],
      },
      {
        display: "in·lb",
        factor: (0.3048 * 0.45359237 * 9.80665) / 12,
        names: ["inlb", "in·lb", "inchpound"],
        to: ["N·m", "ft·lb"],
      },
      {
        display: "kgf·m",
        factor: 9.80665,
        names: ["kgfm", "kgf·m", "kilogramforcemetre"],
        to: ["N·m", "ft·lb"],
      },
    ],
  },
  // base: CSS pixel — the CSS definitions (96 px = 1 in, 1 pt = 1/72 in,
  // 1 pc = 12 pt) exactly, at the reference pixel density.
  typography: {
    units: [
      { display: "px", factor: 1, names: ["px", "pixel"], to: ["pt", "pc"] },
      { display: "pt", factor: 4 / 3, names: ["point", "typographicpoint"], to: ["px", "pc"] },
      { display: "pc", factor: 16, names: ["pc", "pica"], to: ["pt", "px"] },
    ],
  },
  // base: metre per second squared — `g` is the standard acceleration of free
  // fall (9.80665 m/s² exact), read only where the query says acceleration.
  acceleration: {
    units: [
      {
        display: "m/s²",
        factor: 1,
        names: ["m/s2", "m/s²", "metre/s2", "meter/s2", "metrepersecond2"],
        to: ["ft/s²", "g"],
      },
      { display: "ft/s²", factor: 0.3048, names: ["ft/s2", "ft/s²", "foot/s2"], to: ["m/s²", "g"] },
      {
        display: "g",
        factor: 9.80665,
        names: ["gee", "gforce", "gravity", "standardgravity"],
        to: ["m/s²", "ft/s²"],
        note: "standard gravity (9.80665 m/s²)",
      },
    ],
  },
}

/**
 * Temperature is affine, not a factor: each scale converts through degrees
 * Celsius. The offsets are exact by definition (°F = 1.8 × °C + 32 over the
 * ice/steam fixed points, K = °C + 273.15).
 */
interface Scale {
  display: string
  names: string[]
  /** Single-letter spelling, resolved only where the query says "temperature". */
  short: string
  to: string[]
  toCelsius: (v: number) => number
  fromCelsius: (c: number) => number
}

const SCALES: Scale[] = [
  {
    display: "°C",
    names: ["c", "celsius", "centigrade"],
    short: "c",
    to: ["K", "°F"],
    toCelsius: (v) => v,
    fromCelsius: (c) => c,
  },
  {
    display: "°F",
    names: ["f", "fahrenheit"],
    short: "f",
    to: ["°C", "K"],
    toCelsius: (v) => ((v - 32) * 5) / 9,
    fromCelsius: (c) => (c * 9) / 5 + 32,
  },
  {
    // The bare `k` is NOT a general kelvin spelling — it reads as "thousand"
    // far more often ("4k", "10k") — so it resolves only with a degree marker
    // (`°K`, `degK`) or as the target of a temperature query.
    display: "K",
    names: ["kelvin"],
    short: "k",
    to: ["°C", "°F"],
    toCelsius: (v) => v - 273.15,
    fromCelsius: (c) => c + 273.15,
  },
]

/** A resolved unit spelling: a linear unit of a family, or a temperature scale. */
type Ref =
  | { kind: "unit"; family: FamilyKey; unit: Unit; display: string }
  | { kind: "temp"; scale: Scale; display: string }

// ── spelling resolution ──

/**
 * Spelling key: case-folded, without spaces, degree signs or a multiplication
 * dot, and without a leading degree word — so `°C`, `degC` and `degrees C`
 * share the key `c`, and `N·m` and `ft·lb` reduce like `Nm` and `ftlb`.
 */
function normToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/[\s°º·]/g, "")
    .replace(/^deg(?:rees?|ree)?/, "")
}

const exactNames = new Map<string, Ref | null>()
/** Case-folded lookups; a spelling two units share is DROPPED (never guessed). */
const foldedNames = new Map<string, Ref | null>()
const normalizedNames = new Map<string, Ref | null>()
/** Display symbols → the unit they name, for the authored companion lists. */
const byDisplay = new Map<string, Ref>()
/** The scales' single-letter spellings (see Scale.short). */
const TEMP_SHORT = new Map<string, Ref>()
const fuzzyNames: { ref: Ref; norm: string }[] = []

function addKey(map: Map<string, Ref | null>, key: string, ref: Ref): void {
  if (!key) return
  const cur = map.get(key)
  if (cur === undefined) map.set(key, ref)
  else if (cur !== null && cur !== ref) map.set(key, null)
}

function register(ref: Ref, name: string): void {
  addKey(exactNames, name, ref)
  addKey(foldedNames, name.toLowerCase(), ref)
  const norm = normToken(name)
  addKey(normalizedNames, norm, ref)
  // A spelling carrying a digit or a superscript is a SYMBOL, not a word: it
  // resolves exactly and never through the fuzzy pass, so a squared or cubed
  // spelling can never be read as the linear unit plus a stray character
  // (`m2` and `m²` name no unit, they do not name `m/s2`).
  if (norm.length >= 3 && !/[0-9²³]/.test(norm)) fuzzyNames.push({ ref, norm })
}

/** The ref a (family, display) pair registered, by object identity — a second
 *  ref for the same unit would break the fuzzy pass's tie comparison. */
const refByDisplay = new Map<string, Ref>()

for (const [family, def] of Object.entries(FAMILIES) as [FamilyKey, Family][]) {
  for (const unit of def.units) {
    const ref: Ref = { kind: "unit", family, unit, display: unit.display }
    // First registration wins: the acceleration `g` is the mass gram's display
    // string too, and the companion lists must keep resolving `g` to the gram.
    if (!byDisplay.has(unit.display)) byDisplay.set(unit.display, ref)
    refByDisplay.set(`${family}:${unit.display}`, ref)
    for (const name of unit.names) register(ref, name)
  }
}
for (const scale of SCALES) {
  const ref: Ref = { kind: "temp", scale, display: scale.display }
  byDisplay.set(scale.display, ref)
  TEMP_SHORT.set(normToken(scale.short), ref)
  for (const name of scale.names) register(ref, name)
}
/**
 * The context-resolved spellings (see `resolveContext`): a unit that a spelling
 * another unit owns outright, plus the family that has to appear on the other
 * side of the query before the spelling reads as this unit.
 */
interface ContextSpelling {
  family: FamilyKey
  /** The unit's display symbol — how its ref is found. */
  display: string
  /** The spelling (normalized) that resolves contextually to this unit. */
  spelling: string
  map: Map<string, Ref>
}

const CONTEXT_SPELLINGS: ContextSpelling[] = [
  { family: "acceleration", display: "g", spelling: "g", map: new Map() },
  { family: "typography", display: "pt", spelling: "pt", map: new Map() },
  { family: "torque", display: "N·m", spelling: "nm", map: new Map() },
  // The knot owns `kn`; the kilonewton reads it only where the query names a
  // force (`1 kn to n` is 1000 N, `1 kn to km/h` is a knot).
  { family: "force", display: "kN", spelling: "kn", map: new Map() },
]
for (const c of CONTEXT_SPELLINGS) {
  const ref = refByDisplay.get(`${c.family}:${c.display}`)
  if (ref) c.map.set(c.spelling, ref)
}

/** Minimum fuzzy score a spelling must reach to name a unit. */
const FUZZY_MIN = 120

function lookup(token: string): Ref | null {
  const exact = exactNames.get(token)
  if (exact !== undefined) return exact
  const folded = foldedNames.get(token.toLowerCase())
  if (folded !== undefined) return folded
  const normalized = normalizedNames.get(normToken(token))
  return normalized ?? null
}

function fuzzyUnit(token: string): Ref | null {
  const norm = normToken(token)
  if (norm.length < 3) return null
  const ranked = rank(fuzzyNames, (c) => fuzzyScore(norm, c.norm))
  const best = ranked[0]
  if (!best || best.score < FUZZY_MIN) return null
  // Ties are broken by the TIGHTER name (a prefix match scores the same at any
  // length, so "kilometr" matches both "kilometre" and "kilometre/h"); two
  // equally tight names on different units are ambiguity, not a match.
  const top = ranked.filter((c) => c.score === best.score)
  const shortest = Math.min(...top.map((c) => c.item.norm.length))
  const tight = top.filter((c) => c.item.norm.length === shortest)
  return tight.every((c) => c.item.ref === tight[0].item.ref) ? tight[0].item.ref : null
}

/** The unit a typed spelling names, or null (an unknown spelling names none). */
function resolveUnit(token: string): Ref | null {
  const t = token.trim()
  const direct = lookup(t)
  if (direct) return direct
  if (t.length > 2 && /s$/i.test(t)) {
    const singular = lookup(t.slice(0, -1))
    if (singular) return singular
  }
  return fuzzyUnit(t)
}

/** A degree marker makes a token a temperature scale outright. */
const DEGREE_MARKED = /°|º|deg/i

/**
 * The compact scale spellings: a degree-marked token (`°K`, `degK`), or a bare
 * `k` when the query names a temperature scale on the other side — `100k to c`
 * and `100c to k` can only mean kelvin either way.
 */
function resolveScaleShort(token: string, requireMarker: boolean): Ref | null {
  if (requireMarker && !DEGREE_MARKED.test(token)) return null
  return TEMP_SHORT.get(normToken(token)) ?? null
}

/**
 * A context-resolved spelling: `map` holds spellings another unit owns
 * outright (`g` gram, `pt` pint, `nm` nanometre), so the spelling reads as the
 * map's unit only where the other side of the query is in that unit's family.
 * `require` is that other side — null means the query named no unit this
 * context can be read from.
 */
function resolveContext(
  token: string,
  map: Map<string, Ref>,
  require: FamilyKey | null,
): Ref | null {
  if (require === null) return null
  const ref = map.get(normToken(token))
  if (ref?.kind !== "unit" || ref.family !== require) return null
  return ref
}

/** The context-resolved reading of `token` for an opposite side in `require`. */
function resolveContexts(token: string, require: FamilyKey | null): Ref | null {
  for (const c of CONTEXT_SPELLINGS) {
    const ref = resolveContext(token, c.map, require)
    if (ref) return ref
  }
  return null
}

// ── amount + unit grammar ──

/**
 * The US customary cooking measures. The metric measures own the bare
 * spellings, so the other convention is named with an explicit `us ` prefix —
 * a multi-word unit token, like the fluid ounce beside it. The imperial
 * measures carry the same shape under their own prefix.
 */
const US_MEASURE =
  "(?:us|US)\\s+(?:tsp|tbsp|cup|teaspoon|tablespoon|gal|gallon|pint|pt|qt|quart|fl\\s*oz|fluid\\s*ounce)s?"
const IMP_MEASURE =
  "(?:imp|IMP|imperial)\\s+(?:gal|gallon|pint|pt|qt|quart|tsp|tbsp|cup|fl\\s*oz|fluid\\s*ounce)s?"
/** The multi-word tons: `long ton` and `short ton` are the imperial and the
 *  US customary one, `metric ton` the tonne. */
const TON_MEASURE = "(?:long|short|metric)\\s+tons?"
/**
 * A unit word: letters, the micro sign, a degree sign, digits and superscripts
 * (`m/s2`, `µg`, `m²`), and the multiplication dot (`N·m`). A token carrying a
 * digit or a superscript is only ever an EXACT or case-folded hit — the fuzzy
 * pass cannot match a longer spelling onto a shorter name, so `km2` never
 * reads as `km`.
 */
const UNIT_WORD = "[A-Za-zµ°º][A-Za-zµ°º0-9²³·]*"
/** `<amount> <unit>` — the unit token also carries a slash form, `deg`, and the
 *  multi-word US/imperial measures. */
const UNIT_TOKEN = `(?:deg(?:rees?|ree)?\\s*)?(?:${US_MEASURE}|${IMP_MEASURE}|${TON_MEASURE}|fl\\s*oz|fluid\\s*ounce|${UNIT_WORD})(?:\\s*/\\s*${UNIT_WORD})?`

/** `<number>`: grouped thousands, decimals and exponents all parse. */
const NUMBER = `[+-]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?`
/** `3/4`, `1 1/2` — the recipe shapes, as one amount. */
const FRACTION = `[+-]?(?:\\d+\\s+)?\\d+\\s*\\/\\s*\\d+`
const AMOUNT = `(?:${FRACTION}|${NUMBER})`
const AMOUNT_UNIT = new RegExp(`^(${AMOUNT})\\s*(${UNIT_TOKEN})$`)
/** Words that separate an amount from the unit it converts to. */
const SEPARATOR_WORDS = new Set(["to", "into", "in", "as", "=", "->"])
/** The same separator set as a regex fragment, for the numeral shapes. */
const NUMERAL_SEP = "\\s+(?:to|into|in|as|=|->)\\s+"

interface Parsed {
  amountText: string
  fromToken: string
  toToken: string | null
}

/**
 * `<amount> <unit> [SEP <unit>]`. Separators are scanned word by word and only
 * accepted where BOTH sides parse, so `100 in to cm` reads the first `in` as
 * inch and the second token as the separator rather than the other way round.
 * The target side is only required to be non-empty — it is resolved by the
 * caller, which knows whether the source is a temperature scale.
 */
function parseQuery(s: string): Parsed | null {
  const words = s.split(" ")
  for (let i = 0; i < words.length; i++) {
    if (!SEPARATOR_WORDS.has(words[i].toLowerCase())) continue
    const left = words.slice(0, i).join(" ")
    const right = words.slice(i + 1).join(" ")
    if (!right) continue
    const lm = AMOUNT_UNIT.exec(left)
    if (!lm) continue
    return { amountText: lm[1], fromToken: lm[2], toToken: right }
  }
  const lm = AMOUNT_UNIT.exec(s)
  return lm ? { amountText: lm[1], fromToken: lm[2], toToken: null } : null
}

/** A comma is a thousands separator or nothing: `1,000` parses, `1,5` does not. */
const GROUPED = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:[eE][+-]?\d+)?$/

/** The amount a parsed query carries, or null when it is not a number. */
function parseAmount(text: string): number | null {
  const t = text.trim()
  const mixed = /^([+-]?)(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)$/.exec(t)
  if (mixed) {
    const den = Number(mixed[4])
    if (den === 0) return null
    const sign = mixed[1] === "-" ? -1 : 1
    return sign * ((mixed[2] ? Number(mixed[2]) : 0) + Number(mixed[3]) / den)
  }
  if (t.includes(",") && !GROUPED.test(t)) return null
  const value = Number(t.replace(/,/g, ""))
  return Number.isFinite(value) ? value : null
}

// ── formatting ──

/**
 * Readable result: integers stay exact (1 TiB = 1099511627776 B is the point),
 * everything else keeps six significant digits and loses its float tail
 * (20 °C = 68 °F, not 68.00000000000001).
 */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return "—"
  if (Number.isInteger(v)) return String(v)
  const a = Math.abs(v)
  if (a !== 0 && (a >= 1e15 || a < 1e-6)) return v.toExponential(4)
  return String(Number(v.toPrecision(6)))
}

// ── numerals: hex / octal / binary / Roman / character ──

type NumeralBase = "dec" | "hex" | "oct" | "bin" | "roman"

const BASE_WORDS: [RegExp, NumeralBase][] = [
  [/^(?:hex|hexadecimal|base16)$/, "hex"],
  [/^(?:bin|binary|base2)$/, "bin"],
  [/^(?:oct|octal|base8)$/, "oct"],
  [/^(?:dec|decimal|base10|arabic)$/, "dec"],
  [/^(?:roman|romannumeral)$/, "roman"],
]
/** Words asking for the character a code point stands for. */
const CHAR_WORDS = /^(?:char|character|ascii|unicode|codepoint)$/
/** Companion bases for a literal typed without a target, in row order. */
const LITERAL_BASES: Record<string, NumeralBase[]> = {
  hex: ["dec", "bin"],
  bin: ["dec", "hex"],
  oct: ["dec", "hex"],
  roman: ["dec", "hex"],
}
/** Representations listed in a numeral row's description, minus the row's own. */
const REPR_ORDER: NumeralBase[] = ["dec", "hex", "bin", "roman"]

const ROMAN_VALUES: [number, string][] = [
  [1000, "M"],
  [900, "CM"],
  [500, "D"],
  [400, "CD"],
  [100, "C"],
  [90, "XC"],
  [50, "L"],
  [40, "XL"],
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
]

/** Roman numeral for 1..3999 (null outside standard notation's range). */
function toRoman(n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > 3999) return null
  let rest = n
  let out = ""
  for (const [value, glyph] of ROMAN_VALUES) {
    while (rest >= value) {
      out += glyph
      rest -= value
    }
  }
  return out
}

/**
 * Value of a Roman numeral, or null. Strict: the numeral must be the standard
 * subtractive form, which re-encoding it pins — so `IIII`, `VX` and `IM` name
 * no number instead of being read loosely.
 */
function fromRoman(s: string): number | null {
  const glyphs: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }
  let total = 0
  for (let i = 0; i < s.length; i++) {
    const value = glyphs[s[i]]
    if (value === undefined) return null
    const next = i + 1 < s.length ? glyphs[s[i + 1]] : 0
    total += value < next ? -value : value
  }
  return toRoman(total) === s ? total : null
}

function repr(value: number, base: NumeralBase): string | null {
  switch (base) {
    case "dec":
      return String(value)
    case "hex":
      return `0x${value.toString(16)}`
    case "oct":
      return `0o${value.toString(8)}`
    case "bin":
      return `0b${value.toString(2)}`
    case "roman":
      return toRoman(value)
  }
}

/** The row for one representation: the title is what was asked for, the
 *  description every other representation of the same number. */
function numeralRow(value: number, wanted: NumeralBase): UnitConversion[] {
  const title = repr(value, wanted)
  if (!title) return []
  const others = REPR_ORDER.filter((b) => b !== wanted)
    .map((b) => repr(value, b))
    .filter((s): s is string => s !== null)
  return [{ title, description: others.join("  ·  ") }]
}

/** The printable character a code point stands for, or null (controls, the
 *  surrogate range and out-of-range values name no character). */
function charFor(value: number): string | null {
  if (!Number.isSafeInteger(value) || value < 33 || value > 0x10ffff) return null
  if (value >= 0xd800 && value <= 0xdfff) return null
  return String.fromCodePoint(value)
}

function resolveBase(word: string): NumeralBase | null {
  const norm = normToken(word)
  for (const [re, base] of BASE_WORDS) if (re.test(norm)) return base
  return null
}

function parseLiteral(lit: string): number | null {
  const radix = { x: 16, b: 2, o: 8 }[lit[1].toLowerCase()]
  if (radix === undefined) return null
  const value = Number.parseInt(lit.slice(2), radix)
  return Number.isSafeInteger(value) ? value : null
}

/** Roman numeral out, and any numeral in: 0 rows when the shape is not one. */
function numeralConversions(s: string): UnitConversion[] | null {
  const literal = new RegExp(
    `^(0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+)(?:${NUMERAL_SEP}(.+))?$`,
    "i",
  ).exec(s)
  if (literal) {
    const value = parseLiteral(literal[1])
    if (value === null) return null
    if (literal[2] === undefined) {
      const kind = { x: "hex", b: "bin", o: "oct" }[literal[1][1].toLowerCase()] as NumeralBase
      return LITERAL_BASES[kind].flatMap((b) => numeralRow(value, b))
    }
    const wanted = resolveBase(literal[2])
    return wanted ? numeralRow(value, wanted) : null
  }

  const romanTarget = new RegExp(`^([IVXLCDM]{1,15})${NUMERAL_SEP}(.+)$`, "i").exec(s)
  if (romanTarget && /^[IVXLCDM]{1,15}$/.test(romanTarget[1])) {
    const value = fromRoman(romanTarget[1])
    if (value === null) return null
    const wanted = resolveBase(romanTarget[2])
    return wanted ? numeralRow(value, wanted) : null
  }

  const decimalTarget = new RegExp(`^(\\d+)${NUMERAL_SEP}(.+)$`, "i").exec(s)
  if (decimalTarget) {
    const value = Number.parseInt(decimalTarget[1], 10)
    // A character request is answered before the base table: `65 to char`.
    if (CHAR_WORDS.test(normToken(decimalTarget[2]))) {
      const char = charFor(value)
      if (!char) return null
      const reps = REPR_ORDER.map((b) => repr(value, b)).filter((r): r is string => r !== null)
      return [{ title: char, description: reps.join("  ·  ") }]
    }
    const wanted = resolveBase(decimalTarget[2])
    if (!wanted) return null
    return Number.isSafeInteger(value) ? numeralRow(value, wanted) : null
  }

  // A bare Roman numeral: uppercase only, so "mix" stays a word.
  if (/^[IVXLCDM]{1,15}$/.test(s)) {
    const value = fromRoman(s)
    if (value === null) return null
    return LITERAL_BASES.roman.flatMap((b) => numeralRow(value, b))
  }

  return null
}

// ── composites ──

/** The speed of light in vacuum, exact (SI defining constant). */
const LIGHT_SPEED = 299792458
/**
 * The rate units per side of the 8-bit byte, smallest prefix first. A transfer
 * rate is stated on the side the DATA unit was typed on (a bit size gives a
 * bit rate) and in the largest prefix the number still reaches 1 in.
 */
const RATE_SIDES: Record<"byte" | "bit", string[]> = {
  byte: ["B/s", "kB/s", "MB/s", "GB/s", "TB/s"],
  bit: ["bit/s", "kbit/s", "Mbit/s", "Gbit/s"],
}

/** The largest-prefix rate unit `bytesPerSecond` still reaches 1 in. */
function pickRateUnit(names: string[], bytesPerSecond: number): string {
  let chosen = names[0]
  for (const name of names) {
    const ref = byDisplay.get(name)
    if (ref && ref.kind === "unit" && bytesPerSecond >= ref.unit.factor) chosen = name
  }
  return chosen
}

/** A transfer rate: `<amount> <data unit> in|per|over|/ <amount> <time unit>`. */
function rateConversion(s: string): UnitConversion[] | null {
  const m = new RegExp(
    `^(${AMOUNT})\\s*(${UNIT_TOKEN})\\s*(?:in|per|over|/)\\s*(${AMOUNT})\\s*(${UNIT_TOKEN})$`,
    "i",
  ).exec(s)
  if (!m) return null
  const from = resolveUnit(m[2])
  const time = resolveUnit(m[4])
  if (from?.kind !== "unit" || from.family !== "data") return null
  if (time?.kind !== "unit" || time.family !== "time") return null
  const size = parseAmount(m[1])
  const span = parseAmount(m[3])
  if (size === null || span === null || span <= 0) return null
  const bytesPerSecond = (size * from.unit.factor) / (span * time.unit.factor)
  const side = from.display.endsWith("bit") ? "bit" : "byte"
  const unit = pickRateUnit(RATE_SIDES[side], bytesPerSecond)
  // The counterpart is the same prefix on the other side of the 8-bit byte.
  const other = side === "bit" ? unit.replace("bit/s", "B/s") : unit.replace("B/s", "bit/s")
  const per = (name: string): number => {
    const ref = byDisplay.get(name)
    return bytesPerSecond / (ref && ref.kind === "unit" ? ref.unit.factor : 1)
  }
  return [
    {
      title: `${m[1]} ${from.display} in ${m[3]} ${time.display} = ${fmt(per(unit))} ${unit}`,
      description: `= ${fmt(per(other))} ${other}`,
    },
  ]
}

/** An aspect ratio: `<width>x<height>` with both sides a real pixel count. */
function aspectRatio(s: string): UnitConversion[] | null {
  const m = /^(\d{3,5})\s*[x×]\s*(\d{3,5})$/.exec(s)
  if (!m) return null
  const w = Number(m[1])
  const h = Number(m[2])
  if (h === 0) return null
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  const d = gcd(w, h)
  const megapixels = fmt(Number(((w * h) / 1e6).toPrecision(3)))
  return [{ title: `${w / d}:${h / d}`, description: `${w} × ${h}  ·  ${megapixels} Mpx` }]
}

/**
 * The photon relation λ·f = c: a wavelength and a frequency name the same
 * photon, so a query crossing a length unit and a frequency unit answers in
 * the other one. Only a NAMED target crosses the families: no bare amount
 * lists a wavelength's companion frequencies.
 */
function photonRow(
  amountText: string,
  amount: number,
  from: Ref & { kind: "unit" },
  to: Ref & { kind: "unit" },
): UnitConversion | null {
  const crossing =
    (from.family === "length" && to.family === "frequency") ||
    (from.family === "frequency" && to.family === "length")
  if (!crossing) return null
  // λ · f = c in either direction: the source quantity in SI, the constant,
  // then the target's own factor.
  const value = LIGHT_SPEED / (amount * from.unit.factor * to.unit.factor)
  return {
    title: `${amountText} ${from.display} = ${fmt(value)} ${to.display}`,
    description: `λ · f = c  ·  ${LIGHT_SPEED} m/s`,
  }
}

/**
 * The kitchen ingredients: the mass of one US cup, so a volume measure becomes
 * a mass. The numbers are the published US chart values (1 US cup of
 * all-purpose flour is 125 g, of granulated sugar 200 g, of water 236.588 g),
 * and every row names the measure it used.
 */
interface Ingredient {
  names: string[]
  label: string
  /** grams of the ingredient in one US customary cup */
  gramsPerUsCup: number
}

const INGREDIENTS: Ingredient[] = [
  { names: ["water"], label: "water", gramsPerUsCup: 236.5882365 },
  { names: ["milk"], label: "milk", gramsPerUsCup: 245 },
  { names: ["butter"], label: "butter", gramsPerUsCup: 226.8 },
  {
    names: ["flour", "allpurposeflour", "plainflour"],
    label: "all-purpose flour",
    gramsPerUsCup: 125,
  },
  {
    names: ["sugar", "granulatedsugar", "whitesugar"],
    label: "granulated sugar",
    gramsPerUsCup: 200,
  },
  { names: ["brownsugar"], label: "packed brown sugar", gramsPerUsCup: 220 },
  { names: ["honey"], label: "honey", gramsPerUsCup: 340 },
  { names: ["oil", "vegetableoil"], label: "vegetable oil", gramsPerUsCup: 218 },
  { names: ["rice", "riceuncooked"], label: "uncooked rice", gramsPerUsCup: 185 },
  { names: ["oats", "rolledoats", "oatmeal"], label: "rolled oats", gramsPerUsCup: 90 },
]

/** The US customary cup the published chart numbers are stated in. */
const US_CUP_ML = 236.5882365

/**
 * A kitchen measure: `<amount> <volume unit> <ingredient> [to <mass unit>]` and
 * its reverse `<amount> <mass unit> <ingredient> to <volume unit>`. The
 * ingredient's chart mass turns the volume into a mass and back; a query whose
 * target sits in the SAME family as the source is an ordinary conversion and
 * carries no ingredient.
 */
function ingredientConversion(s: string): UnitConversion[] | null {
  const m = new RegExp(
    `^(${AMOUNT})\\s*(${UNIT_TOKEN})\\s+(?:of\\s+)?([A-Za-z]+(?:\\s+[A-Za-z]+)?)(?:${NUMERAL_SEP}(.+))?$`,
    "i",
  ).exec(s)
  if (!m) return null
  const from = resolveUnit(m[2])
  if (from?.kind !== "unit") return null
  if (from.family !== "volume" && from.family !== "mass") return null
  const ingredient = INGREDIENTS.find((i) => i.names.includes(normToken(m[3])))
  if (!ingredient) return null
  const amount = parseAmount(m[1])
  if (amount === null) return null

  const density = ingredient.gramsPerUsCup / US_CUP_ML
  // Everything runs through millilitres, so both directions share one number.
  const millilitres =
    from.family === "volume"
      ? amount * from.unit.factor * 1000
      : (amount * from.unit.factor * 1000) / density
  const note = `${ingredient.label}, ${fmt(Number(density.toPrecision(4)))} g/mL`
  const chart = `1 US cup = ${fmt(ingredient.gramsPerUsCup)} g`
  const massIn = (unit: Unit): number => (millilitres * density) / 1000 / unit.factor
  const volumeIn = (unit: Unit): number => millilitres / 1000 / unit.factor

  if (m[4] !== undefined) {
    const to = resolveUnit(m[4])
    if (to?.kind !== "unit") return null
    // A same-family target is an ordinary conversion: the density is irrelevant.
    if (to.family === from.family) {
      return [linearRow(m[1], amount, from, to)]
    }
    if (from.family === "volume" && to.family === "mass") {
      const convention = from.unit.note ? `  ·  ${from.unit.note}` : ""
      return [
        {
          title: `${m[1]} ${from.display} ${ingredient.label} = ${fmt(massIn(to.unit))} ${to.display}`,
          description: `${note}  ·  ${chart}${convention}`,
        },
      ]
    }
    if (from.family === "mass" && to.family === "volume") {
      const convention = to.unit.note ? `  ·  ${to.unit.note}` : ""
      return [
        {
          title: `${m[1]} ${from.display} ${ingredient.label} = ${fmt(volumeIn(to.unit))} ${to.display}`,
          description: `${note}  ·  ${chart}${convention}`,
        },
      ]
    }
    return null
  }

  // A bare amount answers in the family's own companions: a volume measure in
  // grams, nothing else (a mass without a volume target states no volume).
  if (from.family !== "volume") return null
  const convention = from.unit.note ? `  ·  ${from.unit.note}` : ""
  return ["g", "oz"]
    .map((d) => byDisplay.get(d))
    .filter(
      (r): r is Ref & { kind: "unit" } =>
        r !== undefined && r.kind === "unit" && r.family === "mass",
    )
    .map((t) => ({
      title: `${m[1]} ${from.display} ${ingredient.label} = ${fmt(massIn(t.unit))} ${t.display}`,
      description: `${note}  ·  ${chart}${convention}`,
    }))
}

// ── row assembly ──

function temperatureRow(
  amountText: string,
  amount: number,
  from: Scale,
  to: Scale,
): UnitConversion {
  const value = to.fromCelsius(from.toCelsius(amount))
  // The third scale is the free extra fact of a three-scale system.
  const third = SCALES.find((s) => s !== from && s !== to)
  return {
    title: `${amountText} ${from.display} = ${fmt(value)} ${to.display}`,
    description: third
      ? `= ${fmt(third.fromCelsius(from.toCelsius(amount)))} ${third.display}`
      : undefined,
  }
}

function linearRow(
  amountText: string,
  amount: number,
  from: Ref & { kind: "unit" },
  to: Ref & { kind: "unit" },
): UnitConversion {
  const value = (amount * from.unit.factor) / to.unit.factor
  const rate = from.unit.factor / to.unit.factor
  const base = `1 ${from.display} = ${fmt(rate)} ${to.display}`
  const note = rowNote(from.unit, to.unit)
  return {
    title: `${amountText} ${from.display} = ${fmt(value)} ${to.display}`,
    description: note ? `${base}  ·  ${note}` : base,
  }
}

/**
 * The convention a row answered in, source side first: a row between a metric
 * measure and a US customary one names both, so a number can never be read
 * under the wrong measure. A row of units that read the same everywhere
 * (mL, L) names none.
 */
function rowNote(from: Unit, to: Unit): string | undefined {
  const notes: string[] = []
  for (const note of [from.note, to.note]) {
    if (note && !notes.includes(note)) notes.push(note)
  }
  return notes.length > 0 ? notes.join("  ·  ") : undefined
}

/**
 * Conversion rows for `query` (0 rows when the query is not a conversion this
 * table knows — qalc answers those instead).
 */
export function unitConversions(query: string): UnitConversion[] {
  // One canonical spelling of the separators: `->`/`→` spaced out (the numeral
  // and unit grammars both split on single spaces) and runs of whitespace
  // collapsed.
  const s = query
    .trim()
    .replace(/\s*(?:->|→)\s*/g, " -> ")
    .replace(/\s+/g, " ")
  if (!s) return []

  const numerals = numeralConversions(s)
  if (numerals) return numerals

  const rate = rateConversion(s)
  if (rate) return rate

  const aspect = aspectRatio(s)
  if (aspect) return aspect

  const ingredient = ingredientConversion(s)
  if (ingredient) return ingredient

  const parsed = parseQuery(s)
  if (!parsed) return []
  const amount = parseAmount(parsed.amountText)
  if (amount === null) return []

  // The named target is read FIRST: it decides whether a bare `k` source reads
  // as kelvin (`100k to c`) or names no unit at all (a `k` beside a length
  // target is "thousand", and converts to nothing), and it decides which unit
  // owns a context-resolved spelling (`g`, `pt`, `nm`).
  const rawTarget = parsed.toToken !== null ? resolveUnit(parsed.toToken) : null
  const targetFamily = rawTarget?.kind === "unit" ? rawTarget.family : null

  const from =
    resolveContexts(parsed.fromToken, targetFamily) ??
    resolveUnit(parsed.fromToken) ??
    resolveScaleShort(parsed.fromToken, rawTarget?.kind !== "temp")
  if (!from) return []

  if (parsed.toToken === null) {
    if (from.kind === "temp") {
      const scale = from.scale
      return scale.to
        .map((c) => byDisplay.get(c))
        .filter((t): t is Ref & { kind: "temp" } => t !== undefined && t.kind === "temp")
        .map((t) => temperatureRow(parsed.amountText, amount, scale, t.scale))
    }
    const source = from
    return source.unit.to
      .map((c) => byDisplay.get(c))
      .filter(
        (t): t is Ref & { kind: "unit" } =>
          t !== undefined && t.kind === "unit" && t.family === source.family,
      )
      .map((t) => linearRow(parsed.amountText, amount, source, t))
  }

  const fromFamily = from.kind === "unit" ? from.family : null
  const to =
    resolveContexts(parsed.toToken, fromFamily) ??
    (from.kind === "temp" ? resolveScaleShort(parsed.toToken, false) : null) ??
    rawTarget
  if (!to) return []

  if (from.kind === "temp") {
    if (to.kind !== "temp") return []
    return [temperatureRow(parsed.amountText, amount, from.scale, to.scale)]
  }
  if (to.kind !== "unit") return []
  // A wavelength and a frequency are the same photon: the one family pair the
  // table crosses, and only towards a named target.
  const photon = photonRow(parsed.amountText, amount, from, to)
  if (photon) return [photon]
  if (to.family !== from.family) return []
  return [linearRow(parsed.amountText, amount, from, to)]
}
