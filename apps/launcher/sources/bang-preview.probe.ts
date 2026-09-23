/**
 * bang-preview.probe — the enriched bang previews, checked against the live
 * response bodies of the five sources.
 *
 * The DEFAULT pass needs no network: every fixture below is the body the named
 * endpoint actually returned (trimmed to the fields the parsers read, the
 * strings verbatim), and each one is shaped through the real plan
 * (`previewPlan(…).items(…)`) — the request URLs, the title guard, the wikitext
 * and HTML stripping, the row order and the row titles.
 *
 * `LIVE=1` adds the endpoint pass: each enriched bang runs through
 * `previewFor` — the real Soup session, cache and row mapping — and prints the
 * rows it produced, so a source that has moved on shows up as rows rather than
 * as a silent degrade.
 *
 * Needs the TINSHELL runtime (gi), so it runs bundled rather than under plain node:
 *   ags bundle --gtk 4 apps/launcher/sources/bang-preview.probe.ts /tmp/bang-preview-probe.sh
 *   bash /tmp/bang-preview-probe.sh            # fixtures only
 *   LIVE=1 bash /tmp/bang-preview-probe.sh     # + the five live endpoints
 */
import GLib from "gi://GLib"
import {
  classifyStatus,
  DEFINE_WORD_CAP,
  DEFINITIVE_NEGATIVE_TTL_MS,
  type EnrichKind,
  greedyDefineItems,
  type InstalledIndex,
  type PreviewItem,
  previewArgs,
  previewCacheKey,
  previewPlan,
  previewTimeoutS,
  previewTtlFor,
  previewTtlMs,
  previewWordCount,
} from "./bang-preview"
import { previewFor } from "./bang-preview-fetch"

// ── fixtures: the measured bodies, verbatim ───────────────

/** `GET https://wiki.archlinux.org/api.php?action=query&format=json&list=search&srsearch=greetd&srlimit=1` */
const AW_SEARCH =
  '{"batchcomplete":"","query":{"searchinfo":{"totalhits":2},"search":[{"ns":0,"title":"Greetd","pageid":30169,"size":16909,"wordcount":2469}]}}'

/** `GET …archwiki…prop=revisions&rvprop=content&rvslots=main&rvsection=0&titles=Greetd&redirects=1` */
const AW_LEAD =
  '{"batchcomplete":"","query":{"pages":{"30169":{"pageid":30169,"ns":0,"title":"Greetd","revisions":[{"slots":{"main":{"contentmodel":"wikitext","contentformat":"text/x-wiki","*":"{{Lowercase title}}\\n[[Category:Display managers]]\\n[[de:Greetd]]\\n[[ja:Greetd]]\\n[[zh-hans:Greetd]]\\n{{Related articles start}}\\n{{Related|Display manager}}\\n{{Related|Wayland}}\\n{{Related|Sway}}\\n{{Related articles end}}\\n\\n[https://git.sr.ht/~kennylevinsen/greetd greetd] is a minimal, agnostic and flexible [[login manager]] daemon which does not make assumptions about what the user wants to launch, should it be console-based or graphical. Any script or program which can be started from the console may be launched by greetd, which makes it particularly suitable for [[Wayland#Compositors|Wayland compositors]].  It can also launch a [[#Greeters|greeter]] to start user sessions, like any other display manager."}}}]}}}}'

/** `GET https://en.wiktionary.org/api/rest_v1/page/definition/archaic` */
const DEF =
  '{"en":[{"partOfSpeech":"Noun","language":"English","definitions":[{"definition":"<span class=\\"usage-label-sense\\" about=\\"#mwt21\\" typeof=\\"mw:Transclusion\\"></span> (A member of) an archaic variety of <i>Homo sapiens</i>."}]},{"partOfSpeech":"Adjective","language":"English","definitions":[{"definition":"Of or characterized by <a rel=\\"mw:WikiLink\\" href=\\"/wiki/antiquity\\" title=\\"antiquity\\">antiquity</a>; <a rel=\\"mw:WikiLink\\" href=\\"/wiki/old-fashioned\\" title=\\"old-fashioned\\">old-fashioned</a>, <a rel=\\"mw:WikiLink\\" href=\\"/wiki/quaint\\" title=\\"quaint\\">quaint</a>, <a rel=\\"mw:WikiLink\\" href=\\"/wiki/antiquated\\" title=\\"antiquated\\">antiquated</a>."}]}]}'

/** `GET https://api.datamuse.com/words?rel_syn=archaic&max=8` */
const SYN =
  '[{"word":"primitive","score":30049},{"word":"antiquated","score":30030},{"word":"old","score":24051},{"word":"antediluvian","score":23037},{"word":"early","score":8041}]'

/** `GET https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=hyprland` */
const DDG =
  '{"Heading": "Hyprland", "AbstractText": "Hyprland is a dynamic tiling window manager and compositing manager for Wayland written in C++. Hyprland officially supports Arch Linux and NixOS, with unofficial support for other Linux distributions like Fedora and Gentoo. In 2026, Hyprland received an exclusive three-years sponsorship from the Omacom foundation.", "AbstractURL": "https://en.wikipedia.org/wiki/Hyprland", "Answer": "", "Definition": "", "RelatedTopics": [{"Text": "Wayland compositors", "FirstURL": "https://duckduckgo.com/c/Wayland_compositors"}, {"Text": "Free desktop environments", "FirstURL": "https://duckduckgo.com/c/Free_desktop_environments"}]}'

/** The same API for a query it does not answer (measured: `greetd`). */
const DDG_EMPTY =
  '{"Heading":"","AbstractText":"","AbstractURL":"","Answer":"","Definition":"","RelatedTopics":[]}'

