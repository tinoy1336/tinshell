/**
 * units.probe — reproducible probe for the launcher's unit conversions
 * (apps/launcher/sources/units.ts).
 *
 * Pure module, no gi, no GTK: it pins the exact row text each query produces —
 * temperature in both spellings and every scale, the linear families
 * (length, mass, volume, area-free), the binary/decimal prefix split, the
 * bit-vs-byte rate, energy, power, pressure, force, frequency, torque,
 * typography and acceleration, the numeral family, the metric cooking
 * measures and their US and imperial variants, the kitchen ingredients, the
 * photographic and transfer-rate composites, the context-resolved spellings
 * (`k`, `g`, `pt`, `nm`, `kn`), and the SI-first row order of a bare amount.
 * Every expected value is written out by hand from the defining factors (the
 * international yard/pound agreements, IEC 1024 prefixes, °F = 1.8·°C + 32,
 * 1 in = 25.4 mm, 1 US gal = 231 in³, the Canadian metric measures 250/15/5 mL,
 * the thermochemical calorie 4.184 J, the IT BTU 1055.05585262 J, standard
 * gravity 9.80665 m/s², the IAU astronomical unit, the Julian year, the CSS
 * pixel at 96 px/in, and λ·f = c) — the probe compares the module against those
 * constants, not against itself.
 *
 * Run:
 *   ags bundle --gtk 4 apps/launcher/sources/units.probe.ts /tmp/units-probe.sh
 *   bash /tmp/units-probe.sh     # exit 1 on any wrong row (the module imports
 *                                # the shared matcher through the @common alias,
 *                                # which a plain-Node run cannot resolve)
 */
import { unitConversions } from "./units.ts"

const checks: [string, string, string][] = []

/** `<query>` → `[title, description][]`, compared as JSON. */
function conv(query: string, ...expected: [string, string][]): void {
  const actual = unitConversions(query).map((r) => [r.title, r.description ?? ""])
  checks.push([query, JSON.stringify(actual), JSON.stringify(expected)])
}

// ── temperature: every spelling, all three scales, SI first ──
conv("20C", ["20 °C = 293.15 K", "= 68 °F"], ["20 °C = 68 °F", "= 293.15 K"])
conv("20 °C", ["20 °C = 293.15 K", "= 68 °F"], ["20 °C = 68 °F", "= 293.15 K"])
conv("20degC", ["20 °C = 293.15 K", "= 68 °F"], ["20 °C = 68 °F", "= 293.15 K"])
conv("68f", ["68 °F = 20 °C", "= 293.15 K"], ["68 °F = 293.15 K", "= 20 °C"])
conv("68f to c", ["68 °F = 20 °C", "= 293.15 K"])
conv("0c to f", ["0 °C = 32 °F", "= 273.15 K"])
conv("100c to k", ["100 °C = 373.15 K", "= 212 °F"])
// −40 is the scale crossing: the same number on both sides.
conv("-40c to f", ["-40 °C = -40 °F", "= 233.15 K"])
conv("20 kelvin to c", ["20 K = -253.15 °C", "= -423.67 °F"])
conv("20 celsius to fahrenheit", ["20 °C = 68 °F", "= 293.15 K"])
conv("100 degF to c", ["100 °F = 37.7778 °C", "= 310.928 K"])

// ── `k`: kelvin only where the query names a temperature target ──
// Either side counts: `100k to c` and `5 K to C` are both kelvin, while a
// bare `k` names no unit at all (it reads as "thousand": 4k, 10k).
conv("100k to c", ["100 K = -173.15 °C", "= -279.67 °F"])
conv("5 k to f", ["5 K = -450.67 °F", "= -268.15 °C"])
conv("5 K to C", ["5 K = -268.15 °C", "= -450.67 °F"])
conv("100 k in c", ["100 K = -173.15 °C", "= -279.67 °F"])
conv("4k to c", ["4 K = -269.15 °C", "= -452.47 °F"])
conv("5 degK to c", ["5 K = -268.15 °C", "= -450.67 °F"])
// A `k` beside a non-temperature target stays "thousand": no unit, no row.
// So does a bare `4k`/`10k` — a display resolution and a race distance are
// ordinary searches, so the table answers neither.
conv("5 k to m")
conv("4k")
conv("10k")

