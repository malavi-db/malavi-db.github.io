/* =============================================================================
 * lineage-history.mjs
 * -----------------------------------------------------------------------------
 * Reading the Lineage History table for one name: what a lineage used to be
 * called, what became of a name that is no longer in use, and when its stored
 * sequence was replaced.
 *
 * The table (a release table since 2026-09-25; on the site as
 * assets/data/tables/lineage_history.json once a release carries it) has one
 * row per event. The event names are EVENTS below, which must equal the enum
 * in schemas/lineage_history.schema.json (a test reads the schema and checks).
 * Until 2026-11-03 this module used "renamed_to", the draft name; the table,
 * the Python and malaviR all write "renamed", so a rename showed nothing.
 *
 * Pure functions; the rows are the table's records as objects keyed by column
 * (lineage, event, old, new, old_seq, new_seq, date, reason, source, release).
 * See tests/test_lineage_history.mjs.
 * ============================================================================= */

/* The four events, exactly as the table writes them. */
export const EVENTS = ["sequence_updated", "renamed", "merged_into", "removed"];

/* The events that change which name is current. A sequence update keeps the name. */
const RENAMING = new Set(["renamed", "merged_into"]);

const WORDS = { renamed: "renamed", merged_into: "merged into", removed: "removed" };

const up = (v) => String(v || "").toUpperCase();

/* Bases that are A, C, G or T: what a sequence determines. The same count the
   curators' Rule 1 uses (store_ingest._determined), so a gap-padded partial
   sequence is never reported by its padded length. */
export function determinedBases(sequence) {
  let n = 0;
  for (const ch of up(sequence)) if ("ACGT".includes(ch)) n++;
  return n;
}

/* The row that moves `name` forward (a rename, merge or removal of it), or null.
   Deterministic: the FIRST such row in table order. The Python check
   (lineage_history.check_rows) refuses a table with more than one, so in a
   table that passed it there is only ever one candidate. */
function forwardRow(records, name) {
  return (records || []).find((r) =>
    up(r.old) === name && (RENAMING.has(r.event) || r.event === "removed") &&
    up(r.new) !== name) || null;
}

/**
 * What happened to `name`, as the table tells it.
 *
 * Returns { formerly, became, removed, sequenceUpdates, events }:
 *   formerly        every earlier name that now leads to `name`, through any
 *                   number of renames and merges (walked backwards), nearest
 *                   first, with the event and date; for "formerly X"
 *   became          when `name` itself is no longer current: the name it is now
 *                   under (the forward walk followed to its end), with the first
 *                   step's words, date and reason, and `steps` (every step's words,
 *                   name and date, in order); null otherwise
 *   removed         the removal row's date and reason when the walk ends there
 *   sequenceUpdates the sequence_updated rows filed under `name`, oldest first
 *   events          every row about `name`, oldest first, for listing
 */
export function historyOf(records, name) {
  const wanted = up(name);
  const all = records || [];
  const rows = all.filter((r) => up(r.old) === wanted || up(r.new) === wanted ||
    up(r.lineage) === wanted);
  rows.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));

  /* Backwards: every name renamed or merged into `name`, then every name renamed
     or merged into those, and so on. Breadth-first, so nearer names come first;
     a name already seen is not visited again, which also ends a loop. */
  const formerly = [];
  const seen = new Set([wanted]);
  let frontier = [wanted];
  while (frontier.length) {
    const next = [];
    for (const target of frontier) {
      for (const r of all) {
        if (!RENAMING.has(r.event) || up(r.new) !== target) continue;
        const earlier = up(r.old);
        if (!earlier || seen.has(earlier)) continue;
        seen.add(earlier);
        next.push(earlier);
        formerly.push({ name: r.old, event: WORDS[r.event], date: r.date || "",
                        reason: r.reason || "", into: r.new });
      }
    }
    frontier = next;
  }

  /* Forwards: renamed to B, B merged into C -> C. A removal ends it; so does a
     loop (which the table should never hold). */
  let current = wanted;
  let became = null;
  let removed = null;
  const visited = new Set([current]);
  for (let step = 0; step < 50; step++) {
    const next = forwardRow(all, current);
    if (!next) break;
    // A removal ends the walk; `name` says WHICH name was removed (the queried one, or
    // the one a rename or merge led to).
    if (next.event === "removed") { removed = next; break; }
    const ahead = up(next.new);
    // A loop (which the table should never hold) ends the walk before the name it leads
    // back to is taken as the current one.
    if (visited.has(ahead)) break;
    visited.add(ahead);
    current = ahead;
    // `event`, `date` and `reason` are the first step's; `name` is the chain's end, and
    // `steps` lists every step so the words never pair one step's verb with another
    // step's name (review round 2: "renamed B, then merged into C" read "renamed C").
    became = became || { event: WORDS[next.event], date: next.date || "",
                         reason: next.reason || "", steps: [] };
    became.steps.push({ event: WORDS[next.event], name: next.new, date: next.date || "",
                        reason: next.reason || "" });
    became.name = next.new;
  }

  const sequenceUpdates = rows
    .filter((r) => r.event === "sequence_updated" && up(r.lineage || r.old) === wanted)
    .map((r) => ({ source: r.source || "", release: r.release || "", date: r.date || "",
                   // Blank or all-gap: no old count to give ("now N", never "0 to N").
                   oldBases: determinedBases(r.old_seq) || null,
                   newBases: determinedBases(r.new_seq) }));

  return {
    formerly,
    became,
    removed: removed ? { name: removed.old || "", date: removed.date || "",
                         reason: removed.reason || "" } : null,
    sequenceUpdates,
    events: rows.map((r) => ({ event: r.event, old: r.old, new: r.new, date: r.date || "",
                               reason: r.reason || "", source: r.source || "",
                               release: r.release || "" }))
  };
}

