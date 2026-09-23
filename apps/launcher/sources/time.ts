/**
 * Time-zone converter source — pure Intl (ECMA-402), no subprocess, sync.
 *
 * Shapes:
 *   <time> <from> (to|in|→|->) <to>   e.g. "9pm utc to est", "21:00 jst to utc"
 *   now [<from>] (to|in|→|->) <to>    e.g. "now to pst" (local tz), "now utc to pst"
 *
 * Time tokens: "9pm", "9:30 pm", "21:00" (24h), "now". Zone tokens:
 *   - abbreviations: est/edt, pst/pdt, cet/cest, ist, jst, bst, ... (~30)
 *   - US colloquial names: "eastern", "central", "mountain", "pacific", ...
 *   - country/region names: "china time", "kerala", "uk", "south africa", ...
 *   - cities: "new york", "london", "tokyo", "kathmandu", "st johns", ... (~200)
 *   - fixed UTC offsets: "utc+5:30", "gmt-8", "+2", "utc+2" (label preserves
 *     the typed prefix; "+5:30" alone renders as UTC+5:30)
 *   - any IANA name passed through verbatim (e.g. "europe/london")
 * A trailing "time" word is stripped ("china time" → "china"). Every zone is
 * validated by constructing an Intl.DateTimeFormat (RangeError = unknown).
 *
 * The from-side wall clock is converted to an absolute instant INDEPENDENT of
 * the machine's local timezone via an offset probe loop (zonedWallToUtc), so
 * "9pm utc to est" means 21:00 UTC everywhere. Offset zones are exact math
 * (instant = wall − offset). `local` (either side) is the machine's tz.
 *
 * Abbreviations come from an explicit std/dst table, NOT Intl's
 * timeZoneName "short" — current CLDR renders offset forms ("GMT+2") for
 * most non-US zones. DST is detected by comparing the instant's offset to
 * the zone's minimum offset over the year (min-over-year is the standard
 * offset in BOTH hemispheres, so Australia/New Zealand resolve correctly).
 * Unmapped IANA pass-through zones fall back to Intl's own short name.
 *
 * Returns 0 rows when the shape doesn't parse or a zone doesn't resolve. The
 * combiner treats row presence as the gate: a parseable time query never
 * reaches qalc (which mangles "9pm utc to est" into unit garbage).
 */

import { copy } from "@common/clipboard"
import { ignore } from "@common/log/logger"
import type { Result } from "../types"

interface ZoneInfo {
  /** IANA zone name (empty for fixed-offset zones). */
  zone: string
  /** Standard (winter) abbreviation. Empty for IANA pass-through zones. */
  std: string
  /** DST abbreviation; absent for zones without DST. */
  dst?: string
  /** Fixed UTC offset in ms (offset zones like "utc+5:30"). */
  offset?: number
}

/**
 * Zone table: abbreviations, colloquial/regional names, countries, and
 * cities → IANA zone + display abbreviations. Ambiguous abbreviations
 * default to the most common reading (cst = US Central, ist = India,
 * ast = Atlantic); ambiguous country/city defaults are noted inline.
 */