// ── length ──
conv("1 m to ft", ["1 m = 3.28084 ft", "1 m = 3.28084 ft"])
conv("100 km to mi", ["100 km = 62.1371 mi", "1 km = 0.621371 mi"])
conv("5 mi to km", ["5 mi = 8.04672 km", "1 mi = 1.60934 km"])
conv(
  "2 miles",
  ["2 mi = 3.21869 km", "1 mi = 1.60934 km"],
  ["2 mi = 3218.69 m", "1 mi = 1609.34 m"],
)
conv("100 in to cm", ["100 in = 254 cm", "1 in = 2.54 cm"])
conv("100 in", ["100 in = 254 cm", "1 in = 2.54 cm"], ["100 in = 2540 mm", "1 in = 25.4 mm"])
conv("1 nm to m", ["1 nm = 1.0000e-9 m", "1 nm = 1.0000e-9 m"])
conv("1 nm", ["1 nm = 0.001 µm", "1 nm = 0.001 µm"], ["1 nm = 0.000001 mm", "1 nm = 0.000001 mm"])
conv("1 micron to mm", ["1 µm = 0.001 mm", "1 µm = 0.001 mm"])
// The astronomical definitions: the IAU astronomical unit is exact, the
// light-year is it through the Julian year.
conv("1 au to m", ["1 au = 149597870700 m", "1 au = 149597870700 m"])
conv("1 au to mi", ["1 au = 92955800 mi", "1 au = 92955800 mi"])
conv("1 ly to m", ["1 ly = 9460730472580800 m", "1 ly = 9460730472580800 m"])

// ── mass ──
conv("1 kg to lb", ["1 kg = 2.20462 lb", "1 kg = 2.20462 lb"])
conv("1 st to kg", ["1 st = 6.35029 kg", "1 st = 6.35029 kg"])
conv("16 oz to lb", ["16 oz = 1 lb", "1 oz = 0.0625 lb"])
conv("1 µg to mg", ["1 µg = 0.001 mg", "1 µg = 0.001 mg"])
conv("1 ct to g", ["1 ct = 0.2 g", "1 ct = 0.2 g"])
conv("1 gr to mg", ["1 gr = 64.7989 mg", "1 gr = 64.7989 mg"])
conv("1 slug to kg", ["1 slug = 14.5939 kg", "1 slug = 14.5939 kg"])
// A bare `ton` is the North American short ton; the metric tonne keeps
// `tonne`/`t` and the imperial ton is named in full.
conv("1 ton to kg", ["1 ton = 907.185 kg", "1 ton = 907.185 kg  ·  US customary (2000 lb)"])
conv("1 ton to lb", ["1 ton = 2000 lb", "1 ton = 2000 lb  ·  US customary (2000 lb)"])
conv("1 long ton to kg", [
  "1 long ton = 1016.05 kg",
  "1 long ton = 1016.05 kg  ·  imperial (2240 lb)",
])
conv("1 tonne to kg", ["1 t = 1000 kg", "1 t = 1000 kg"])