/**
 * `GET https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=de&dt=t&q=hello%20world`
 * — the shape the endpoint is documented to return. NO LIVE FIXTURE: every
 * measurement attempt against this endpoint answered HTTP 429 with its HTML
 * abuse page, so the parser is written defensively against that uncertainty.
 */
const GTX = '[[["Hallo Welt","hello world",null,null,3,null,null,[[]]]],null,"en"]'

/** `GET https://www.youtube.com/results?search_query=greetd%20arch%20linux` — a bounded
 *  slice of the real 1 378 374 B page, starting at its first `videoRenderer` entry. */
const YT_PAGE =
  'var ytInitialData = {"contents":{"videoRenderer":{"videoId":"K3a0BG_xnmg","thumbnail":{"thumbnails":[{"url":"https://i.ytimg.com/vi/K3a0BG_xnmg/hq720.jpg?sqp=-oaymwEjCOgCEMoBSFryq4qpAxUIARUAAAAAGAElAADIQj0AgKJDeAE=\\u0026rs=AOn4CLAqWNL0Aia8AlueG1DFPImwKNap4Q","width":360,"height":202},{"url":"https://i.ytimg.com/vi/K3a0BG_xnmg/hq720.jpg?sqp=-oaymwEXCNAFEJQDSFryq4qpAwkIARUAAIhCGAE=\\u0026rs=AOn4CLAjF0E8zDhBh_bvAovtQlD52RkFBw","width":720,"height":404}]},"title":{"runs":[{"text":"How To Build Lock Screen using Quickshell and Use It With greetd"}],"accessibility":{"accessibilityData":{"label":"How To Build Lock Screen using Quickshell and Use It With greetd 22 minutes"}}},"longBylineText":{"runs":[{"text":"TheLinuxGuy","navigationEndpoint":{"clickTrackingParams":"CPMCENwwGAAiEwjfwYn6p4OXAxV-Ci4DHUQzJq7KAQQ_9hgv","commandMetadata":{"webCommandMetadata":{"url":"/@TheLinuxGuy-btw","webPageType":"WEB_PAGE_TYPE_CHANNEL","rootVe":3611,"apiUrl":"/youtubei/v1/browse"}},"browseEndpoint":{"browseId":"UCbu1E9g4K2FJLBw5ucu9emw","canonicalBaseUrl":"/@TheLinuxGuy-btw"}}}]},"publishedTimeText":{"simpleText":"2 days ago"},"lengthText":{"accessibility":{"accessibilityData":{"label":"22 minutes, 31 seconds"}},"simpleText":"22:31"},"viewCountText":{"simpleText":"437 views"},"navigationEndpoint":{"clickTrackingParams":"CPMCENwwGAAiEwjfwYn6p4OXAxV-Ci4DHUQzJq4yBnNlYXJjaFIRZ3JlZXRkIGFyY2ggbGludXiaAQMQ9CTKAQQ_9hgv","commandMetadata":{"webCommandMetadata":{"url":"/watch?v=K3a0BG_xnmg\\u0026pp=ygURZ3JlZXRkIGFyY2ggbGludXg%3D","webPageType":"WEB_PAGE_TYPE_WATCH","rootVe":3832}},"watchEndpoint":{"videoId":"K3a0BG_xnmg","params":"qgMRZ3JlZXRkIGFyY2ggbGludXi6AwsI3Mbc-Pb28qaKAboDCwiH_tbSruPnjM4BugMKCNLmh4C_7-L5fboDCwij55ayhcrWtOQBugMKCM2jtpKH376zc7oDCwiJqMqSjaSxz9oBugMKCOyArurwyOzaC7oDCgjyiajNvdrs7Xa6AwsIzq-enZ_u_6ajAboDCgjUma3A26jnhSe6AwoI0rX91OeWsNRDugMLCP_dhsCXg6PCzwG6AwoIvsbnta2mk_5augMLCJaturnYwLiznAG6AwsI6J6BtpXihoywAboDCgj70rTh3-a4kny6AwsIn-mL65bAxNjxAboDCwiv4uCA1bq95usBugMLCLShj7vbrdr18gE%3D","playerParams":"ygURZ3JlZXRkIGFyY2ggbGludXg%3D","watchEndpointSupportedOnesieConfig":{"html5PlaybackOnesieConfig":{"commonConfig":{"url":"https://rr1---sn-nx5e6nle.googlevideo.com/initplayback?source=youtube\\u0026oeis=1\\u0026c=WEB\\u0026oad=3200\\u0026ovd=3200\\u0026oaad=11000\\u0026oavd=11000\\u0026ocs=700\\u0026oewis=1\\u0026oputc=1\\u0026msp=1\\u0026odepv=1\\u0026id=2b76b4046ff19e68\\u0026ip=45.44.60.200\\u0026initcwndbps=3342750\\u0026mt=1790118306\\u0026oweuc="}}}}},"badges":[{"metadataBadgeRenderer":{"style":"BADGE_STYLE_TYPE_SIMPLE","label":"New","trackingParams":"CPMCENwwGAAiEwjfwYn6p4OXAxV-Ci4DHUQzJq4="}}],"ownerText":{"runs":[{"text":"TheLinuxGuy","navigationEndpoint":{"clickTrackingParams":"CPMCENwwGAAiEwjfwYn6p4OXAxV-Ci4DHUQzJq7KAQQ_9hgv","commandMetadata":{"webCommandMetadata":{"url":"/@TheLinuxGuy-btw","webPageType":"WEB_PAGE_TYPE_CHANNEL","rootVe":3611,"apiUrl":"/youtubei/v1/browse"}},"browseEndpoint":{"browseId":"UCbu1E9g4K2FJLBw5ucu9emw","canonicalBaseUrl":"/@TheLinuxGuy-btw"}}}]},"shortBylineText":{"runs":[{"text":"TheLinuxGuy","navigationEndpoint":{"clickTrackingParams":"CPMCENwwGAAiEwjfwYn6p4OXAxV-Ci4DHUQzJq7KAQQ_9hgv","commandMetadata":{"webCommandMetadata":{"url":"/@TheLinuxGuy-btw","webPageType":"WEB_PAGE_TYPE_CHANNEL","rootVe":3611,"apiUrl":"/youtubei/v1/browse"}},"browseEndpoint":{"browseId":"UCbu1E9g4K2FJLBw5ucu9emw","canonicalBaseUrl":"/@TheLinuxGuy-btw"}}}]},"trackingParams":"CPMCENwwGAAiEwjfwYn6p4OXAxV-Ci4DHUQzJq5A6LzG_8aArbsr","showActionMenu":false,"shortViewCountText":{"accessibility":{"acce}'

