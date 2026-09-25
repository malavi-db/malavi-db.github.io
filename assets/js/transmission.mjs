/* =============================================================================
 * transmission.mjs: the ONE rule that turns a host record's age class, residency
 * and range flag into a transmission class for the map's transmission view.
 *
 * The same rule is applied at build time in export/build_site_points.R, which
 * writes the resulting class counts into site_points.json; the test
 * tests/test_transmission.mjs recomputes them here and requires equality, so
 * the page's colors and the exporter's arithmetic cannot drift apart unnoticed.
 *
 * Inputs, all per record (see export/build_site_points.R for the payload):
 *   age    HOST_AGE as MalAvi records it: "Adult", "Juvenile", "Nestling",
 *          "Adult + Juvenile", "Adult + Nestling", "Unknown", or "".
 *   status HOST_STATUS: "Resident", "Migratory", "Unknown", or "".
 *   range  the host-range flag from reference/host_range_lookup.csv:
 *          -1 not tested, 0 outside every polygon, 1 inside a breeding or
 *          resident polygon only, 2 inside a non-breeding or passage polygon
 *          only, 3 inside both kinds or seasonally uncertain.
 *
 * The rule (design: results/HANDOFF_2026-09-25.md, Vincenzo 2026-09-25):
 *   local        a resident of any age; a nestling of any status; a hatch-year
 *                bird (age contains "Juvenile") whose site lies inside its
 *                species' breeding or resident range (range === 1).
 *   elsewhere    an adult of a migratory species: it may have been infected
 *                anywhere on its route, even when sampled on its breeding
 *                grounds, so the range flag is deliberately NOT consulted.
 *   undetermined everything else: mixed age classes without the range test,
 *                unknown or blank age or status, hatch-year birds outside the
 *                breeding range or where the range test could not decide.
 * ============================================================================= */

/* The three classes, in display order, with the words the legend uses. */
export const CLASSES = [
  { key: "local",        label: "local transmission likely",
    hint: "residents, nestlings, and hatch-year birds inside their breeding range" },
  { key: "elsewhere",    label: "possibly acquired elsewhere",
    hint: "adults of migratory species" },
  { key: "undetermined", label: "undetermined",
    hint: "age or residency unknown, mixed groups, hatch-year migrants off their breeding range" }
];

/* transmissionClass(age, status, range) -> "local" | "elsewhere" | "undetermined" */
export function transmissionClass(age, status, range) {
  var a = String(age || "").trim().toLowerCase();
  var s = String(status || "").trim().toLowerCase();
  if (s === "resident") return "local";
  if (a.indexOf("nestling") >= 0) return "local";
  if (a.indexOf("juvenile") >= 0 && range === 1) return "local";
  if (a === "adult" && s === "migratory") return "elsewhere";
  return "undetermined";
}

/* The class a SITE takes from the records shown at it: the strongest present.
   "Strongest" means the one that says most -- local beats elsewhere beats
   undetermined -- so a site with one resident and twenty unknowns reads as
   local; the popup shows the twenty. */
export function siteClass(classes) {
  var has = {};
  for (var i = 0; i < classes.length; i++) has[classes[i]] = true;
  if (has.local) return "local";
  if (has.elsewhere) return "elsewhere";
  return "undetermined";
}

/* Count records per class. Returns { local, elsewhere, undetermined }. */
export function countClasses(records, classOf) {
  var out = { local: 0, elsewhere: 0, undetermined: 0 };
  for (var i = 0; i < records.length; i++) out[classOf(records[i])]++;
  return out;
}