// ── volume: the cooking measures are metric (Canadian 250/15/5 mL) ──
conv("1 cup to ml", ["1 cup = 250 mL", "1 cup = 250 mL  ·  metric (Canadian)"])
conv("1 tbsp to ml", ["1 tbsp = 15 mL", "1 tbsp = 15 mL  ·  metric (Canadian)"])
conv("1 tsp to ml", ["1 tsp = 5 mL", "1 tsp = 5 mL  ·  metric (Canadian)"])
conv("2 tbsp to tsp", ["2 tbsp = 6 tsp", "1 tbsp = 3 tsp  ·  metric (Canadian)"])
conv("250 ml to cup", ["250 mL = 1 cup", "1 mL = 0.004 cup  ·  metric (Canadian)"])
conv("1 gal to l", ["1 gal = 3.78541 L", "1 gal = 3.78541 L  ·  US customary"])
conv("2 fl oz to ml", ["2 fl oz = 59.1471 mL", "1 fl oz = 29.5735 mL  ·  US customary"])
// A bare measure answers SI first, its imperial counterpart on the next row.
conv(
  "2 cups",
  ["2 cup = 500 mL", "1 cup = 250 mL  ·  metric (Canadian)"],
  ["2 cup = 2.11338 US cup", "1 cup = 1.05669 US cup  ·  metric (Canadian)  ·  US customary"],
)
// The US customary measures are spellable explicitly, and a row that crosses
// conventions names both.
conv("1 us cup to ml", ["1 US cup = 236.588 mL", "1 US cup = 236.588 mL  ·  US customary"])
conv("2 us tbsp to ml", ["2 US tbsp = 29.5735 mL", "1 US tbsp = 14.7868 mL  ·  US customary"])
conv("3 us tsp to ml", ["3 US tsp = 14.7868 mL", "1 US tsp = 4.92892 mL  ·  US customary"])
conv("2 us cups to ml", ["2 US cup = 473.176 mL", "1 US cup = 236.588 mL  ·  US customary"])
conv("3 US tbsp to ml", ["3 US tbsp = 44.3603 mL", "1 US tbsp = 14.7868 mL  ·  US customary"])
conv("1 us gal to l", ["1 gal = 3.78541 L", "1 gal = 3.78541 L  ·  US customary"])
conv("1 us cup to cup", [
  "1 US cup = 0.946353 cup",
  "1 US cup = 0.946353 cup  ·  US customary  ·  metric (Canadian)",
])
conv("1 cup to us cup", [
  "1 cup = 1.05669 US cup",
  "1 cup = 1.05669 US cup  ·  metric (Canadian)  ·  US customary",
])
conv("2 fl oz to tbsp", [
  "2 fl oz = 3.94314 tbsp",
  "1 fl oz = 1.97157 tbsp  ·  US customary  ·  metric (Canadian)",
])
// Imperial (UK) measures carry their own name and note.
conv("1 imp gal to l", ["1 imp gal = 4.54609 L", "1 imp gal = 4.54609 L  ·  imperial"])
conv("1 imp pint to ml", ["1 imp pint = 568.261 mL", "1 imp pint = 568.261 mL  ·  imperial"])
conv("1 imp fl oz to ml", ["1 imp fl oz = 28.4131 mL", "1 imp fl oz = 28.4131 mL  ·  imperial"])
// A US butter stick is half a US cup.
conv("2 sticks to ml", [
  "2 stick = 236.588 mL",
  "1 stick = 118.294 mL  ·  US customary (1/2 US cup)",
])
conv("1 stick to us cup", [
  "1 stick = 0.5 US cup",
  "1 stick = 0.5 US cup  ·  US customary (1/2 US cup)  ·  US customary",
])

// ── data size: decimal prefixes vs binary prefixes ──
conv("1 TiB to B", ["1 TiB = 1099511627776 B", "1 TiB = 1099511627776 B"])
conv("1 TB to GiB", ["1 TB = 931.323 GiB", "1 TB = 931.323 GiB"])
conv("1 B to bit", ["1 B = 8 bit", "1 B = 8 bit"])
conv("1 KiB to KB", ["1 KiB = 1.024 KB", "1 KiB = 1.024 KB"])
conv("1 b to B", ["1 bit = 0.125 B", "1 bit = 0.125 B"])
conv("1 Mbit to MB", ["1 Mbit = 0.125 MB", "1 Mbit = 0.125 MB"])
conv("1 TB to PiB", ["1 TB = 0.000888178 PiB", "1 TB = 0.000888178 PiB"])
conv("1 PiB to TiB", ["1 PiB = 1024 TiB", "1 PiB = 1024 TiB"])

// ── data rate: the bit-vs-byte trap ──
conv("100 Mbit/s to MB/s", ["100 Mbit/s = 12.5 MB/s", "1 Mbit/s = 0.125 MB/s"])
conv("1 Gbit/s to Mbit/s", ["1 Gbit/s = 1000 Mbit/s", "1 Gbit/s = 1000 Mbit/s"])
conv("100 Mbps to MB/s", ["100 Mbit/s = 12.5 MB/s", "1 Mbit/s = 0.125 MB/s"])