const ZONES: Record<string, ZoneInfo> = {
  // === exact / fixed ===
  utc: { zone: "Etc/UTC", std: "UTC" },
  gmt: { zone: "Etc/GMT", std: "GMT" },
  greenwich: { zone: "Etc/GMT", std: "GMT" },
  // === US / Canada colloquial ===
  eastern: { zone: "America/New_York", std: "EST", dst: "EDT" },
  east: { zone: "America/New_York", std: "EST", dst: "EDT" },
  central: { zone: "America/Chicago", std: "CST", dst: "CDT" },
  mountain: { zone: "America/Denver", std: "MST", dst: "MDT" },
  pacific: { zone: "America/Los_Angeles", std: "PST", dst: "PDT" },
  atlantic: { zone: "America/Halifax", std: "AST", dst: "ADT" },
  alaska: { zone: "America/Anchorage", std: "AKST", dst: "AKDT" },
  hawaii: { zone: "Pacific/Honolulu", std: "HST" },
  arizona: { zone: "America/Phoenix", std: "MST" }, // no DST
  california: { zone: "America/Los_Angeles", std: "PST", dst: "PDT" },
  usa: { zone: "America/New_York", std: "EST", dst: "EDT" }, // default = Eastern
  canada: { zone: "America/Toronto", std: "EST", dst: "EDT" }, // default = Eastern
  // === abbreviations (DST pairs share one entry) ===
  est: { zone: "America/New_York", std: "EST", dst: "EDT" },
  edt: { zone: "America/New_York", std: "EST", dst: "EDT" },
  cst: { zone: "America/Chicago", std: "CST", dst: "CDT" }, // also China — defaulting to US Central
  cdt: { zone: "America/Chicago", std: "CST", dst: "CDT" },
  mst: { zone: "America/Denver", std: "MST", dst: "MDT" },
  mdt: { zone: "America/Denver", std: "MST", dst: "MDT" },
  pst: { zone: "America/Los_Angeles", std: "PST", dst: "PDT" },
  pdt: { zone: "America/Los_Angeles", std: "PST", dst: "PDT" },
  akst: { zone: "America/Anchorage", std: "AKST", dst: "AKDT" },
  akdt: { zone: "America/Anchorage", std: "AKST", dst: "AKDT" },
  hst: { zone: "Pacific/Honolulu", std: "HST" },
  ast: { zone: "America/Halifax", std: "AST", dst: "ADT" }, // Atlantic; also Arabia — defaulting to Atlantic
  adt: { zone: "America/Halifax", std: "AST", dst: "ADT" },
  cet: { zone: "Europe/Paris", std: "CET", dst: "CEST" },
  cest: { zone: "Europe/Paris", std: "CET", dst: "CEST" },
  bst: { zone: "Europe/London", std: "GMT", dst: "BST" }, // British Summer Time
  ist: { zone: "Asia/Kolkata", std: "IST" }, // India; also Irish/Israeli — defaulting to India
  jst: { zone: "Asia/Tokyo", std: "JST" },
  kst: { zone: "Asia/Seoul", std: "KST" },
  sgt: { zone: "Asia/Singapore", std: "SGT" },
  hkt: { zone: "Asia/Hong_Kong", std: "HKT" },
  aest: { zone: "Australia/Sydney", std: "AEST", dst: "AEDT" },
  aedt: { zone: "Australia/Sydney", std: "AEST", dst: "AEDT" },
  acst: { zone: "Australia/Adelaide", std: "ACST", dst: "ACDT" },
  acdt: { zone: "Australia/Adelaide", std: "ACST", dst: "ACDT" },
  awst: { zone: "Australia/Perth", std: "AWST" },
  nzst: { zone: "Pacific/Auckland", std: "NZST", dst: "NZDT" },
  nzdt: { zone: "Pacific/Auckland", std: "NZST", dst: "NZDT" },
  nst: { zone: "America/St_Johns", std: "NST", dst: "NDT" }, // Newfoundland −3:30/−2:30
  ndt: { zone: "America/St_Johns", std: "NST", dst: "NDT" },
  // === US cities ===
  "new york": { zone: "America/New_York", std: "EST", dst: "EDT" },
  nyc: { zone: "America/New_York", std: "EST", dst: "EDT" },
  boston: { zone: "America/New_York", std: "EST", dst: "EDT" },
  miami: { zone: "America/New_York", std: "EST", dst: "EDT" },
  atlanta: { zone: "America/New_York", std: "EST", dst: "EDT" },
  detroit: { zone: "America/New_York", std: "EST", dst: "EDT" },
  philadelphia: { zone: "America/New_York", std: "EST", dst: "EDT" },
  baltimore: { zone: "America/New_York", std: "EST", dst: "EDT" },
  washington: { zone: "America/New_York", std: "EST", dst: "EDT" },
  dc: { zone: "America/New_York", std: "EST", dst: "EDT" },
  charlotte: { zone: "America/New_York", std: "EST", dst: "EDT" },
  cincinnati: { zone: "America/New_York", std: "EST", dst: "EDT" },
  cleveland: { zone: "America/New_York", std: "EST", dst: "EDT" },
  pittsburgh: { zone: "America/New_York", std: "EST", dst: "EDT" },
  orlando: { zone: "America/New_York", std: "EST", dst: "EDT" },
  tampa: { zone: "America/New_York", std: "EST", dst: "EDT" },
  chicago: { zone: "America/Chicago", std: "CST", dst: "CDT" },
  dallas: { zone: "America/Chicago", std: "CST", dst: "CDT" },
  houston: { zone: "America/Chicago", std: "CST", dst: "CDT" },
  austin: { zone: "America/Chicago", std: "CST", dst: "CDT" },
  minneapolis: { zone: "America/Chicago", std: "CST", dst: "CDT" },
  "new orleans": { zone: "America/Chicago", std: "CST", dst: "CDT" },
  nashville: { zone: "America/Chicago", std: "CST", dst: "CDT" },
  memphis: { zone: "America/Chicago", std: "CST", dst: "CDT" },
  "kansas city": { zone: "America/Chicago", std: "CST", dst: "CDT" },
  "oklahoma city": { zone: "America/Chicago", std: "CST", dst: "CDT" },
  tulsa: { zone: "America/Chicago", std: "CST", dst: "CDT" },
  denver: { zone: "America/Denver", std: "MST", dst: "MDT" },
  albuquerque: { zone: "America/Denver", std: "MST", dst: "MDT" },
  "salt lake city": { zone: "America/Denver", std: "MST", dst: "MDT" },
  boise: { zone: "America/Denver", std: "MST", dst: "MDT" },
  "los angeles": { zone: "America/Los_Angeles", std: "PST", dst: "PDT" },
  la: { zone: "America/Los_Angeles", std: "PST", dst: "PDT" },
  "san francisco": { zone: "America/Los_Angeles", std: "PST", dst: "PDT" },
  sf: { zone: "America/Los_Angeles", std: "PST", dst: "PDT" },
  "san diego": { zone: "America/Los_Angeles", std: "PST", dst: "PDT" },
  seattle: { zone: "America/Los_Angeles", std: "PST", dst: "PDT" },
  portland: { zone: "America/Los_Angeles", std: "PST", dst: "PDT" },
  "las vegas": { zone: "America/Los_Angeles", std: "PST", dst: "PDT" },
  reno: { zone: "America/Los_Angeles", std: "PST", dst: "PDT" },
  phoenix: { zone: "America/Phoenix", std: "MST" }, // no DST
  anchorage: { zone: "America/Anchorage", std: "AKST", dst: "AKDT" },
  juneau: { zone: "America/Anchorage", std: "AKST", dst: "AKDT" },
  fairbanks: { zone: "America/Anchorage", std: "AKST", dst: "AKDT" },
  honolulu: { zone: "Pacific/Honolulu", std: "HST" },
  // === Canada ===
  toronto: { zone: "America/Toronto", std: "EST", dst: "EDT" },
  montreal: { zone: "America/Toronto", std: "EST", dst: "EDT" },
  ottawa: { zone: "America/Toronto", std: "EST", dst: "EDT" },
  quebec: { zone: "America/Toronto", std: "EST", dst: "EDT" },
  vancouver: { zone: "America/Vancouver", std: "PST", dst: "PDT" },
  victoria: { zone: "America/Vancouver", std: "PST", dst: "PDT" },
  calgary: { zone: "America/Edmonton", std: "MST", dst: "MDT" },
  edmonton: { zone: "America/Edmonton", std: "MST", dst: "MDT" },
  winnipeg: { zone: "America/Winnipeg", std: "CST", dst: "CDT" },
  halifax: { zone: "America/Halifax", std: "AST", dst: "ADT" },
  "st johns": { zone: "America/St_Johns", std: "NST", dst: "NDT" },
  regina: { zone: "America/Regina", std: "CST" }, // Saskatchewan — no DST
  saskatoon: { zone: "America/Regina", std: "CST" },
  // === Latin America / Caribbean ===
  "mexico city": { zone: "America/Mexico_City", std: "CST" }, // no DST since 2022
  mexico: { zone: "America/Mexico_City", std: "CST" },
  guadalajara: { zone: "America/Mexico_City", std: "CST" },
  monterrey: { zone: "America/Monterrey", std: "CST" },
  tijuana: { zone: "America/Tijuana", std: "PST", dst: "PDT" }, // US-aligned DST
  cancun: { zone: "America/Cancun", std: "EST" },
  "sao paulo": { zone: "America/Sao_Paulo", std: "BRT" }, // no DST since 2019
  brt: { zone: "America/Sao_Paulo", std: "BRT" },
  "rio de janeiro": { zone: "America/Sao_Paulo", std: "BRT" },
  rio: { zone: "America/Sao_Paulo", std: "BRT" },
  brasilia: { zone: "America/Sao_Paulo", std: "BRT" },
  "buenos aires": { zone: "America/Argentina/Buenos_Aires", std: "ART" },
  santiago: { zone: "America/Santiago", std: "CLT", dst: "CLST" },
  lima: { zone: "America/Lima", std: "PET" },
  bogota: { zone: "America/Bogota", std: "COT" },
  medellin: { zone: "America/Bogota", std: "COT" },
  caracas: { zone: "America/Caracas", std: "VET" },
  quito: { zone: "America/Guayaquil", std: "ECT" },
  "la paz": { zone: "America/La_Paz", std: "BOT" },
  montevideo: { zone: "America/Montevideo", std: "UYT" },
  asuncion: { zone: "America/Asuncion", std: "PYT", dst: "PYST" },
  havana: { zone: "America/Havana", std: "CST", dst: "CDT" },
  "panama city": { zone: "America/Panama", std: "EST" },
  guatemala: { zone: "America/Guatemala", std: "CST" },
  "san salvador": { zone: "America/El_Salvador", std: "CST" },
  tegucigalpa: { zone: "America/Tegucigalpa", std: "CST" },
  "san juan": { zone: "America/Puerto_Rico", std: "AST" }, // Atlantic Standard −4
  "santo domingo": { zone: "America/Santo_Domingo", std: "AST" },
  kingston: { zone: "America/Jamaica", std: "EST" },
  jamaica: { zone: "America/Jamaica", std: "EST" },
  cuba: { zone: "America/Havana", std: "CST", dst: "CDT" },
  // === UK / Ireland ===
  london: { zone: "Europe/London", std: "GMT", dst: "BST" },
  uk: { zone: "Europe/London", std: "GMT", dst: "BST" },
  britain: { zone: "Europe/London", std: "GMT", dst: "BST" },
  british: { zone: "Europe/London", std: "GMT", dst: "BST" },
  "united kingdom": { zone: "Europe/London", std: "GMT", dst: "BST" },
  dublin: { zone: "Europe/Dublin", std: "GMT", dst: "IST" }, // Irish Standard Time in summer
  ireland: { zone: "Europe/Dublin", std: "GMT", dst: "IST" },
  reykjavik: { zone: "Atlantic/Reykjavik", std: "GMT" },
  iceland: { zone: "Atlantic/Reykjavik", std: "GMT" },
  // === Europe ===
  paris: { zone: "Europe/Paris", std: "CET", dst: "CEST" },
  france: { zone: "Europe/Paris", std: "CET", dst: "CEST" },
  berlin: { zone: "Europe/Berlin", std: "CET", dst: "CEST" },
  germany: { zone: "Europe/Berlin", std: "CET", dst: "CEST" },
  munich: { zone: "Europe/Berlin", std: "CET", dst: "CEST" },
  frankfurt: { zone: "Europe/Berlin", std: "CET", dst: "CEST" },
  hamburg: { zone: "Europe/Berlin", std: "CET", dst: "CEST" },
  madrid: { zone: "Europe/Madrid", std: "CET", dst: "CEST" },
  spain: { zone: "Europe/Madrid", std: "CET", dst: "CEST" },
  barcelona: { zone: "Europe/Madrid", std: "CET", dst: "CEST" },
  rome: { zone: "Europe/Rome", std: "CET", dst: "CEST" },
  italy: { zone: "Europe/Rome", std: "CET", dst: "CEST" },
  milan: { zone: "Europe/Rome", std: "CET", dst: "CEST" },
  naples: { zone: "Europe/Rome", std: "CET", dst: "CEST" },
  venice: { zone: "Europe/Rome", std: "CET", dst: "CEST" },
  amsterdam: { zone: "Europe/Amsterdam", std: "CET", dst: "CEST" },
  netherlands: { zone: "Europe/Amsterdam", std: "CET", dst: "CEST" },
  zurich: { zone: "Europe/Zurich", std: "CET", dst: "CEST" },
  switzerland: { zone: "Europe/Zurich", std: "CET", dst: "CEST" },
  geneva: { zone: "Europe/Zurich", std: "CET", dst: "CEST" },
  vienna: { zone: "Europe/Vienna", std: "CET", dst: "CEST" },
  austria: { zone: "Europe/Vienna", std: "CET", dst: "CEST" },
  brussels: { zone: "Europe/Brussels", std: "CET", dst: "CEST" },
  belgium: { zone: "Europe/Brussels", std: "CET", dst: "CEST" },
  copenhagen: { zone: "Europe/Copenhagen", std: "CET", dst: "CEST" },
  denmark: { zone: "Europe/Copenhagen", std: "CET", dst: "CEST" },
  oslo: { zone: "Europe/Oslo", std: "CET", dst: "CEST" },
  norway: { zone: "Europe/Oslo", std: "CET", dst: "CEST" },
  stockholm: { zone: "Europe/Stockholm", std: "CET", dst: "CEST" },
  sweden: { zone: "Europe/Stockholm", std: "CET", dst: "CEST" },
  warsaw: { zone: "Europe/Warsaw", std: "CET", dst: "CEST" },
  poland: { zone: "Europe/Warsaw", std: "CET", dst: "CEST" },
  krakow: { zone: "Europe/Warsaw", std: "CET", dst: "CEST" },
  prague: { zone: "Europe/Prague", std: "CET", dst: "CEST" },
  czech: { zone: "Europe/Prague", std: "CET", dst: "CEST" },
  budapest: { zone: "Europe/Budapest", std: "CET", dst: "CEST" },
  hungary: { zone: "Europe/Budapest", std: "CET", dst: "CEST" },
  lisbon: { zone: "Europe/Lisbon", std: "WET", dst: "WEST" },
  portugal: { zone: "Europe/Lisbon", std: "WET", dst: "WEST" },
  helsinki: { zone: "Europe/Helsinki", std: "EET", dst: "EEST" },
  finland: { zone: "Europe/Helsinki", std: "EET", dst: "EEST" },
  bucharest: { zone: "Europe/Bucharest", std: "EET", dst: "EEST" },
  romania: { zone: "Europe/Bucharest", std: "EET", dst: "EEST" },
  sofia: { zone: "Europe/Sofia", std: "EET", dst: "EEST" },
  bulgaria: { zone: "Europe/Sofia", std: "EET", dst: "EEST" },
  athens: { zone: "Europe/Athens", std: "EET", dst: "EEST" },
  greece: { zone: "Europe/Athens", std: "EET", dst: "EEST" },
  belgrade: { zone: "Europe/Belgrade", std: "CET", dst: "CEST" },
  serbia: { zone: "Europe/Belgrade", std: "CET", dst: "CEST" },
  zagreb: { zone: "Europe/Zagreb", std: "CET", dst: "CEST" },
  croatia: { zone: "Europe/Zagreb", std: "CET", dst: "CEST" },
  kyiv: { zone: "Europe/Kyiv", std: "EET", dst: "EEST" },
  kiev: { zone: "Europe/Kyiv", std: "EET", dst: "EEST" },
  ukraine: { zone: "Europe/Kyiv", std: "EET", dst: "EEST" },
  minsk: { zone: "Europe/Minsk", std: "MSK" }, // UTC+3 year-round
  riga: { zone: "Europe/Riga", std: "EET", dst: "EEST" },
  latvia: { zone: "Europe/Riga", std: "EET", dst: "EEST" },
  vilnius: { zone: "Europe/Vilnius", std: "EET", dst: "EEST" },
  lithuania: { zone: "Europe/Vilnius", std: "EET", dst: "EEST" },
  tallinn: { zone: "Europe/Tallinn", std: "EET", dst: "EEST" },
  estonia: { zone: "Europe/Tallinn", std: "EET", dst: "EEST" },
  moscow: { zone: "Europe/Moscow", std: "MSK" },
  russia: { zone: "Europe/Moscow", std: "MSK" }, // default = Moscow
  "st petersburg": { zone: "Europe/Moscow", std: "MSK" },
  istanbul: { zone: "Europe/Istanbul", std: "TRT" }, // UTC+3 year-round
  turkey: { zone: "Europe/Istanbul", std: "TRT" },
  ankara: { zone: "Europe/Istanbul", std: "TRT" },
  // === Middle East ===
  israel: { zone: "Asia/Jerusalem", std: "IST", dst: "IDT" },
  jerusalem: { zone: "Asia/Jerusalem", std: "IST", dst: "IDT" },
  "tel aviv": { zone: "Asia/Jerusalem", std: "IST", dst: "IDT" },
  iran: { zone: "Asia/Tehran", std: "IRST", dst: "IRDT" }, // +3:30/+4:30
  tehran: { zone: "Asia/Tehran", std: "IRST", dst: "IRDT" },
  dubai: { zone: "Asia/Dubai", std: "GST" }, // Gulf Standard +4
  gulf: { zone: "Asia/Dubai", std: "GST" },
  "abu dhabi": { zone: "Asia/Dubai", std: "GST" },
  muscat: { zone: "Asia/Muscat", std: "+04" },
  riyadh: { zone: "Asia/Riyadh", std: "AST" }, // Arabia Standard +3
  saudi: { zone: "Asia/Riyadh", std: "AST" },
  "saudi arabia": { zone: "Asia/Riyadh", std: "AST" },
  jeddah: { zone: "Asia/Riyadh", std: "AST" },
  doha: { zone: "Asia/Qatar", std: "AST" },
  manama: { zone: "Asia/Bahrain", std: "AST" },
  "kuwait city": { zone: "Asia/Kuwait", std: "AST" },
  kuwait: { zone: "Asia/Kuwait", std: "AST" },
  baghdad: { zone: "Asia/Baghdad", std: "AST" },
  amman: { zone: "Asia/Amman", std: "EET", dst: "EEST" },
  beirut: { zone: "Asia/Beirut", std: "EET", dst: "EEST" },
  // === India ===
  india: { zone: "Asia/Kolkata", std: "IST" },
  kerala: { zone: "Asia/Kolkata", std: "IST" }, // +5:30, whole country single zone
  kochi: { zone: "Asia/Kolkata", std: "IST" },
  cochin: { zone: "Asia/Kolkata", std: "IST" },
  thiruvananthapuram: { zone: "Asia/Kolkata", std: "IST" },
  trivandrum: { zone: "Asia/Kolkata", std: "IST" },
  kozhikode: { zone: "Asia/Kolkata", std: "IST" },
  calicut: { zone: "Asia/Kolkata", std: "IST" },
  chennai: { zone: "Asia/Kolkata", std: "IST" },
  madras: { zone: "Asia/Kolkata", std: "IST" },
  kolkata: { zone: "Asia/Kolkata", std: "IST" },
  calcutta: { zone: "Asia/Kolkata", std: "IST" },
  hyderabad: { zone: "Asia/Kolkata", std: "IST" },
  pune: { zone: "Asia/Kolkata", std: "IST" },
  jaipur: { zone: "Asia/Kolkata", std: "IST" },
  ahmedabad: { zone: "Asia/Kolkata", std: "IST" },
  lucknow: { zone: "Asia/Kolkata", std: "IST" },
  kanpur: { zone: "Asia/Kolkata", std: "IST" },
  nagpur: { zone: "Asia/Kolkata", std: "IST" },
  indore: { zone: "Asia/Kolkata", std: "IST" },
  bhopal: { zone: "Asia/Kolkata", std: "IST" },
  surat: { zone: "Asia/Kolkata", std: "IST" },
  patna: { zone: "Asia/Kolkata", std: "IST" },
  ranchi: { zone: "Asia/Kolkata", std: "IST" },
  guwahati: { zone: "Asia/Kolkata", std: "IST" },
  chandigarh: { zone: "Asia/Kolkata", std: "IST" },
  amritsar: { zone: "Asia/Kolkata", std: "IST" },
  jodhpur: { zone: "Asia/Kolkata", std: "IST" },
  udaipur: { zone: "Asia/Kolkata", std: "IST" },
  goa: { zone: "Asia/Kolkata", std: "IST" },
  varanasi: { zone: "Asia/Kolkata", std: "IST" },
  agra: { zone: "Asia/Kolkata", std: "IST" },
  mysore: { zone: "Asia/Kolkata", std: "IST" },
  mangalore: { zone: "Asia/Kolkata", std: "IST" },
  coimbatore: { zone: "Asia/Kolkata", std: "IST" },
  vijayawada: { zone: "Asia/Kolkata", std: "IST" },
  visakhapatnam: { zone: "Asia/Kolkata", std: "IST" },
  "new delhi": { zone: "Asia/Kolkata", std: "IST" },
  delhi: { zone: "Asia/Kolkata", std: "IST" },
  mumbai: { zone: "Asia/Kolkata", std: "IST" },
  bangalore: { zone: "Asia/Kolkata", std: "IST" },
  bengaluru: { zone: "Asia/Kolkata", std: "IST" },
  // === Asia ===
  china: { zone: "Asia/Shanghai", std: "CST" }, // China Standard +8, no DST
  beijing: { zone: "Asia/Shanghai", std: "CST" },
  shanghai: { zone: "Asia/Shanghai", std: "CST" },
  "hong kong": { zone: "Asia/Hong_Kong", std: "HKT" },
  macau: { zone: "Asia/Macau", std: "CST" },
  taiwan: { zone: "Asia/Taipei", std: "CST" },
  taipei: { zone: "Asia/Taipei", std: "CST" },
  japan: { zone: "Asia/Tokyo", std: "JST" },
  tokyo: { zone: "Asia/Tokyo", std: "JST" },
  osaka: { zone: "Asia/Tokyo", std: "JST" },
  korea: { zone: "Asia/Seoul", std: "KST" },
  seoul: { zone: "Asia/Seoul", std: "KST" },
  singapore: { zone: "Asia/Singapore", std: "SGT" },
  thailand: { zone: "Asia/Bangkok", std: "ICT" },
  bangkok: { zone: "Asia/Bangkok", std: "ICT" },
  vietnam: { zone: "Asia/Ho_Chi_Minh", std: "ICT" },
  "ho chi minh city": { zone: "Asia/Ho_Chi_Minh", std: "ICT" },
  saigon: { zone: "Asia/Ho_Chi_Minh", std: "ICT" },
  hanoi: { zone: "Asia/Ho_Chi_Minh", std: "ICT" },
  "phnom penh": { zone: "Asia/Phnom_Penh", std: "ICT" },
  cambodia: { zone: "Asia/Phnom_Penh", std: "ICT" },
  indonesia: { zone: "Asia/Jakarta", std: "WIB" }, // default = Java (UTC+7)
  jakarta: { zone: "Asia/Jakarta", std: "WIB" },
  malaysia: { zone: "Asia/Kuala_Lumpur", std: "MYT" },
  "kuala lumpur": { zone: "Asia/Kuala_Lumpur", std: "MYT" },
  philippines: { zone: "Asia/Manila", std: "PHT" },
  manila: { zone: "Asia/Manila", std: "PHT" },
  mongolia: { zone: "Asia/Ulaanbaatar", std: "ULAT" },
  ulaanbaatar: { zone: "Asia/Ulaanbaatar", std: "ULAT" },
  pakistan: { zone: "Asia/Karachi", std: "PKT" },
  karachi: { zone: "Asia/Karachi", std: "PKT" },
  lahore: { zone: "Asia/Karachi", std: "PKT" },
  islamabad: { zone: "Asia/Karachi", std: "PKT" },
  bangladesh: { zone: "Asia/Dhaka", std: "BST" }, // Bangladesh Standard +6
  dhaka: { zone: "Asia/Dhaka", std: "BST" },
  "sri lanka": { zone: "Asia/Colombo", std: "IST" },
  colombo: { zone: "Asia/Colombo", std: "IST" },
  nepal: { zone: "Asia/Kathmandu", std: "NPT" }, // +5:45
  kathmandu: { zone: "Asia/Kathmandu", std: "NPT" },
  afghanistan: { zone: "Asia/Kabul", std: "AFT" }, // +4:30
  myanmar: { zone: "Asia/Yangon", std: "MMT" }, // +6:30
  yangon: { zone: "Asia/Yangon", std: "MMT" },
  tashkent: { zone: "Asia/Tashkent", std: "UZT" }, // +5
  // === Africa ===
  egypt: { zone: "Africa/Cairo", std: "EET", dst: "EEST" },
  cairo: { zone: "Africa/Cairo", std: "EET", dst: "EEST" },
  nigeria: { zone: "Africa/Lagos", std: "WAT" },
  lagos: { zone: "Africa/Lagos", std: "WAT" },
  kenya: { zone: "Africa/Nairobi", std: "EAT" },
  nairobi: { zone: "Africa/Nairobi", std: "EAT" },
  ethiopia: { zone: "Africa/Addis_Ababa", std: "EAT" },
  "addis ababa": { zone: "Africa/Addis_Ababa", std: "EAT" },
  "dar es salaam": { zone: "Africa/Dar_es_Salaam", std: "EAT" },
  kampala: { zone: "Africa/Kampala", std: "EAT" },
  uganda: { zone: "Africa/Kampala", std: "EAT" },
  accra: { zone: "Africa/Accra", std: "GMT" },
  ghana: { zone: "Africa/Accra", std: "GMT" },
  "south africa": { zone: "Africa/Johannesburg", std: "SAST" },
  johannesburg: { zone: "Africa/Johannesburg", std: "SAST" },
  "cape town": { zone: "Africa/Johannesburg", std: "SAST" },
  khartoum: { zone: "Africa/Khartoum", std: "CAT" },
  harare: { zone: "Africa/Harare", std: "CAT" },
  lusaka: { zone: "Africa/Lusaka", std: "CAT" },
  maputo: { zone: "Africa/Maputo", std: "CAT" },
  gaborone: { zone: "Africa/Gaborone", std: "CAT" },
  luanda: { zone: "Africa/Luanda", std: "WAT" },
  kinshasa: { zone: "Africa/Kinshasa", std: "WAT" },
  dakar: { zone: "Africa/Dakar", std: "GMT" },
  abidjan: { zone: "Africa/Abidjan", std: "GMT" },
  algiers: { zone: "Africa/Algiers", std: "CET" }, // no DST
  tunis: { zone: "Africa/Tunis", std: "CET" },
  // === Oceania ===
  australia: { zone: "Australia/Sydney", std: "AEST", dst: "AEDT" }, // default = East Coast
  sydney: { zone: "Australia/Sydney", std: "AEST", dst: "AEDT" },
  melbourne: { zone: "Australia/Melbourne", std: "AEST", dst: "AEDT" },
  brisbane: { zone: "Australia/Brisbane", std: "AEST" }, // Queensland — no DST
  perth: { zone: "Australia/Perth", std: "AWST" },
  adelaide: { zone: "Australia/Adelaide", std: "ACST", dst: "ACDT" },
  canberra: { zone: "Australia/Sydney", std: "AEST", dst: "AEDT" },
  hobart: { zone: "Australia/Hobart", std: "AEST", dst: "AEDT" },
  darwin: { zone: "Australia/Darwin", std: "ACST" }, // no DST
  "gold coast": { zone: "Australia/Brisbane", std: "AEST" },
  newcastle: { zone: "Australia/Sydney", std: "AEST", dst: "AEDT" },
  "new zealand": { zone: "Pacific/Auckland", std: "NZST", dst: "NZDT" },
  auckland: { zone: "Pacific/Auckland", std: "NZST", dst: "NZDT" },
  wellington: { zone: "Pacific/Auckland", std: "NZST", dst: "NZDT" },
  christchurch: { zone: "Pacific/Auckland", std: "NZST", dst: "NZDT" },
  fiji: { zone: "Pacific/Fiji", std: "FJT" }, // no DST since 2021
  suva: { zone: "Pacific/Fiji", std: "FJT" },
  "port moresby": { zone: "Pacific/Port_Moresby", std: "PGT" },
}