/** `GET https://en.wiktionary.org/api/rest_v1/page/definition/obsolete` */
const DEF_OBSOLETE =
  '{"en":[{"partOfSpeech":"Adjective","language":"English","definitions":[{"definition":"<span class=\\"usage-label-sense\\" about=\\"#mwt19\\" typeof=\\"mw:Transclusion\\"></span> No longer in use or no longer useful; now <a rel=\\"mw:WikiLink\\" href=\\"/wiki/disuse\\" title=\\"disuse\\">disused</a> or <a rel=\\"mw:WikiLink\\" href=\\"/wiki/neglect\\" title=\\"neglect\\">neglected</a>."}]}]}'

/** `GET https://api.datamuse.com/words?rel_syn=obsolete&max=8` (scores trimmed) */
const SYN_OBSOLETE =
  '[{"word":"outdated"},{"word":"superannuated"},{"word":"disused"},{"word":"noncurrent"},{"word":"out-of-date"}]'

/** `GET https://archlinux.org/packages/search/json/?q=greetd&limit=8` (first three results) */
const PAC =
  '{"version":2,"results":[{"pkgname":"cosmic-greeter","repo":"extra","arch":"x86_64","pkgver":"1.8.0","pkgrel":"1","pkgdesc":"COSMIC greeter for greetd","maintainers":["alucryd","ptr1337"]},{"pkgname":"greetd","repo":"extra","arch":"x86_64","pkgver":"0.10.3","pkgrel":"2","pkgdesc":"Generic greeter daemon","maintainers":["alerque"]},{"pkgname":"greetd-agreety","repo":"extra","arch":"x86_64","pkgver":"0.10.3","pkgrel":"2","pkgdesc":"Generic greeter daemon","maintainers":["alerque"]}]}'

/** `GET https://aur.archlinux.org/rpc/v5/info?arg[]=yay` */
const AUR_YAY =
  '{"resultcount":1,"version":5,"results":[{"Name":"yay","Description":"Yet another yogurt. Pacman wrapper and AUR helper written in go.","Version":"13.0.1-1","NumVotes":2653,"Popularity":28.983324,"OutOfDate":null,"Maintainer":"jguer","LastModified":1781905288}]}'

/** `GET https://aur.archlinux.org/rpc/v5/info?arg[]=greetd` — the package moved to `extra` */
const AUR_NONE = '{"resultcount":0,"results":[],"type":"multiinfo","version":5}'

/** `GET …en.wikipedia.org…generator=search&gsrsearch=hyprland…&gsrlimit=3` */
const WIKI_HYPRLAND =
  '{"batchcomplete":"","query":{"pages":{"73518761":{"pageid":73518761,"ns":0,"title":"Hyprland","index":1,"extract":"Hyprland is a dynamic tiling window manager and compositing manager for Wayland written in C++. Hyprland officially supports Arch Linux and NixOS, with unofficial support for other Linux distributions like Fedora and Gentoo."}}}}'

/** The same call for `greetd`: the ranked hit is the page `Phosh`. */
const WIKI_GREETD =
  '{"batchcomplete":"","query":{"pages":{"60291082":{"pageid":60291082,"ns":0,"title":"Phosh","index":1,"extract":"Phosh (portmanteau of phone and shell) is a graphical user interface designed for mobile and touch-based devices initially developed by Purism. The project is maintained and developed by a diverse community, and is the default shell used on several mobile Linux operating systems including PureOS, Mobian and Fedora Phosh."}}}}'

/** The same call for `Arthropods`: three hits, the first carrying the headword's
 *  pronunciation gloss and a real parenthetical further in. */
const WIKI_ARTHROPODS =
  '{"batchcomplete":"","query":{"pages":{"19827221":{"pageid":19827221,"ns":0,"title":"Arthropod","index":1,"extract":"Arthropods ( AR-thrə-pod) are invertebrates in the phylum Arthropoda. They possess an exoskeleton with a cuticle made of chitin, often mineralised with calcium carbonate, a body with differentiated (metameric) segments, and paired jointed appendages."},"19730812":{"pageid":19730812,"ns":0,"title":"Arthropod eye","index":2,"extract":"Apposition eyes are the most common form of eye, and are presumably the ancestral form of compound eye."},"61590362":{"pageid":61590362,"ns":0,"title":"Spiracle (arthropods)","index":3,"extract":"A spiracle or stigma is the opening in the exoskeletons of insects, myriapods, velvet worms and many arachnids to allow air to enter the trachea. Insect respiratory system differs from vertebrates\'."}}}}'