// ── speed ──
conv("100 km/h to mph", ["100 km/h = 62.1371 mph", "1 km/h = 0.621371 mph"])
conv("1 kn to km/h", ["1 kn = 1.852 km/h", "1 kn = 1.852 km/h"])
conv("10 m/s to km/h", ["10 m/s = 36 km/h", "1 m/s = 3.6 km/h"])
// A bare speed answers in the SI unit first.
conv(
  "100 km/h",
  ["100 km/h = 27.7778 m/s", "1 km/h = 0.277778 m/s"],
  ["100 km/h = 62.1371 mph", "1 km/h = 0.621371 mph"],
)

// ── energy: the calorie and the BTU are the table's own definitions ──
conv("1 cal to j", ["1 cal = 4.184 J", "1 cal = 4.184 J  ·  thermochemical (4.184 J)"])
conv("1 kcal to j", ["1 kcal = 4184 J", "1 kcal = 4184 J  ·  thermochemical (4184 J)"])
conv("1 kWh to MJ", ["1 kWh = 3.6 MJ", "1 kWh = 3.6 MJ"])
conv("1 BTU to j", ["1 BTU = 1055.06 J", "1 BTU = 1055.06 J  ·  IT (1055.05585262 J)"])
conv("1 therm to kWh", ["1 therm = 29.3071 kWh", "1 therm = 29.3071 kWh  ·  IT (100 000 BTU)"])
conv("1 eV to j", ["1 eV = 1.6022e-19 J", "1 eV = 1.6022e-19 J"])
conv("1 kJ to kcal", ["1 kJ = 0.239006 kcal", "1 kJ = 0.239006 kcal  ·  thermochemical (4184 J)"])

// ── power: mechanical and metric horsepower are 1.4 % apart ──
conv("1 hp to w", ["1 hp = 745.7 W", "1 hp = 745.7 W  ·  mechanical (550 ft·lbf/s)"])
conv("1 PS to kw", ["1 PS = 0.735499 kW", "1 PS = 0.735499 kW  ·  metric (75 kgf·m/s)"])
conv("100 W to hp", ["100 W = 0.134102 hp", "1 W = 0.00134102 hp  ·  mechanical (550 ft·lbf/s)"])
conv("1 BTU/h to w", ["1 BTU/h = 0.293071 W", "1 BTU/h = 0.293071 W"])

// ── pressure ──
conv("1 bar to psi", ["1 bar = 14.5038 psi", "1 bar = 14.5038 psi"])
conv("1 atm to kpa", ["1 atm = 101.325 kPa", "1 atm = 101.325 kPa"])
conv("1 psi to kpa", ["1 psi = 6.89476 kPa", "1 psi = 6.89476 kPa"])
conv("1 torr to pa", ["1 torr = 133.322 Pa", "1 torr = 133.322 Pa"])
conv("1 mmHg to pa", [
  "1 mmHg = 133.322 Pa",
  "1 mmHg = 133.322 Pa  ·  conventional (133.322387415 Pa)",
])
conv("1 inHg to hpa", ["1 inHg = 33.8639 hPa", "1 inHg = 33.8639 hPa"])
conv("100 kPa to bar", ["100 kPa = 1 bar", "1 kPa = 0.01 bar"])

// ── force: `kn` is the knot unless the query names a force ──
conv("1 kgf to n", ["1 kgf = 9.80665 N", "1 kgf = 9.80665 N"])
conv("1 lbf to n", ["1 lbf = 4.44822 N", "1 lbf = 4.44822 N"])
conv("100 n to lbf", ["100 N = 22.4809 lbf", "1 N = 0.224809 lbf"])
conv("1 dyn to n", ["1 dyn = 0.00001 N", "1 dyn = 0.00001 N"])
conv("1 kn to n", ["1 kN = 1000 N", "1 kN = 1000 N"])

// ── frequency: cycles per second, so rpm is /60 and not an angular velocity ──
conv("440 Hz to rpm", ["440 Hz = 26400 rpm", "1 Hz = 60 rpm"])
conv("3000 rpm to hz", ["3000 rpm = 50 Hz", "1 rpm = 0.0166667 Hz"])
conv("1 GHz to MHz", ["1 GHz = 1000 MHz", "1 GHz = 1000 MHz"])