/** The machine's local timezone, as a zone token ("9pm utc to local"). */
const LOCAL: ZoneInfo = { zone: "", std: "" }

interface Parsed {
  /** Absolute instant. */
  date: Date
  /** null or LOCAL = the machine's local timezone. */
  from: ZoneInfo | null
  to: ZoneInfo
}

/**
 * Whether `token` names an IANA time zone. The zone list is built once and
 * read as a set: constructing a formatter with an unknown zone throws
 * RangeError, and the time-shape parse over-captures ordinary words (`1 cup to
 * ml` reads `cup` as a source zone), so probing by exception reports a
 * non-zone word — the common case — as a failure on every keystroke.
 */
let ianaZones: Set<string> | null | undefined
function isKnownZone(token: string): boolean {
  if (ianaZones === undefined) {
    try {
      ianaZones = new Set(Intl.supportedValuesOf("timeZone").map((z) => z.toLowerCase()))
    } catch (e) {
      ignore("time zone list", e)
      ianaZones = null
    }
  }
  if (ianaZones) return ianaZones.has(token)
  // No zone list on this runtime: the formatter construct is the only check
  // left, and a non-zone token is its expected negative answer, not an
  // incident to report.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: token })
    return true
  } catch (_) {
    return false
  }
}

/** Resolve a zone token: table lookup → fixed UTC offset → IANA pass-through
 * (validated by constructing a formatter — Intl throws RangeError on unknown
 * zones). Pass-through zones that match a table entry's IANA name reuse its
 * abbreviations. `local` is the machine's timezone. */