/** `kernel linux` — the exact page does not contain the query's text in order. */
const WIKI_KERNEL_REORDER =
  '{"batchcomplete":"","query":{"pages":{"1":{"pageid":1,"ns":0,"title":"Linux kernel","index":1,"extract":"The Linux kernel is a free and open-source Unix-like kernel that is used in many computer systems worldwide."},"2":{"pageid":2,"ns":0,"title":"Linux kernel version history","index":2,"extract":"This article documents the broad, wide version history of the Linux kernel, a free, open-source kernel."},"3":{"pageid":3,"ns":0,"title":"Linux","index":3,"extract":"Linux is a family of free and open-source software Unix-like operating systems based on the Linux kernel."}}}}'

/** `rust ownership` — the page the query names carries a disambiguating
 *  parenthetical. */
const WIKI_RUST =
  '{"batchcomplete":"","query":{"pages":{"1":{"pageid":1,"ns":0,"title":"Rust (programming language)","index":1,"extract":"Rust is a general-purpose programming language that emphasizes performance, type safety, and concurrency."},"2":{"pageid":2,"ns":0,"title":"Rust compiler","index":2,"extract":"The Rust compiler, usually invoked as rustc, is the official compiler for the Rust programming language."}}}}'

/** `linux kernel scheduler` — the ranked hits are pages whose titles the query
 *  interrupts; the exact page was not returned at all. */
const WIKI_SCHEDULER =
  '{"batchcomplete":"","query":{"pages":{"1":{"pageid":1,"ns":0,"title":"Completely Fair Scheduler","index":1,"extract":"The Completely Fair Scheduler was a process scheduler merged into the Linux kernel in 2007."},"2":{"pageid":2,"ns":0,"title":"Network scheduler","index":2,"extract":"A network scheduler, also called packet scheduler, is a component of a network stack."},"3":{"pageid":3,"ns":0,"title":"Brain Fuck Scheduler","index":3,"extract":"The Brain Fuck Scheduler is a process scheduler designed for the Linux kernel."}}}}'

/** `the great wall of china` — a leading stopword the title does not carry. */
const WIKI_GREAT_WALL =
  '{"batchcomplete":"","query":{"pages":{"1":{"pageid":1,"ns":0,"title":"Great Wall of China","index":1,"extract":"The Great Wall of China is a series of fortifications in China built across the historical northern borders."},"2":{"pageid":2,"ns":0,"title":"History of the Great Wall of China","index":2,"extract":"The history of the Great Wall of China began when fortifications were built by various states."}}}}'

/** `mercury` — an ambiguous word whose top hit is the disambiguation page. */
const WIKI_MERCURY =
  '{"batchcomplete":"","query":{"pages":{"1":{"pageid":1,"ns":0,"title":"Mercury","index":1,"extract":"Mercury most commonly refers to:"},"2":{"pageid":2,"ns":0,"title":"Freddie Mercury","index":2,"extract":"Freddie Mercury was a British singer and songwriter."},"3":{"pageid":3,"ns":0,"title":"Mercury (planet)","index":3,"extract":"Mercury is the first planet from the Sun and the smallest in the Solar System."}}}}'

/** `python list comprehension` — a phrase naming a page among other hits. */
const WIKI_LIST_COMPREHENSION =
  '{"batchcomplete":"","query":{"pages":{"1":{"pageid":1,"ns":0,"title":"List comprehension","index":1,"extract":"A list comprehension is a syntactic construct available in some programming languages for creating a list."},"2":{"pageid":2,"ns":0,"title":"Python (programming language)","index":2,"extract":"Python is a high-level, general-purpose programming language."}}}}'

/** `arch linux` — an ordinary two-word document title. */
const WIKI_ARCH_LINUX =
  '{"batchcomplete":"","query":{"pages":{"1":{"pageid":1,"ns":0,"title":"Arch Linux","index":1,"extract":"Arch Linux is an open source, rolling release Linux distribution."},"2":{"pageid":2,"ns":0,"title":"List of Linux distributions","index":2,"extract":"This page provides general information about notable Linux distributions in the form of a category."},"3":{"pageid":3,"ns":0,"title":"Arch Linux ARM","index":3,"extract":"Arch Linux ARM is a port of Arch Linux for ARM processors."}}}}'

/** `linux kernel` with the top hit carrying NO extract: the hit is skipped, and
 *  the next one that names the query and has an extract stands in for it. */
const WIKI_EXTRACT_MISSING =
  '{"batchcomplete":"","query":{"pages":{"1":{"pageid":1,"ns":0,"title":"Linux kernel","index":1},"2":{"pageid":2,"ns":0,"title":"Linux kernel version history","index":2,"extract":"This article documents the broad, wide version history of the Linux kernel."}}}}'

/** The installed package versions on this machine (`/var/lib/pacman/local`). */
const INSTALLED: InstalledIndex = { greetd: "0.10.3-3", "greetd-agreety": "0.10.3-3" }

// ── checks ────────────────────────────────────────────────

const checks: [string, unknown, unknown][] = []
function check(name: string, actual: unknown, expected: unknown): void {
  checks.push([name, actual, expected])
}

/** The plan's rows for one source, or null when the argument names nothing. */
function items(
  kind: EnrichKind,
  arg: string,
  payloads: string[],
  installed: InstalledIndex = {},
): PreviewItem[] | null {
  const plan = previewPlan(kind, arg)
  if (!plan) throw new Error(`no plan for ${kind} ${JSON.stringify(arg)}`)
  return plan.items(payloads, installed)
}

const titles = (rows: PreviewItem[] | null) => (rows ?? []).map((r) => r.title).join(" | ")
/** The FIRST row's title — `titles` joins them, so indexing it yields a letter. */
const firstTitle = (rows: PreviewItem[] | null) => (rows ?? [])[0]?.title ?? ""
const description = (rows: PreviewItem[] | null, i: number) => (rows ?? [])[i]?.description ?? ""
const url = (rows: PreviewItem[] | null, i: number) => (rows ?? [])[i]?.url ?? ""