// ── torque: `nm` is the nanometre unless the query names a torque ──
conv("10 Nm to ftlb", ["10 N·m = 7.37562 ft·lb", "1 N·m = 0.737562 ft·lb"])
conv("1 ftlb to nm", ["1 ft·lb = 1.35582 N·m", "1 ft·lb = 1.35582 N·m"])
conv("100 inlb to nm", ["100 in·lb = 11.2985 N·m", "1 in·lb = 0.112985 N·m"])
conv("1 kgfm to nm", ["1 kgf·m = 9.80665 N·m", "1 kgf·m = 9.80665 N·m"])
conv("1 nm to ftlb", ["1 N·m = 0.737562 ft·lb", "1 N·m = 0.737562 ft·lb"])

// ── typography: the CSS definitions (96 px = 1 in, 1 pt = 1/72 in) ──
conv("12 pt to px", ["12 pt = 16 px", "1 pt = 1.33333 px"])
conv("1 pc to pt", ["1 pc = 12 pt", "1 pc = 12 pt"])
conv("96 px to pt", ["96 px = 72 pt", "1 px = 0.75 pt"])
conv("1 pt to px", ["1 pt = 1.33333 px", "1 pt = 1.33333 px"])
// `pt` stays the pint where the query is a volume one.
conv("1 pt to ml", ["1 pint = 473.176 mL", "1 pint = 473.176 mL  ·  US customary"])

// ── acceleration: `g` is the gram unless the query names an acceleration ──
conv("1 g to m/s2", [
  "1 g = 9.80665 m/s²",
  "1 g = 9.80665 m/s²  ·  standard gravity (9.80665 m/s²)",
])
conv("9.81 m/s2 to g", [
  "9.81 m/s² = 1.00034 g",
  "1 m/s² = 0.101972 g  ·  standard gravity (9.80665 m/s²)",
])
conv("32 ft/s2 to m/s2", ["32 ft/s² = 9.7536 m/s²", "1 ft/s² = 0.3048 m/s²"])
conv("1 m/s² to g", [
  "1 m/s² = 0.101972 g",
  "1 m/s² = 0.101972 g  ·  standard gravity (9.80665 m/s²)",
])
conv("1 g", ["1 g = 1000 mg", "1 g = 1000 mg"], ["1 g = 0.035274 oz", "1 g = 0.035274 oz"])

// ── the photon relation: a wavelength and a frequency are one photon ──
conv("700 nm to THz", ["700 nm = 428.275 THz", "λ · f = c  ·  299792458 m/s"])
conv("1 THz to nm", ["1 THz = 299792 nm", "λ · f = c  ·  299792458 m/s"])
// The photon relation needs a named target: a bare wavelength answers its
// own family's companions, like every other length.
conv("700 nm", ["700 nm = 0.7 µm", "1 nm = 0.001 µm"], ["700 nm = 0.0007 mm", "1 nm = 0.000001 mm"])

// ── numerals: hex / octal / binary / Roman / character ──
conv("255 in binary", ["0b11111111", "255  ·  0xff  ·  CCLV"])
conv("255 in hex", ["0xff", "255  ·  0b11111111  ·  CCLV"])
conv("0xff", ["255", "0xff  ·  0b11111111  ·  CCLV"], ["0b11111111", "255  ·  0xff  ·  CCLV"])
conv("0b1011", ["11", "0xb  ·  0b1011  ·  XI"], ["0xb", "11  ·  0b1011  ·  XI"])
conv("100 to hex", ["0x64", "100  ·  0b1100100  ·  C"])
conv("2026 in roman", ["MMXXVI", "2026  ·  0x7ea  ·  0b11111101010"])
conv("MMXXVI to decimal", ["2026", "0x7ea  ·  0b11111101010  ·  MMXXVI"])
conv(
  "MMXXVI",
  ["2026", "0x7ea  ·  0b11111101010  ·  MMXXVI"],
  ["0x7ea", "2026  ·  0b11111101010  ·  MMXXVI"],
)
conv("65 to char", ["A", "65  ·  0x41  ·  0b1000001  ·  LXV"])
conv("8594 to char", ["→", "8594  ·  0x2192  ·  0b10000110010010"])
// lowercase Roman is a word ("mix"), never a numeral
conv("mix to decimal")
conv("xii to decimal")
// outside 1..3999 standard notation there is no Roman numeral
conv("5000 in roman")
// no character lives at a control code point
conv("10 to char")
conv("55296 to char")