function resolveZoneInfo(token: string): ZoneInfo | null {
  const t = token
    .trim()
    .toLowerCase()
    .replace(/\btime\b/g, "")
    .trim()
  if (!t) return null
  if (t === "local") return LOCAL
  const known = ZONES[t]
  if (known) return known
  // fixed offsets: utc+5:30, gmt-8, +2, utc+2
  const om = t.match(/^(?:utc|gmt)?([+-])(\d{1,2})(?::?(\d{2}))?$/)
  if (om) {
    const h = parseInt(om[2], 10)
    const mi = om[3] ? parseInt(om[3], 10) : 0
    if (h > 23 || mi > 59) return null
    const sign = om[1] === "-" ? -1 : 1
    const prefix = t.startsWith("gmt") ? "GMT" : "UTC"
    const mins = om[3] ? `:${om[3].padStart(2, "0")}` : ""
    return {
      zone: "",
      std: `${prefix}${om[1]}${h}${mins}`,
      offset: sign * (h * 3600 + mi * 60) * 1000,
    }
  }
  if (!isKnownZone(t)) return null
  for (const info of Object.values(ZONES)) {
    if (info.zone.toLowerCase() === t) return info
  }
  return { zone: t, std: "" }
}

/** Clock parts (y/mo/d/h/mi) of an instant as read in `zone`. */
function partsInZone(
  zone: string,
  ms: number,
): { y: number; mo: number; d: number; h: number; mi: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  })
  const p: Record<string, string> = {}
  for (const part of dtf.formatToParts(new Date(ms))) p[part.type] = part.value
  return {
    y: Number(p.year),
    mo: Number(p.month) - 1,
    d: Number(p.day),
    h: Number(p.hour),
    mi: Number(p.minute),
  }
}