// ── the request each source makes ──
const planOf = (kind: EnrichKind, arg: string) => previewPlan(kind, arg)
check(
  "wikipedia asks for a search + intro extract",
  planOf("wikipedia", "hyprland")?.next([]),
  "https://en.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch=hyprland&gsrlimit=5&prop=extracts&exintro=1&explaintext=1&exsentences=2&redirects=1",
)
check(
  "archwiki searches first",
  planOf("archwiki", "greetd")?.next([]),
  "https://wiki.archlinux.org/api.php?action=query&format=json&list=search&srsearch=greetd&srlimit=1",
)
check(
  "archwiki then reads the lead section of the page the search named",
  planOf("archwiki", "greetd")?.next([AW_SEARCH]),
  "https://wiki.archlinux.org/api.php?action=query&format=json&prop=revisions&rvprop=content&rvslots=main&rvsection=0&titles=Greetd&redirects=1",
)
check(
  "archwiki stops once it has the lead",
  planOf("archwiki", "greetd")?.next([AW_SEARCH, AW_LEAD]),
  null,
)
check(
  "wiktionary asks for the definitions",
  planOf("wiktionary", "archaic")?.next([]),
  "https://en.wiktionary.org/api/rest_v1/page/definition/archaic",
)
check(
  "wiktionary then asks Datamuse for synonyms",
  planOf("wiktionary", "archaic")?.next([DEF]),
  "https://api.datamuse.com/words?rel_syn=archaic&max=8",
)
check(
  "the package database is searched once",
  planOf("archpackage", "greetd")?.next([]),
  "https://archlinux.org/packages/search/json/?q=greetd&limit=8",
)
check(
  "the AUR is asked by exact name",
  planOf("aur", "yay")?.next([]),
  "https://aur.archlinux.org/rpc/v5/info?arg%5B%5D=yay",
)
check("an empty argument has no plan", planOf("aur", "   "), null)

// ── wikipedia: the ranked hit is not the answer unless it names the query ──
check(
  "wikipedia drops a hit that does not name the query",
  items("wikipedia", "greetd", [WIKI_GREETD]),
  [],
)
{
  const rows = items("wikipedia", "hyprland", [WIKI_HYPRLAND])
  check("wikipedia keeps the hit that names the query", titles(rows), "Wikipedia — Hyprland")
  check(
    "the enriched row leads with the extract, not a repeated page title",
    description(rows, 0).startsWith(
      "Hyprland is a dynamic tiling window manager and compositing manager for Wayland written in C++.",
    ),
    true,
  )
  check(
    "no page title prefix on the description",
    description(rows, 0).startsWith("Hyprland —"),
    false,
  )
  check("wikipedia opens the article", url(rows, 0), "https://en.wikipedia.org/wiki/Hyprland")
}
check("wikipedia rejects a payload that is not JSON", items("wikipedia", "x", ["nope"]), null)

// ── the title guard is WORD-WISE: a multi-word query enriches ──
// Every case below is the live `generator=search` answer for that query, and
// each one pins a shape a folded-SUBSTRING test got wrong: it rejected a
// reordered query, a title carrying a disambiguating parenthetical, and a title
// whose words the query interrupts — while accepting a shorter unrelated one.
const foldedContained = (title: string, query: string): boolean => {
  const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
  return fold(title).includes(fold(query)) || fold(query).includes(fold(title))
}
{
  const rows = items("wikipedia", "kernel linux", [WIKI_KERNEL_REORDER])
  check(
    "a reordered query keeps the exact page first",
    firstTitle(rows),
    "Wikipedia — Linux kernel",
  )
  check(
    "the reordered case is one folded containment rejected",
    foldedContained("Linux kernel", "kernel linux"),
    false,
  )
  check(
    "the shorter unrelated title is no longer first",
    firstTitle(rows) === "Wikipedia — Linux kernel",
    true,
  )
}
check(
  "a title with a disambiguating parenthetical is accepted",
  firstTitle(items("wikipedia", "rust ownership", [WIKI_RUST])),
  "Wikipedia — Rust (programming language)",
)
check(
  "a title whose words the query interrupts is accepted",
  firstTitle(items("wikipedia", "linux kernel scheduler", [WIKI_SCHEDULER])),
  "Wikipedia — Network scheduler",
)
check(
  "a phrase with a leading stopword is accepted",
  firstTitle(items("wikipedia", "the great wall of china", [WIKI_GREAT_WALL])),
  "Wikipedia — Great Wall of China",
)
check(
  "an ambiguous single word keeps the disambiguation page",
  firstTitle(items("wikipedia", "mercury", [WIKI_MERCURY])),
  "Wikipedia — Mercury",
)
check(
  "a phrase naming a page among other hits keeps it first",
  firstTitle(items("wikipedia", "python list comprehension", [WIKI_LIST_COMPREHENSION])),
  "Wikipedia — List comprehension",
)
check(
  "an ordinary two-word document title is accepted",
  firstTitle(items("wikipedia", "arch linux", [WIKI_ARCH_LINUX])),
  "Wikipedia — Arch Linux",
)
// The control the guard exists for: an unrelated page shares no word.
check("the unrelated page is still refused", items("wikipedia", "greetd", [WIKI_GREETD]), [])
// A hit whose title names the query but whose extract did not come back is
// SKIPPED, not fatal: the scan takes the next hit that has both (see the note
// in AGENTS.md — `generator=search` returned an extract for every mainspace hit
// measured, so no second request is staged for it).
check(
  "a guarded hit with no extract is skipped for the next one",
  firstTitle(items("wikipedia", "linux kernel", [WIKI_EXTRACT_MISSING])),
  "Wikipedia — Linux kernel version history",
)