// ── fuzzy resolution of a typed spelling ──
conv("20 cel", ["20 °C = 293.15 K", "= 68 °F"], ["20 °C = 68 °F", "= 293.15 K"])
conv("100 kilometr to mi", ["100 km = 62.1371 mi", "1 km = 0.621371 mi"])
conv("1 miligram to mg", ["1 mg = 1 mg", "1 mg = 1 mg"])
conv("100 kilopascal to psi", ["100 kPa = 14.5038 psi", "1 kPa = 0.145038 psi"])

// ── amounts: fractions, mixed numbers, grouped thousands, exponents ──
conv("1/2 cup to ml", ["1/2 cup = 125 mL", "1 cup = 250 mL  ·  metric (Canadian)"])
conv("2 1/2 cups to ml", ["2 1/2 cup = 625 mL", "1 cup = 250 mL  ·  metric (Canadian)"])
conv("1,000 m to km", ["1,000 m = 1 km", "1 m = 0.001 km"])
conv("2.5e3 m to km", ["2.5e3 m = 2.5 km", "1 m = 0.001 km"])
// A comma that is not a thousands group names no amount (`1,5` is not 15).
conv("1,5 m to km")

// ── kitchen ingredients: a volume becomes a mass ──
conv("1 cup flour to g", [
  "1 cup all-purpose flour = 132.086 g",
  "all-purpose flour, 0.5283 g/mL  ·  1 US cup = 125 g  ·  metric (Canadian)",
])
conv("1 us cup flour to g", [
  "1 US cup all-purpose flour = 125 g",
  "all-purpose flour, 0.5283 g/mL  ·  1 US cup = 125 g  ·  US customary",
])
conv("1 cup sugar to g", [
  "1 cup granulated sugar = 211.338 g",
  "granulated sugar, 0.8454 g/mL  ·  1 US cup = 200 g  ·  metric (Canadian)",
])
conv("1 stick of butter to g", [
  "1 stick butter = 113.4 g",
  "butter, 0.9586 g/mL  ·  1 US cup = 226.8 g  ·  US customary (1/2 US cup)",
])
conv("1 tbsp butter to g", [
  "1 tbsp butter = 14.3794 g",
  "butter, 0.9586 g/mL  ·  1 US cup = 226.8 g  ·  metric (Canadian)",
])
conv("1 cup water to g", [
  "1 cup water = 250 g",
  "water, 1 g/mL  ·  1 US cup = 236.588 g  ·  metric (Canadian)",
])
// A bare ingredient query lists the mass companions.
conv(
  "2 cups flour",
  [
    "2 cup all-purpose flour = 264.172 g",
    "all-purpose flour, 0.5283 g/mL  ·  1 US cup = 125 g  ·  metric (Canadian)",
  ],
  [
    "2 cup all-purpose flour = 9.31839 oz",
    "all-purpose flour, 0.5283 g/mL  ·  1 US cup = 125 g  ·  metric (Canadian)",
  ],
)
// An ingredient named with a VOLUME target is an ordinary volume conversion.
conv("1 cup flour to ml", ["1 cup = 250 mL", "1 cup = 250 mL  ·  metric (Canadian)"])
// The reverse direction: a mass becomes the volume that weighs it.
conv("500 g flour to us cup", [
  "500 g all-purpose flour = 4 US cup",
  "all-purpose flour, 0.5283 g/mL  ·  1 US cup = 125 g  ·  US customary",
])
conv("500 g flour to cup", [
  "500 g all-purpose flour = 3.78541 cup",
  "all-purpose flour, 0.5283 g/mL  ·  1 US cup = 125 g  ·  metric (Canadian)",
])
conv("250 g butter to cup", [
  "250 g butter = 1.04316 cup",
  "butter, 0.9586 g/mL  ·  1 US cup = 226.8 g  ·  metric (Canadian)",
])
conv("200 g sugar to cup", [
  "200 g granulated sugar = 0.946353 cup",
  "granulated sugar, 0.8454 g/mL  ·  1 US cup = 200 g  ·  metric (Canadian)",
])
// A same-family target is an ordinary conversion: the density is irrelevant.
conv("1 kg flour to lb", ["1 kg = 2.20462 lb", "1 kg = 2.20462 lb"])
// A word the ingredient table does not know is not an ingredient.
conv("1 cup of coffee")
conv("5 gallons of paint")