/** Wall-clock (y,mo,d,h,mi) in `zone` → absolute instant, independent of the
 * machine's local timezone. Probe loop converges in ≤2 iterations (offsets
 * only change at DST transitions). */
function zonedWallToUtc(
  zone: string,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
): Date {
  const target = Date.UTC(y, mo, d, h, mi) // target wall time, as-if-UTC
  let utc = target
  for (let i = 0; i < 3; i++) {
    const p = partsInZone(zone, utc)
    const asUtc = Date.UTC(p.y, p.mo, p.d, p.h, p.mi)
    if (asUtc === target) break // wall time matches → done
    utc += target - asUtc // shift by the wall-clock error
  }
  return new Date(utc)
}

// Standard-offset cache: the zone's MINIMUM offset over the year is its
// standard offset in BOTH hemispheres (DST always makes the offset larger).
const stdOffsetCache = new Map<string, number>()
function standardOffsetMs(zone: string): number {
  const cached = stdOffsetCache.get(zone)
  if (cached !== undefined) return cached
  const year = new Date().getFullYear()
  let min = Infinity
  for (let mo = 0; mo < 12; mo++) {
    const d = Date.UTC(year, mo, 1, 12)
    const p = partsInZone(zone, d)
    const off = Date.UTC(p.y, p.mo, p.d, p.h, p.mi) - d
    if (off < min) min = off
  }
  stdOffsetCache.set(zone, min)
  return min
}