// ── an extract's non-prose fragments come out before the clip ──
{
  const rows = items("wikipedia", "Arthropods", [WIKI_ARTHROPODS])
  const first = description(rows, 0)
  check(
    "the pronunciation gloss is dropped",
    first.startsWith("Arthropods are invertebrates in the phylum Arthropoda."),
    true,
  )
  check("the gloss itself is gone", first.includes("AR-thrə-pod"), false)
  check("a real parenthetical survives", first.includes("(metameric)"), true)
  check(
    "the sibling hits become rows beneath, each still `Wikipedia — <title>`",
    titles(rows),
    "Wikipedia — Arthropod | Wikipedia — Arthropod eye | Wikipedia — Spiracle (arthropods)",
  )
}

// ── archwiki: search → lead section, wikitext stripped ──
{
  const rows = items("archwiki", "greetd", [AW_SEARCH, AW_LEAD])
  check("archwiki names the article the search found", titles(rows), "ArchWiki — Greetd")
  check(
    "archwiki reads the lead as prose",
    description(rows, 0).startsWith(
      "greetd is a minimal, agnostic and flexible login manager daemon which does not make assumptions",
    ),
    true,
  )
  check(
    "no article title prefix on the description",
    description(rows, 0).startsWith("Greetd —"),
    false,
  )
  check("archwiki drops the templates and categories", description(rows, 0).includes("{"), false)
  check("archwiki drops the link brackets", description(rows, 0).includes("["), false)
  check("archwiki opens the article", url(rows, 0), "https://wiki.archlinux.org/title/Greetd")
}
check(
  "archwiki without the lead payload keeps today's row",
  items("archwiki", "greetd", [AW_SEARCH]),
  [],
)

// ── wiktionary: one row per part of speech, then the synonyms ──
{
  const rows = items("wiktionary", "archaic", [DEF, SYN])
  check(
    "wiktionary emits one row per sense and the synonyms",
    titles(rows),
    "archaic — noun | archaic — adjective | Synonyms: primitive · antiquated · old · antediluvian · early",
  )
  check(
    "the enriched row carries the first sense",
    description(rows, 0),
    "noun — (A member of) an archaic variety of Homo sapiens.",
  )
  check(
    "the second sense strips the definition's HTML",
    description(rows, 1),
    "adjective — Of or characterized by antiquity; old-fashioned, quaint, antiquated.",
  )
  check(
    "a sense row opens the entry at that sense",
    url(rows, 1),
    "https://en.wiktionary.org/wiki/archaic#Adjective",
  )
  check("the synonym row opens the entry", url(rows, 2), "https://en.wiktionary.org/wiki/archaic")
}
check(
  "wiktionary without the synonym payload still shows the senses",
  titles(items("wiktionary", "archaic", [DEF])),
  "archaic — noun | archaic — adjective",
)
check(
  "wiktionary on a word with no English entry shows nothing",
  items("wiktionary", "x", ['{"en":[]}']),
  [],
)

// ── the package database, with the version installed here ──
{
  const rows = items("archpackage", "greetd", [PAC], INSTALLED)
  check(
    "the exact package wins over the ranking",
    titles(rows),
    "Arch package — greetd | cosmic-greeter 1.8.0-1 (extra) | greetd-agreety 0.10.3-2 (extra)",
  )
  check(
    "the enriched row names the repo version and the installed one",
    description(rows, 0),
    "Generic greeter daemon · extra · 0.10.3-2 · maintainer alerque · installed 0.10.3-3",
  )
  check(
    "the package row opens its own page",
    url(rows, 0),
    "https://archlinux.org/packages/extra/x86_64/greetd/",
  )
  check(
    "a package that is not installed says so",
    description(items("archpackage", "greetd", [PAC]), 0),
    "Generic greeter daemon · extra · 0.10.3-2 · maintainer alerque · not installed",
  )
}
check(
  "the package database with no hits shows nothing",
  items("archpackage", "x", ['{"results":[]}']),
  [],
)

// ── the AUR ──
{
  const rows = items("aur", "yay", [AUR_YAY])
  check("the AUR row is named after the package", titles(rows), "AUR — yay")
  check(
    "the AUR row carries the description, version, votes and maintainer",
    description(rows, 0),
    "Yet another yogurt. Pacman wrapper and AUR helper written in go. · 13.0.1-1 · 2653 votes · popularity 29.0 · maintainer jguer",
  )
  check("the AUR row opens the package", url(rows, 0), "https://aur.archlinux.org/packages/yay")
}
check("a package that is not in the AUR shows nothing", items("aur", "greetd", [AUR_NONE]), [])

// ── the cache key and the TTLs the fetch half reads ──
check(
  "one cache key for one query however it is typed",
  previewCacheKey("archwiki", "  Greetd "),
  previewCacheKey("archwiki", "greetd"),
)
check("article prose is cached for a day", previewTtlMs("archwiki"), 24 * 60 * 60 * 1000)
check("a package version is cached for an hour", previewTtlMs("archpackage"), 60 * 60 * 1000)