// ── composites: a transfer rate and an aspect ratio ──
conv("500 MB in 30 s", ["500 MB in 30 s = 16.6667 MB/s", "= 133.333 Mbit/s"])
conv("4 GB in 1 h", ["4 GB in 1 h = 1.11111 MB/s", "= 8.88889 Mbit/s"])
conv("2 Mbit in 4 s", ["2 Mbit in 4 s = 500 kbit/s", "= 62.5 kB/s"])
conv("1920x1080", ["16:9", "1920 × 1080  ·  2.07 Mpx"])
conv("1024x768", ["4:3", "1024 × 768  ·  0.786 Mpx"])
conv("3840x2160", ["16:9", "3840 × 2160  ·  8.29 Mpx"])
// A two-digit pair is not an aspect ratio (2x4 is lumber, not a display).
conv("2x4")

// ── SI-first row order on a bare amount ──
conv(
  "100 km",
  ["100 km = 100000 m", "1 km = 1000 m"],
  ["100 km = 62.1371 mi", "1 km = 0.621371 mi"],
)
conv("1 lb", ["1 lb = 0.453592 kg", "1 lb = 0.453592 kg"], ["1 lb = 453.592 g", "1 lb = 453.592 g"])
conv("1 TB", ["1 TB = 1000 GB", "1 TB = 1000 GB"], ["1 TB = 0.909495 TiB", "1 TB = 0.909495 TiB"])
conv(
  "1 stick",
  ["1 stick = 0.5 US cup", "1 stick = 0.5 US cup  ·  US customary (1/2 US cup)  ·  US customary"],
  ["1 stick = 118.294 mL", "1 stick = 118.294 mL  ·  US customary (1/2 US cup)"],
)

// ── time ──
conv("90 min to h", ["90 min = 1.5 h", "1 min = 0.0166667 h"])
conv("1 wk to d", ["1 wk = 7 d", "1 wk = 7 d"])
conv("3600 s", ["3600 s = 60 min", "1 s = 0.0166667 min"], ["3600 s = 1 h", "1 s = 0.000277778 h"])
conv("90 µs to ns", ["90 µs = 90000 ns", "1 µs = 1000 ns"])
conv("1 fortnight to d", ["1 fortnight = 14 d", "1 fortnight = 14 d"])
// The year is the Julian year, the unit every astronomical definition uses.
conv("1 yr to d", ["1 yr = 365.25 d", "1 yr = 365.25 d  ·  Julian year (365.25 d)"])
conv("1 century to d", ["1 century = 36525 d", "1 century = 36525 d"])

// ── not a conversion this table knows (qalc answers these) ──
conv("hello")
conv("1 m to s")
conv("100 furlong to m")
conv("10 kg of potatoes")
conv("5")
// A `us`-prefixed word outside the cooking measures is not a unit: a currency
// pair still reaches qalc.
conv("100 usd to cad")
conv("")
// A squared or cubed spelling is not the linear unit with a stray character:
// `m2`/`m²` name no unit this table has (area is qalc's business).
conv("100 m2")
conv("100 m²")
conv("1 m3")

const failed = checks.filter(([, actual, expected]) => actual !== expected)
for (const [name, actual, expected] of checks) {
  const ok = actual === expected
  console.log(
    `${ok ? "ok  " : "FAIL"} ${JSON.stringify(name)}${ok ? "" : `\n     got  ${actual}\n     want ${expected}`}`,
  )
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) throw new Error(`units probe failed: ${failed.length} check(s)`)
