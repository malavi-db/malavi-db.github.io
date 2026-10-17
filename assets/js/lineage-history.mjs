/* =============================================================================
 * lineage-history.mjs
 * -----------------------------------------------------------------------------
 * Reading the Lineage History table for one name: what a lineage used to be
 * called, and what became of a name that is no longer in use.
 *
 * The table (a release table since 2026-09-25; on the site as
 * assets/data/tables/lineage_history.json once a release carries it) has one
 * row per event: sequence_updated, renamed_to, merged_into, removed. A name is
 * cited in hundreds of papers, so nothing changes silently: the curators' rule
 * is that every rename, merge or removal gets a public row, and this module is
 * how the site shows the row beside the name.
 *
 * Pure functions; the rows are the table's records as objects keyed by column
 * (lineage, event, old, new, date, reason, source). See tests/test_lineage_history.mjs.
 * ============================================================================= */

/* The events that change which name is current. A sequence update keeps the name. */
const RENAMING = new Set(["renamed_to", "merged_into"]);

const WORDS = { renamed_to: "renamed", merged_into: "merged into", removed: "removed" };

/**
 * What happened to `name`, as the table tells it.
 *
 * Returns { formerly, became, removed, events }:
 *   formerly    the old names this current name absorbed or replaced, newest
 *               first, with the event and date -- for "formerly X" beside a name
 *   became      when `name` itself is no longer current: the name it is now
 *               under (a chain of renames followed to its end), with the first
 *               event's words, date and reason; null otherwise
 *   removed     the removal row's date and reason when the name was removed
 *   events      every row about `name`, oldest first, for listing
 */
export function historyOf(records, name) {
  const wanted = String(name || "").toUpperCase();
  const rows = (records || []).filter((r) =>
    String(r.old || "").toUpperCase() === wanted ||
    String(r.new || "").toUpperCase() === wanted ||
    String(r.lineage || "").toUpperCase() === wanted);
  rows.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));

  const formerly = rows
    .filter((r) => RENAMING.has(r.event) && String(r.new || "").toUpperCase() === wanted &&
      String(r.old || "").toUpperCase() !== wanted)
    .map((r) => ({ name: r.old, event: WORDS[r.event] || r.event, date: r.date || "",
                   reason: r.reason || "" }))
    .reverse();

  /* Follow the name forward: renamed to B, B merged into C -> C. A removal ends
     it. A loop (which the table should never hold) ends it too. */
  let current = wanted;
  let became = null;
  let removed = null;
  const seen = new Set([current]);
  for (let step = 0; step < 20; step++) {
    const next = (records || []).find((r) =>
      String(r.old || "").toUpperCase() === current &&
      (RENAMING.has(r.event) || r.event === "removed") &&
      String(r.new || "").toUpperCase() !== current);
    if (!next) break;
    if (next.event === "removed") { removed = next; break; }
    current = String(next.new || "").toUpperCase();
    if (seen.has(current)) break;
    seen.add(current);
    // The first step's words and date are the ones to show; the name is the chain's end.
    became = became || { event: WORDS[next.event] || next.event, date: next.date || "",
                         reason: next.reason || "" };
    became.name = next.new;
  }

  return {
    formerly,
    became,
    removed: removed ? { date: removed.date || "", reason: removed.reason || "" } : null,
    events: rows.map((r) => ({ event: r.event, old: r.old, new: r.new, date: r.date || "",
                               reason: r.reason || "", source: r.source || "" }))
  };
}

/** "formerly STRALU01 (merged into, 2026-09-25)" or "" when there is nothing to say. */
export function formerlyWords(records, name) {
  const { formerly } = historyOf(records, name);
  if (!formerly.length) return "";
  return "formerly " + formerly.map((f) => `${f.name} (${f.event}${f.date ? ", " + f.date.slice(0, 10) : ""})`).join("; ");
}