function offsetMs(zone: string, ms: number): number {
  const p = partsInZone(zone, ms)
  return Date.UTC(p.y, p.mo, p.d, p.h, p.mi) - ms
}

/** DST-aware abbreviation for a mapped zone. */
function zoneAbbrev(info: ZoneInfo, date: Date): string {
  if (info.dst && offsetMs(info.zone, date.getTime()) > standardOffsetMs(info.zone)) return info.dst
  return info.std
}

/** Abbreviation for IANA pass-through zones: Intl's short name, but only
 * when it's a real name (CLDR renders "GMT+2" offset forms for many zones —
 * those come back empty). */
function intlShortName(zone: string, date: Date): string {
  try {
    const s = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(date)
    const m = s.match(/([A-Za-z\u00C0-\u024F]{1,6})(?:\s+[A-Za-z\u00C0-\u024F]{1,6})?$/)
    return m ? m[0] : ""
  } catch {
    return ""
  }
}

function abbrevFor(info: ZoneInfo, date: Date): string {
  if (info.offset !== undefined) return info.std // fixed offset — no DST
  return info.std ? zoneAbbrev(info, date) : intlShortName(info.zone, date)
}

/** Format an instant in a zone (null = local). withDate adds the calendar
 * date (titles are time-only; descriptions carry the day). */