/** "formerly STRALU01 (merged into, 2026-09-25)" or "" when there is nothing to say. */
export function formerlyWords(records, name) {
  const { formerly } = historyOf(records, name);
  if (!formerly.length) return "";
  return "formerly " + formerly.map((f) =>
    `${f.name} (${f.event}${f.date ? ", " + f.date.slice(0, 10) : ""})`).join("; ");
}

export function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const day = (d) => escapeHtml(String(d || "").slice(0, 10));

/**
 * The name lookup's history paragraphs, as HTML (every table value escaped).
 * Moved here from malavi.js on 2026-11-03 so the node tests cover it.
 */
export function historyHtml(records, name) {
  if (!records) return "";
  const past = historyOf(records, name);
  let out = "";
  if (past.formerly.length) {
    out += '<p class="fine">Formerly ' + past.formerly.map((f) =>
      "<b>" + escapeHtml(f.name) + "</b> (" + escapeHtml(f.event) +
      (f.date ? " " + day(f.date) : "") +
      (f.reason ? ": " + escapeHtml(f.reason) : "") + ")").join("; ") + ".</p>";
  }
  for (const u of past.sequenceUpdates) {
    const said = [u.source, u.release ? "release " + u.release : ""].filter(Boolean);
    const bases = u.oldBases === null
      ? "now " + u.newBases + " bases"
      : u.oldBases + " to " + u.newBases + " bases";
    out += '<p class="fine">Stored sequence replaced' +
      (said.length ? " (" + escapeHtml(said.join(", ")) + ")" : "") + "; " + bases +
      " (bases counted are those read as A, C, G or T).</p>";
  }
  if (past.became) {
    // Each step with its own verb and reason: "It was renamed B on d1 (why), then merged
    // into C on d2 (why)". One step reads as it always has.
    const steps = past.became.steps || [past.became];
    const words = steps.map((step) => escapeHtml(step.event) + " <b>" +
      escapeHtml(step.name) + "</b>" + (step.date ? " on " + day(step.date) : "") +
      (step.reason ? (steps.length > 1 ? " (" + escapeHtml(step.reason) + ")"
        : ": " + escapeHtml(step.reason)) : ""));
    out += '<p class="fine"><b>This name is no longer in use.</b> It was ' +
      words.join(", then ") +
      (past.removed ? ".</p>"
        : ". Records are under " + (steps.length > 1 ? "<b>" +
          escapeHtml(past.became.name) + "</b>" : "that name") + ".</p>");
  }
  if (past.removed) {
    const self = up(past.removed.name) === up(name) || !past.removed.name;
    out += '<p class="fine">' + (self ? "<b>This name was removed</b>"
      : "<b>" + escapeHtml(past.removed.name) + " was later removed</b>") +
      (past.removed.date ? " on " + day(past.removed.date) : "") +
      (past.removed.reason ? ": " + escapeHtml(past.removed.reason) : "") + ".</p>";
  }
  return out;
}