// ── a transient failure is NOT an answer, so it is never cached ──
// The defect this pins: one network spike (a timeout, a socket error, a 5xx, a
// 429, a body that did not parse) must not be cached like a 404, or the preview
// stays hidden for that query for a whole minute.
check("a timeout is transient", classifyStatus(0), "transient")
check("a 404 is definitive", classifyStatus(404), "definitive")
check("a 410 is definitive", classifyStatus(410), "definitive")
check("a 429 is transient", classifyStatus(429), "transient")
check("a 500 is transient", classifyStatus(500), "transient")
check("a 503 is transient", classifyStatus(503), "transient")
check("a 301 is transient", classifyStatus(301), "transient")
check("rows keep their source's TTL", previewTtlFor("wikipedia", "rows"), previewTtlMs("wikipedia"))
check(
  "a definite negative is cached for a minute",
  previewTtlFor("archwiki", "definitive-negative"),
  DEFINITIVE_NEGATIVE_TTL_MS,
)
check("a transient failure is cached for nothing", previewTtlFor("archwiki", "transient"), null)
check(
  "no source caches a transient failure",
  (["wikipedia", "archwiki", "wiktionary", "archpackage", "aur"] as const).every(
    (k) => previewTtlFor(k, "transient") === null,
  ),
  true,
)

// ── `!def` is GREEDY: every word typed becomes its own entry ──
// The split rule, the units the runtime caches in, and the row model. A future
// edit that hands the whole argument to one lookup fails here.
const wordsOf = (arg: string) => previewArgs("wiktionary", arg).join(" ")
check("two words split", wordsOf("archaic obsolete"), "archaic obsolete")
check("commas and semicolons split too", wordsOf("archaic, obsolete; archaic"), "archaic obsolete")
check("the same word twice is one lookup", wordsOf("archaic ARCHaic"), "archaic")
check("surrounding punctuation is trimmed", wordsOf('"archaic."'), "archaic")
check("a hyphen inside a word stays", wordsOf("well-being"), "well-being")
check("one word stays one unit", wordsOf("archaic"), "archaic")
check(
  "the cap keeps the first words",
  wordsOf("one two three four five"),
  "one two three four five",
)
check("the cap is five words per keypress", DEFINE_WORD_CAP, 5)
check(
  "the typed count survives the cap",
  previewWordCount("wiktionary", "one two three four five"),
  5,
)
check("no words means no plan", previewArgs("wiktionary", "  ,, ").length, 0)
check(
  "every other source takes its argument whole",
  previewArgs("wikipedia", "arch linux").join(" "),
  "arch linux",
)
// PER-WORD cache keys: `!def archaic obsolete` after `!def archaic` costs one
// new word, which is what makes a greedy argument cheap.
check(
  "the cache keys are per word",
  previewArgs("wiktionary", "archaic obsolete")
    .map((w) => previewCacheKey("wiktionary", w))
    .join(" "),
  "wiktionary:archaic wiktionary:obsolete",
)
check(
  "two arguments sharing a word share its key",
  previewArgs("wiktionary", "obsolete rusty")
    .map((w) => previewCacheKey("wiktionary", w))
    .filter((k) =>
      previewArgs("wiktionary", "archaic obsolete")
        .map((w) => previewCacheKey("wiktionary", w))
        .includes(k),
    )
    .join(" "),
  "wiktionary:obsolete",
)
{
  const archaic = items("wiktionary", "archaic", [DEF, SYN])
  const obsolete = items("wiktionary", "obsolete", [DEF_OBSOLETE, SYN_OBSOLETE])
  const greedy = greedyDefineItems(["archaic", "obsolete"], 2, [archaic, obsolete])
  check("the first word's payload yields its senses", (archaic ?? []).length, 3)
  check(
    "the second word's fixture parses",
    (() => {
      try {
        JSON.parse(DEF_OBSOLETE)
        return "ok"
      } catch (e) {
        return (e as Error).message
      }
    })(),
    "ok",
  )
  check("the second word's payload yields its senses", (obsolete ?? []).length, 2)
  check(
    "a greedy batch is one row per word",
    greedy.map((i) => i.title).join(" | "),
    "Define: archaic | Define: obsolete",
  )
  check(
    "a word's row carries its own first sense",
    greedy[1]?.description,
    obsolete?.[0]?.description ?? "",
  )
  check("a word's row opens that word's entry", greedy[1]?.url, obsolete?.[0]?.url ?? "")
  check(
    "a word missing from the payload is skipped, the rest stay",
    greedyDefineItems(["archaic", "zzzz"], 2, [archaic, []])
      .map((i) => i.title)
      .join(" | "),
    "Define: archaic",
  )
  check(
    "every word missing leaves the bang its own row",
    greedyDefineItems(["a", "b"], 2, [null, null]),
    [],
  )
  check(
    "a capped batch says how many words were answered",
    greedyDefineItems(["a", "b", "c"], 5, [archaic, obsolete, archaic])
      .at(0)
      ?.description.endsWith("· 3 of 5 words"),
    true,
  )
  // The collapse this pass exists to prevent: the runtime keys are the WORDS,
  // never the whole argument (a single-key collapse would refetch every word
  // and answer only the first).
  check(
    "the cache key is never the whole argument",
    previewCacheKey("wiktionary", "archaic obsolete") ===
      previewCacheKey("wiktionary", previewArgs("wiktionary", "archaic obsolete")[0]),
    false,
  )
}

// ── `!g`: the DuckDuckGo instant answer, then the guarded Wikipedia search ──
check(
  "the instant answer asks the DDG API",
  planOf("ddg", "hyprland")?.next([]),
  "https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=hyprland",
)
check(
  "an answered query stops after the instant answer",
  planOf("ddg", "hyprland")?.next([DDG]),
  null,
)
check(
  "an EMPTY answer falls back to the guarded Wikipedia search",
  planOf("ddg", "greetd")?.next([DDG_EMPTY]),
  "https://en.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch=greetd&gsrlimit=5&prop=extracts&exintro=1&explaintext=1&exsentences=2&redirects=1",
)
{
  const rows = items("ddg", "hyprland", [DDG])
  check("the instant answer carries the abstract", firstTitle(rows), "Hyprland")
  check(
    "the enriched row's description is the abstract text",
    description(rows, 0).startsWith("Hyprland is a dynamic tiling window manager"),
    true,
  )
  check("its related topics become rows beneath", rows !== null && rows.length > 1, true)
}
check(
  "an empty answer with no fallback payload shows nothing",
  items("ddg", "greetd", [DDG_EMPTY]),
  [],
)
// The control: the Wikipedia fallback keeps the title guard, so the page the
// search names for `greetd` (`Phosh`) is still refused.
check(
  "the fallback refuses the unrelated page",
  items("ddg", "greetd", [DDG_EMPTY, WIKI_GREETD]),
  [],
)
check(
  "the fallback keeps the related page",
  firstTitle(items("ddg", "hyprland", [DDG_EMPTY, WIKI_HYPRLAND])),
  "Wikipedia — Hyprland",
)