function fmt(info: ZoneInfo | null, date: Date, withDate: boolean): string {
  const opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit", hour12: true }
  if (withDate) {
    opts.weekday = "short"
    opts.month = "short"
    opts.day = "numeric"
  }
  if (!info || info === LOCAL) {
    // local zone — Intl's short name is the machine's real abbreviation
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZoneName: "short" }).format(date)
  }
  if (info.offset !== undefined) {
    // fixed offset — shift the instant and format as UTC (offset zones have
    // no DST, so the label is exact)
    const shifted = new Date(date.getTime() + info.offset)
    const s = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(shifted)
    return `${s} ${info.std}`
  }
  const s = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: info.zone }).format(date)
  const abbr = abbrevFor(info, date)
  return abbr ? `${s} ${abbr}` : s
}

/** "Fri, Aug 7" for an instant in a zone (drops the time part). */
function dayKey(info: ZoneInfo | null, date: Date): string {
  return fmt(info, date, true).split(",").slice(0, -1).join(",")
}

/** Parse "<time> <from> sep <to>" or "now [<from>] sep <to>". */
function parseTimeQuery(q: string): Parsed | null {
  const s = q.trim()

  // now [<from>] sep <to> — from optional, defaults to the local timezone.
  let m = s.match(/^now(?:\s+(.+?))?\s+(?:to|in|→|->)\s+(.+)$/i)
  if (m) {
    const to = resolveZoneInfo(m[2] ?? "")
    if (!to) return null
    const from = m[1] ? resolveZoneInfo(m[1]) : null
    if (m[1] && !from) return null
    return { date: new Date(), from, to }
  }

  // <time> <from> sep <to>
  m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s+(.+?)\s+(?:to|in|→|->)\s+(.+)$/i)
  if (!m) return null
  const hour = parseInt(m[1] ?? "0", 10)
  const min = m[2] ? parseInt(m[2], 10) : 0
  const mer = m[3]?.toLowerCase().replace(/\./g, "")
  if (min > 59) return null
  let h = hour
  if (mer) {
    if (hour < 1 || hour > 12) return null
    if (mer.startsWith("pm") && hour !== 12) h = hour + 12
    if (mer.startsWith("am") && hour === 12) h = 0
  } else if (hour > 23) {
    return null
  }
  const from = resolveZoneInfo(m[4] ?? "")
  if (!from) return null
  const to = resolveZoneInfo(m[5] ?? "")
  if (!to) return null
  const now = new Date()
  const y = now.getFullYear()
  const mo = now.getMonth()
  const d = now.getDate()
  let date: Date
  if (from === LOCAL) {
    date = new Date(y, mo, d, h, min) // local wall clock
  } else if (from.offset === undefined) {
    date = zonedWallToUtc(from.zone, y, mo, d, h, min)
  } else {
    date = new Date(Date.UTC(y, mo, d, h, min) - from.offset) // wall − offset
  }
  return { date, from, to }
}

/** Convert a time-zone query to result rows (0 or 1). */
export function timeConvert(q: string): Result[] {
  const p = parseTimeQuery(q)
  if (!p) return []
  const title = `${fmt(p.from, p.date, false)} → ${fmt(p.to, p.date, false)}`
  const fromDay = dayKey(p.from, p.date)
  const toDay = dayKey(p.to, p.date)
  const description = fromDay === toDay ? toDay : `${fromDay} → ${toDay}`
  return [
    {
      title,
      description,
      icon: "x-office-calendar",
      category: "time",
      run: () => {
        copy(title)
        return true
      },
    },
  ]
}