// ── `!tr`: the unofficial gtx endpoint, parsed defensively ──
check(
  "translate asks the gtx endpoint for the target language",
  planOf("translate", "hello world to de")?.next([]),
  "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=de&dt=t&q=hello%20world",
)
check("translate asks once", planOf("translate", "hello to de")?.next([GTX]), null)
check(
  "the translation is the enriched row's description",
  description(items("translate", "hello world to de", [GTX]), 0),
  "Hallo Welt",
)
// An unparseable body is the runtime's TRANSIENT signal (null): it is cached for
// nothing, so the next attempt retries — the 429 above is exactly that case.
check(
  "a payload of the wrong shape is unparseable, not empty",
  items("translate", "x to de", ["<html>429 abuse page</html>"]),
  null,
)
check("an empty translation answers nothing", items("translate", "x to de", ["[[]]"]), [])
// An empty argument has no plan; a target-only tail is TEXT to translate (the
// bang's own rule: a trailing `to <lang>` only counts when text precedes it).
check("an empty argument has no plan", planOf("translate", "   "), null)
check("a target-only tail is text", planOf("translate", "to de")?.next([]) !== null, true)

// ── `!yt`: the scraped results page, bounded and capped ──
check(
  "youtube asks the results page once",
  planOf("youtube", "greetd arch linux")?.next([]),
  "https://www.youtube.com/results?search_query=greetd%20arch%20linux",
)
{
  const rows = items("youtube", "greetd arch linux", [YT_PAGE])
  check("the scraped page yields video rows", (rows ?? []).length > 0, true)
  check(
    "a video row opens that video",
    url(rows, 0).startsWith("https://www.youtube.com/watch?v="),
    true,
  )
  check(
    "a video row names its id in the description",
    description(rows, 0).startsWith("youtube.com/watch?v="),
    true,
  )
}
check(
  "a page whose shape moved on answers nothing",
  items("youtube", "x", ["<html>no payload</html>"]),
  [],
)
check(
  "a payload with no video entries answers nothing",
  items("youtube", "x", ['var ytInitialData = {"x":1}']),
  [],
)

// ── one request budget per source class ──
check("the fast class gets 3 s", previewTimeoutS("wiktionary"), 3)
check("the instant answer is fast class", previewTimeoutS("ddg"), 3)
check("translate is fast class", previewTimeoutS("translate"), 3)
check("wikipedia gets 4 s", previewTimeoutS("wikipedia"), 4)
check("the arch package source gets 8 s", previewTimeoutS("archpackage"), 8)
check("the arch wiki gets 8 s", previewTimeoutS("archwiki"), 8)
check("the AUR gets 8 s", previewTimeoutS("aur"), 8)
check("the scraped page gets 8 s", previewTimeoutS("youtube"), 8)

const failed = checks.filter(([, actual, expected]) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  return a !== e
})
for (const [name, actual, expected] of checks) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n     got  ${JSON.stringify(actual)}\n     want ${JSON.stringify(expected)}`}`,
  )
}
console.log(`summary: ${checks.length - failed.length}/${checks.length} checks passed`)

// ── the live pass: the five endpoints through the real fetch ──
const LIVE: [EnrichKind, string][] = [
  ["wikipedia", "hyprland"],
  ["wikipedia", "greetd"],
  ["archwiki", "greetd"],
  ["wiktionary", "archaic"],
  ["archpackage", "greetd"],
  ["aur", "yay"],
]

if (GLib.getenv("LIVE") === "1") {
  if (failed.length > 0) throw new Error(`bang-preview probe failed: ${failed.length} check(s)`)
  const loop = GLib.MainLoop.new(null, false)
  let finished = false
  let liveError: Error | null = null
  const deadline = GLib.get_monotonic_time() + 60_000_000

  void (async () => {
    for (const [kind, arg] of LIVE) {
      const rows = await previewFor({
        kind,
        arg,
        title: `!${kind} ${arg}`,
        target: `https://example.invalid/${kind}`,
        icon: "help-browser",
        onBusy: () => {},
      })
      console.log(
        rows.length === 0
          ? `live ${kind} ${JSON.stringify(arg)} -> no rows (today's row stands)`
          : `live ${kind} ${JSON.stringify(arg)} ->\n${rows.map((r) => `     ${r.title} || ${r.description ?? ""}`).join("\n")}`,
      )
    }
  })()
    .catch((e: Error) => {
      console.log(`live pass FAILED: ${e.message}`)
      liveError = e
    })
    .finally(() => {
      finished = true
      loop.quit()
    })

  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
    if (finished || GLib.get_monotonic_time() > deadline) {
      loop.quit()
      return GLib.SOURCE_REMOVE
    }
    return GLib.SOURCE_CONTINUE
  })
  loop.run()
  if (liveError) throw liveError
  if (!finished) throw new Error("live pass timed out")
}

if (failed.length > 0) throw new Error(`bang-preview probe failed: ${failed.length} check(s)`)
