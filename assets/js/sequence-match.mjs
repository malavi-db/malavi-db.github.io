/* =============================================================================
 * sequence-match.mjs
 * -----------------------------------------------------------------------------
 * The MalAvi BLAST page (called "Sequence matcher" from 2026-09-16 to 2026-09-24):
 * what the Shiny "MalAvi BLAST" app did, in the browser, against the pinned
 * release.
 *
 * HOW IT WORKS, AND WHY IT IS NOT THE SUBMIT PAGE'S CHECKER
 *   The submit page's checker (sequence-check.mjs) registers a query to the
 *   479 bp MalAvi reading frame and compares it column by column, WITHOUT
 *   gaps. That is the right tool for its question -- "is this already a named
 *   lineage?" -- because MalAvi lineages are defined by substitutions inside
 *   that frame, and it is exhaustive over the whole release.
 *
 *   It has one blind spot, and this page exists partly to cover it: a query
 *   carrying an insertion or a deletion cannot be registered to the frame in
 *   one piece. Everything after the indel is out of step, so an ungapped
 *   comparison sees a wall of mismatches and the true parent lineage sinks.
 *   Measured on the 2026-09-15 release, with SGS1 as the query:
 *
 *     query                     ungapped rank of SGS1   what the checker says
 *     SGS1, intact                                  1   already in MalAvi
 *     SGS1, one base deleted at 241                 2   looks like a new lineage
 *     SGS1, one base inserted at 241              110   looks like a new lineage
 *     SGS1, one base deleted at 100               134   looks like a new lineage
 *
 *   The curator-side Python checker has the same blind spot, differently
 *   expressed: it refuses to place two of those queries at all, and for the
 *   other two it names an unrelated, thinly covered lineage as the nearest
 *   relative. Neither tool says the useful thing, which is "this looks like
 *   SGS1 with one base missing".
 *
 *   So this page does what the Shiny app's DECIPHER did, in the same three
 *   steps, and is indel-tolerant by construction:
 *
 *     1. SEED.  Look the query's 16-mers up in the index the checker already
 *        builds, on both strands, and count hits per reference. A query with
 *        an indel still shares hundreds of exact 16-mers with its parent, so
 *        the parent surfaces here whatever the indel does to the frame. Tested
 *        over deletions at positions 10, 30, 100, 200, 241 and 470, one and
 *        two bases, an insertion at 241, and the reverse strand at 10, 241
 *        and 470: the parent came back first every time.
 *        Sensitivity needs one intact sampled 16-mer shared with the parent.
 *        A lineage that differs at every 16th base, about 6 % divergence
 *        evenly spread, would not be seeded; real near-lineage questions
 *        differ at a handful of positions, and anything more divergent is a
 *        BLAST question. The page says so.
 *     2. ALIGN.  Run a real overlap alignment -- gaps allowed, free end gaps --
 *        of the query against each of the top candidates.
 *     3. RANK.  Order by the protective rule below and show the top N.
 *
 * WHAT IT DOES NOT DECIDE
 *   Anything. It reports what it measured -- the ranked lineages, the numbers
 *   behind each one, and the alignment -- and leaves the reading of it to
 *   whoever pasted the sequence. It reaches no verdict, offers no interpretation
 *   and pops nothing up. That is deliberate (Vincenzo, 2026-09-16): the submit
 *   page's checker is where a submitter is walked through what a sequence means,
 *   and this page is the instrument, not the advice.
 *
 *   `indel` is still computed and still tested, because an insertion or deletion
 *   is the case that forced the alignment-based ranking below and the tests are
 *   the proof it works. Nothing on the page displays it.
 *
 * DETERMINISM
 *   Same input, same output, every time: no scoring model, no random seed, no
 *   network call once the index has loaded. Ties are broken by lineage name so
 *   that even the row order is fixed.
 *
 * NOT BLAST
 *   No e-values, no bit scores, no heuristic extension. Every candidate is
 *   aligned in full, and the candidate set is a seed-count cut, not a
 *   significance cut. The page was called "Sequence matcher" for that reason;
 *   the curators asked on 2026-09-24 for the old app's name back, because
 *   "BLAST" is what users look for, so the page says in its first paragraph
 *   that it is not NCBI BLAST instead.
 * ============================================================================= */

import {
  K,
  SEED_STRIDE,
  cleanSequence,
  countContent,
  expandSeedWord,
  findMatches,
  reverseComplement,
  splitFastaRecords
} from "./sequence-check.mjs";

/* ---------------------------------------------------------------------------
 * Constants
 *
 * K (seed length, 16) and SEED_STRIDE (the query is sampled every 4 bases) are
 * imported from the checker rather than declared again here: the seeds are
 * looked up in the index the checker builds, so a different K would silently
 * find nothing. References are indexed at every position, so striding the
 * query loses no reference; it only costs resolution in the seed COUNT, which
 * is a ranking aid, not a filter. Stride 4 gives ~116 seeds for a 479 bp query.
 * --------------------------------------------------------------------------- */

/* How many references are aligned. The seed step above puts the true parent in
   the top one or two, so 300 is a wide margin over what is needed, and costs
   about a third of a second. Raising it costs time linearly and changes no
   answer that has been observed; lowering it risks the one error this page
   must not make. */
export const CANDIDATE_LIMIT = 300;

/* Alignment scoring. Deliberately plain: it exists to place a gap where a gap
   belongs, not to estimate a significance. Stated on the page so nobody reads
   the Score column as comparable to a BLAST bit score or a DECIPHER score. */
export const ALIGN_MATCH = 1;
export const ALIGN_MISMATCH = -1;
export const ALIGN_GAP = -2;

/* A reference must cover at least this many of the query's positions before its
   RATE of mismatch is trusted for ranking. Same value and the same reasoning as
   MIN_COMPARABLE_TO_RANK in curation/src/malavi_curation/sequence_check.py: a
   20-position overlap with one mismatch must never outrank a full-length
   relative. RBQ18, the least covered sequence in the alignment, is 133 bp.

   The same value is the floor for calling an alignment IDENTICAL (see rankKey):
   it is MIN_INFORMATIVE_FOR_IDENTITY in the checker, the number of positions
   MalAvi requires before two sequences are the same lineage. */
export const MIN_COMPARABLE_TO_RANK = 300;

/* An alignment is listed at all only when it compares at least this many
   concrete positions. The alignment is semi-global, so a query that shares
   nothing with a reference still gets a best alignment: a few chance matches at
   one end of the reference, scoring 4 or 6 over 4 or 12 columns. Measured on
   the 2026-09-15 release: 300 pseudo-random bases behind one 16-mer copied
   from SGS1 returned THASAT08 at 100 % over 4 comparable columns, and four
   more lineages over 8-14. Fifty columns is below any fragment of a barcode
   worth matching, and is the floor on what "identical" can mean for a short
   query. It is not, on its own, beyond what chance produces: see the score
   floor next. A query with fewer concrete bases than this is refused as too
   short. */
export const MIN_COMPARABLE_TO_LIST = 50;

/* ...and must score at least this much. The column floor alone is not enough,
   because a candidate is only ever aligned after sharing an exact 16-mer with
   the query, and those 16 guaranteed matches subsidize the random columns
   around them: when the shared word sits near the end of a short reference,
   the alignment runs the word plus ~34 chance columns out to the reference's
   free end, and clears 50 columns with a score of 1 to 7. Measured on the
   2026-09-15 release, 34 of 40 pseudo-random queries carrying one 16-mer from
   SGS1 got such a listing at 64-69 % identity. Chance extension beyond a seed
   is a random walk with a downward drift (a column matches with probability
   1/4), so its score rarely climbs more than a few points above the seed's 16;
   thirty is far into that tail, and any real overlap of 50 or more positions
   at 80 % identity or better reaches it. The floor is on the score, not the
   identity, so a long overlap with a distant relative (72 % over 479 columns
   scores about 210) is still listed. */
export const MIN_SCORE_TO_LIST = 30;

/* A long query -- a mitochondrial genome, a whole-gene amplicon -- is sliced to
   the region the seeds say holds the barcode, plus this margin on each side, so
   that an indel near a boundary can still move bases across it. */
const SLICE_MARGIN = 60;

/* An indel is reported when the winning alignment contains at least this many
   gap columns. One is enough: a single-base frameshift is exactly the case the
   flag exists for, and a gap only appears at all when it pays for itself
   against ALIGN_GAP. */
const INDEL_MIN_GAPS = 1;

/* ---------------------------------------------------------------------------
 * Encoding
 *
 * Sequences are compared as small integers rather than as characters, with a
 * 16x16 score table, because the alignment inner loop runs a few hundred
 * million times per query. The encoded form is built once per index and cached
 * on the index object.
 * --------------------------------------------------------------------------- */

const ALPHABET = "ACGTURYSWKMBDHVN";

/* IUPAC codes as bit sets over {A,C,G,T}. Two symbols are compatible when their
   sets intersect, which is what "an ambiguous position is not a difference"
   means -- the same rule the checker and the submission guidance use. */
const BITS = {
  A: 1, C: 2, G: 4, T: 8, U: 8,
  R: 5, Y: 10, S: 6, W: 9, K: 12, M: 3,
  B: 14, D: 13, H: 11, V: 7, N: 15
};

const CODE = Object.create(null);
for (let i = 0; i < ALPHABET.length; i++) CODE[ALPHABET[i]] = i;

/* Code of the symbol at each index, and whether it is a single concrete base.
   "Concrete" matters because only a position where BOTH sides are one definite
   base carries positive evidence; agreement where either side is unresolved is
   a non-contradiction, not an observation. */
const CODE_BITS = new Uint8Array(ALPHABET.length);
const CODE_CONCRETE = new Uint8Array(ALPHABET.length);
for (let i = 0; i < ALPHABET.length; i++) {
  const bits = BITS[ALPHABET[i]];
  CODE_BITS[i] = bits;
  CODE_CONCRETE[i] = bits === 1 || bits === 2 || bits === 4 || bits === 8 ? 1 : 0;
}

/* Score of every symbol pair: +1 when the base sets intersect, -1 when they
   cannot be the same base. */
const SCORE = new Int8Array(16 * 16);
for (let a = 0; a < 16; a++) {
  for (let b = 0; b < 16; b++) {
    SCORE[a * 16 + b] = (CODE_BITS[a] & CODE_BITS[b]) ? ALIGN_MATCH : ALIGN_MISMATCH;
  }
}

/** Encode a sequence string. Anything unrecognized becomes N, which compares as
    compatible with everything and contributes no evidence. */
export function encodeSequence(sequence) {
  const out = new Uint8Array(sequence.length);
  for (let i = 0; i < sequence.length; i++) {
    const code = CODE[sequence[i]];
    out[i] = code === undefined ? CODE.N : code;
  }
  return out;
}

/** The release's reference sequences, encoded once and cached on the index. */
function encodedReferences(index) {
  if (!index._encoded) {
    index._encoded = index.entries.map((entry) => encodeSequence(entry.ungapped));
  }
  return index._encoded;
}

/* ---------------------------------------------------------------------------
 * Step 1: seeding
 * --------------------------------------------------------------------------- */

/**
 * Candidate references for one oriented query, by shared 16-mer count.
 *
 * Returns `{ counts, diagonals }`: a Map from the index's entry number to how
 * many of the query's seeds that reference carries, and a Map to a
 * representative diagonal (reference position minus query position). The
 * diagonal is the median over that reference's seed hits, which is robust to an
 * indel shifting half of them, and is what tells a long query where the barcode
 * window sits inside it.
 */
export function seedCandidates(index, query) {
  const counts = new Map();
  const offsets = new Map();
  for (let pos = 0; pos + K <= query.length; pos += SEED_STRIDE) {
    /* A window carrying an ambiguity code cannot be looked up as it is, but it
       is not thrown away: the checker's expandSeedWord turns it into the
       concrete words it could stand for (one N is four words) and each is
       looked up. Without this an N every 16 bases, which a mediocre read can
       have, seeds nothing and the page says "no hits" for a lineage the submit
       page names. Windows too ambiguous to expand, or holding something that
       is not a nucleotide code, are skipped, as before. */
    const words = expandSeedWord(query.substr(pos, K));
    if (!words) continue;
    /* One window counts at most once per reference, however many of its
       realizations occur there, so the count still means "how many sampled
       windows this reference shares". */
    const hitThisWindow = new Set();
    for (const word of words) {
      const bucket = index.kmers.get(word);
      if (!bucket) continue;
      for (let b = 0; b < bucket.length; b++) {
        const entryIndex = bucket[b].entryIndex;
        if (hitThisWindow.has(entryIndex)) continue;
        hitThisWindow.add(entryIndex);
        counts.set(entryIndex, (counts.get(entryIndex) || 0) + 1);
        let seen = offsets.get(entryIndex);
        if (!seen) offsets.set(entryIndex, (seen = []));
        // Bounded: enough to take a stable median without growing without limit
        // on a query that hits one reference thousands of times.
        if (seen.length < 64) seen.push(bucket[b].pos - pos);
      }
    }
  }
  const diagonals = new Map();
  for (const [entryIndex, list] of offsets) {
    list.sort((a, b) => a - b);
    diagonals.set(entryIndex, list[list.length >> 1]);
  }
  return { counts, diagonals };
}

/**
 * Both strands seeded, the better one kept.
 *
 * "Better" is the higher best-seed-count, which is the same question the
 * checker answers when it decides a query was submitted as the reverse
 * complement, and it is settled here on the same evidence rather than trusting
 * the checker's placement -- which an indel can throw off.
 */
export function orientQuery(index, sequence) {
  const forward = seedCandidates(index, sequence);
  /* Both strands are always tried. An earlier version refused the reverse
     strand when the query held any letter that is not a nucleotide code, so a
     pasted "ORIGIN" line silently cost a reverse-strand sequence its match.
     reverseComplement turns such a letter into N, which seeds nothing and
     compares as compatible with everything, so it is harmless here. */
  const reverse = seedCandidates(index, reverseComplement(sequence));
  const bestOf = (seeded) => {
    let best = 0;
    for (const n of seeded.counts.values()) if (n > best) best = n;
    return best;
  };
  const forwardBest = bestOf(forward);
  const reverseBest = bestOf(reverse);
  if (reverseBest > forwardBest) {
    return { oriented: reverseComplement(sequence), orientation: "reverse", seeded: reverse };
  }
  return { oriented: sequence, orientation: "forward", seeded: forward };
}

/* ---------------------------------------------------------------------------
 * Step 2: alignment
 *
 * A global alignment with free end gaps, also called an overlap alignment.
 * Neither sequence is charged for the other starting earlier or ending later,
 * which is right for a barcode that may be truncated on either side or sitting
 * inside a much longer read.
 * --------------------------------------------------------------------------- */

/* Traceback directions. */
const DIAG = 0;
const UP = 1;    // a gap in the reference: the query has a base the reference lacks
const LEFT = 2;  // a gap in the query: the reference has a base the query lacks

/* Reused across calls so that aligning 300 candidates does not allocate 300
   matrices. Grown on demand and never shrunk. */
let scorePrev = new Int32Array(1024);
let scoreCur = new Int32Array(1024);
let traceBuffer = new Uint8Array(1024);

/**
 * Align two encoded sequences. Returns the score, the counts the table needs,
 * and the two aligned strings when `trace` is true.
 *
 * With `trace` false this is the ranking pass: it still fills the trace matrix
 * (the counts come from walking it back), but skips building the output
 * strings. The matrix is (m+1) x (n+1) bytes, about a quarter of a megabyte for
 * a barcode against a barcode.
 */
export function alignEncoded(query, reference, { trace = false } = {}) {
  const m = query.length;
  const n = reference.length;
  const cols = n + 1;
  if (scorePrev.length < cols) {
    scorePrev = new Int32Array(cols);
    scoreCur = new Int32Array(cols);
  }
  const need = (m + 1) * cols;
  if (traceBuffer.length < need) traceBuffer = new Uint8Array(need);
  const traceMatrix = traceBuffer;
  let prev = scorePrev;
  let cur = scoreCur;
  // Free leading gaps: the whole first row and first column are zero.
  prev.fill(0, 0, cols);
  traceMatrix.fill(LEFT, 0, cols);
  traceMatrix[0] = DIAG;
  let best = 0;
  let bestI = 0;
  let bestJ = 0;
  for (let i = 1; i <= m; i++) {
    const rowBase = i * cols;
    const queryRow = query[i - 1] * 16;
    cur[0] = 0;
    traceMatrix[rowBase] = UP;
    for (let j = 1; j <= cols - 1; j++) {
      let value = prev[j - 1] + SCORE[queryRow + reference[j - 1]];
      let direction = DIAG;
      const up = prev[j] + ALIGN_GAP;
      if (up > value) { value = up; direction = UP; }
      const left = cur[j - 1] + ALIGN_GAP;
      if (left > value) { value = left; direction = LEFT; }
      cur[j] = value;
      traceMatrix[rowBase + j] = direction;
    }
    // Free trailing gaps: an alignment may end anywhere in the last column...
    if (cur[n] >= best) { best = cur[n]; bestI = i; bestJ = n; }
    const swap = prev; prev = cur; cur = swap;
  }
  // ...or anywhere in the last row. `prev` now holds row m.
  for (let j = 0; j <= n; j++) {
    if (prev[j] > best) { best = prev[j]; bestI = m; bestJ = j; }
  }
  return walkBack(query, reference, traceMatrix, cols, bestI, bestJ, best, trace);
}

/**
 * Walk the traceback and count what the table reports.
 *
 *   comparable  columns where both sides are one concrete base -- the only
 *               positions that are evidence either way
 *   mismatches  comparable columns whose bases differ
 *   matches     columns whose symbols are compatible, ambiguous ones included
 *   queryGaps   gap columns in the query (the reference has a base it lacks)
 *   refGaps     gap columns in the reference (the query has an extra base)
 */
function walkBack(query, reference, traceMatrix, cols, endI, endJ, score, trace) {
  let i = endI;
  let j = endJ;
  let matches = 0;
  let mismatches = 0;
  let comparable = 0;
  let ambiguousMatches = 0;
  let queryGaps = 0;
  let refGaps = 0;
  let length = 0;
  let firstGapColumn = 0;
  const qOut = trace ? [] : null;
  const rOut = trace ? [] : null;
  const marks = trace ? [] : null;
  while (i > 0 && j > 0) {
    const direction = traceMatrix[i * cols + j];
    if (direction === DIAG) {
      const a = query[i - 1];
      const b = reference[j - 1];
      const bothConcrete = CODE_CONCRETE[a] && CODE_CONCRETE[b];
      const compatible = (CODE_BITS[a] & CODE_BITS[b]) !== 0;
      if (bothConcrete) {
        comparable++;
        if (compatible) { matches++; if (trace) marks.push("|"); }
        else { mismatches++; if (trace) marks.push(" "); }
      } else if (compatible) {
        matches++; ambiguousMatches++; if (trace) marks.push(":");
      } else {
        mismatches++; if (trace) marks.push(" ");
      }
      if (trace) { qOut.push(ALPHABET[a]); rOut.push(ALPHABET[b]); }
      i--; j--;
    } else if (direction === UP) {
      refGaps++;
      firstGapColumn = i;
      if (trace) { qOut.push(ALPHABET[query[i - 1]]); rOut.push("-"); marks.push(" "); }
      i--;
    } else {
      queryGaps++;
      firstGapColumn = i;
      if (trace) { qOut.push("-"); rOut.push(ALPHABET[reference[j - 1]]); marks.push(" "); }
      j--;
    }
    length++;
  }
  const result = {
    score,
    alignmentLength: length,
    matches,
    mismatches,
    comparable,
    ambiguousMatches,
    queryGaps,
    referenceGaps: refGaps,
    gaps: queryGaps + refGaps,
    // 1-based position in the aligned query slice where the first gap sits,
    // counting from its 5' end. Zero when the alignment has no gap.
    firstGapAt: firstGapColumn,
    queryStart: i + 1,
    queryEnd: endI,
    referenceStart: j + 1,
    referenceEnd: endJ
  };
  if (trace) {
    result.alignedQuery = qOut.reverse().join("");
    result.alignedReference = rOut.reverse().join("");
    result.marks = marks.reverse().join("");
  }
  return result;
}

/* ---------------------------------------------------------------------------
 * Step 3: ranking
 * --------------------------------------------------------------------------- */

/**
 * Sort key for one aligned candidate. Lower sorts first. This is the rule from
 * `_neighbor_rank` in the curator-side checker, with gaps folded in:
 *
 *   1. An identical alignment -- no mismatches AND no gaps -- over at least
 *      `identityFloor` comparable positions wins. This is the rule that keeps a
 *      lineage MalAvi already holds from being presented as something novel.
 *      The floor is what makes "identical" mean something: without it, any
 *      gapless mismatch-free scrap sat in this tier, so a 4-column chance
 *      alignment scored 100 % (found in review, 2026-09-16), and a 210 bp
 *      lineage contained in the query sat above a 478/479 full-length
 *      relative whenever the short lineage was seeded. The caller passes
 *      min(MIN_COMPARABLE_TO_RANK, concrete bases in the query): the release's
 *      own standard of identity, or the whole query when it is shorter than
 *      that, so a short lineage fed back in still recognizes itself.
 *   2. Then references covering at least MIN_COMPARABLE_TO_RANK of the query's
 *      positions, before thinner ones. Ranking on rate alone lets a reference
 *      that overlaps in 20 positions win by having little to disagree over;
 *      that is how NECMON01 came to be reported as nearest to a 133-position
 *      Plasmodium in 2026-08-20.
 *   3. Then the rate of disagreement, counting a gap column as a disagreement
 *      over one extra position, so an indel is not free.
 *   4. Then coverage, more first, and finally the lineage name, so the order is
 *      total and the same on every run.
 */
export function rankKey(alignment, identityFloor = MIN_COMPARABLE_TO_RANK) {
  const identical = alignment.mismatches === 0 && alignment.gaps === 0 &&
    alignment.comparable >= identityFloor;
  const wellCovered = alignment.comparable >= MIN_COMPARABLE_TO_RANK;
  const denominator = alignment.comparable + alignment.gaps;
  const rate = denominator > 0 ? (alignment.mismatches + alignment.gaps) / denominator : 1;
  return [identical ? 0 : 1, wellCovered ? 0 : 1, rate, -alignment.comparable];
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * The rows to show: the top N, extended so that every lineage tied with the
 * best hit is shown.
 *
 * "Tied" means the same mismatches, gaps and comparable count as the first row.
 * A short sequence can sit inside many lineages -- the 210 bp RBQ16 is
 * contained in 15 of them in this release -- and showing five of those fifteen
 * would name one lineage as if the query could tell it from the others.
 */
export function selectHits(ranked, topN) {
  if (!ranked.length) return [];
  if (!topN || topN >= ranked.length) return ranked.slice();
  const first = ranked[0];
  let tied = 0;
  while (tied < ranked.length &&
         ranked[tied].alignment.mismatches === first.alignment.mismatches &&
         ranked[tied].alignment.gaps === first.alignment.gaps &&
         ranked[tied].alignment.comparable === first.alignment.comparable) {
    tied++;
  }
  return ranked.slice(0, Math.max(topN, tied));
}

/* ---------------------------------------------------------------------------
 * One query, start to finish
 * --------------------------------------------------------------------------- */

/**
 * Slice a long query down to the region the seeds place in the barcode window.
 *
 * A mitochondrial genome is 5,700 bases of which 479 are the barcode; aligning
 * all of it against every candidate would be slow and would tell the reader
 * nothing about the other 5,200. The diagonal of the best-seeded candidate says
 * where the window sits, and the slice keeps a margin either side.
 */
export function sliceQuery(index, oriented, seeded, bestEntryIndex) {
  const width = index.windowLength;
  if (oriented.length <= width + 2 * SLICE_MARGIN) return { slice: oriented, offset: 0 };
  const diagonal = seeded.diagonals.get(bestEntryIndex);
  if (diagonal === undefined) return { slice: oriented, offset: 0 };
  /* The diagonal is in the reference's UNGAPPED coordinates. A short lineage
     is padded with leading gaps in the 479 bp window, so its first ungapped
     base may sit at window column 100; the window then starts that many
     bases earlier in the query than the diagonal alone says. */
  const gapped = index.entries[bestEntryIndex].seq || "";
  const leadingPad = gapped.length - gapped.replace(/^-+/, "").length;
  // Query position that sits at reference position 0 is -diagonal.
  const windowStart = -diagonal - leadingPad;
  const start = Math.max(0, windowStart - SLICE_MARGIN);
  const end = Math.min(oriented.length, start + width + 2 * SLICE_MARGIN);
  return { slice: oriented.slice(start, end), offset: start };
}

/**
 * The query as it will be aligned, and what was set aside to get there.
 *
 * cleanSequence keeps gap characters and any letter, because the submit page
 * reports on them. Here a `-` copied out of an alignment viewer is never
 * sequence, and would otherwise be aligned as an N that opens a false gap, so
 * it is removed; U is written as T so a transcribed sequence still seeds.
 * Letters that are not nucleotide codes are kept and align as N (no evidence
 * either way), and are counted so the page can say they were there.
 */
export function normalizeQuery(raw) {
  const cleaned = cleanSequence(raw);
  const content = countContent(cleaned);
  const sequence = cleaned.replace(/-/g, "").replace(/U/g, "T");
  return { sequence, content };
}

/**
 * Match one sequence against the release.
 *
 * Returns:
 *   sequence     the query as aligned: cleaned, gap characters removed, U as T
 *   content      what the cleaned paste held: unambiguous, ambiguous, gaps,
 *                invalid (letters that are not nucleotide codes), length
 *   orientation  "forward" or "reverse", decided on seed counts
 *   hits         the rows to show, each with its alignment
 *   ranked       every candidate that was aligned and passed the listing
 *                floor, ranked
 *   reason       why `hits` is empty, or null when it is not:
 *                  "empty"         nothing left after cleaning
 *                  "too-short"     fewer than MIN_COMPARABLE_TO_LIST concrete bases
 *                  "no-seeds"      no reference shares a 16-mer with it
 *                  "no-alignment"  candidates were aligned, none compared
 *                                  MIN_COMPARABLE_TO_LIST positions
 *   indel        null, or a description of the gap the best alignment needed
 *   candidates   how many references were aligned
 *   slice        {offset, length} of the query region aligned, for a long read
 */
export function matchSequence(index, raw, { topN = 5 } = {}) {
  const { sequence, content } = normalizeQuery(raw);
  const out = {
    sequence,
    content,
    orientation: "forward",
    hits: [],
    ranked: [],
    reason: null,
    indel: null,
    candidates: 0,
    slice: null
  };
  if (!sequence) { out.reason = "empty"; return out; }
  if (content.unambiguous < MIN_COMPARABLE_TO_LIST) { out.reason = "too-short"; return out; }

  const { oriented, orientation, seeded } = orientQuery(index, sequence);
  out.orientation = orientation;

  // The candidates: the most-seeded references, and every exact match the
  // checker found, so that a lineage the checker calls identical can never be
  // missing from this table.
  const bySeed = [...seeded.counts.entries()].sort((a, b) => b[1] - a[1]);
  const chosen = new Set(bySeed.slice(0, CANDIDATE_LIMIT).map(([entryIndex]) => entryIndex));
  const exact = findMatches(index, sequence);
  if (exact) {
    for (const candidate of [exact.best].concat(exact.ties || [])) {
      const at = index.entries.indexOf(candidate.entry);
      if (at >= 0) chosen.add(at);
    }
  }
  if (!chosen.size) { out.reason = "no-seeds"; return out; }

  const { slice, offset } = bySeed.length
    ? sliceQuery(index, oriented, seeded, bySeed[0][0])
    : { slice: oriented, offset: 0 };
  out.slice = { offset, length: slice.length };
  const encodedQuery = encodeSequence(slice);
  const references = encodedReferences(index);

  /* "Identical" has to cover the release's standard of identity, or the whole
     query when the query is shorter than that. Concrete bases only: an N in
     the query can never be a comparable column, so it is not asked for. */
  let concrete = 0;
  for (let i = 0; i < encodedQuery.length; i++) concrete += CODE_CONCRETE[encodedQuery[i]];
  const identityFloor = Math.min(MIN_COMPARABLE_TO_RANK, concrete);

  const ranked = [];
  for (const entryIndex of chosen) {
    const entry = index.entries[entryIndex];
    const alignment = alignEncoded(encodedQuery, references[entryIndex], { trace: false });
    /* The listing floor. A semi-global alignment always returns something; a
       few chance matches at one end of a reference are not a hit. */
    if (alignment.score < MIN_SCORE_TO_LIST || alignment.comparable < MIN_COMPARABLE_TO_LIST) continue;
    const key = rankKey(alignment, identityFloor);
    /* One row per lineage NAME. Where names share a sequence they share the
       alignment too, and each is listed, adjacent, rather than one standing in
       for the rest.

       Accession, genus and species are held per SEQUENCE in the index, as
       sorted sets over every lineage carrying it (export/build_sequence_index.R),
       not in the order of `names`. So a shared sequence lists the whole set on
       each of its rows, joined with " / ", the way the checker reports GenBank
       accessions. Indexing the sets by name position, as an earlier version
       did, put the wrong accession on a tied row or none at all: two of the
       seven shared sequences in the 2026-09-15 release have no accession. */
    const accession = (entry.acc || []).join(" / ");
    const genus = (entry.genus || []).join(" / ");
    const species = (entry.species || []).join(" / ");
    for (let k = 0; k < entry.names.length; k++) {
      ranked.push({
        name: entry.names[k],
        accession,
        genus,
        species,
        entry,
        entryIndex,
        alignment,
        key
      });
    }
  }
  ranked.sort((a, b) => compareKeys(a.key, b.key) ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  out.candidates = chosen.size;
  out.ranked = ranked;
  out.hits = selectHits(ranked, topN);
  if (!out.hits.length) { out.reason = "no-alignment"; return out; }

  /* The shown rows get the full alignment, for display and for the table's
     alignment columns. Only these: the ranking pass did not keep the strings.
     Names sharing one sequence share one alignment, traced once. */
  const traced = new Map();
  for (const hit of out.hits) {
    let alignment = traced.get(hit.entryIndex);
    if (!alignment) {
      alignment = alignEncoded(encodedQuery, references[hit.entryIndex], { trace: true });
      alignment.querySliceOffset = offset;
      traced.set(hit.entryIndex, alignment);
    }
    hit.alignment = alignment;
  }
  out.indel = describeIndel(out.hits, offset, orientation, sequence.length);
  return out;
}

/**
 * The gap in the best alignment, described so a submitter can go and look at
 * their read.
 *
 * Only the best hit is considered: a gap against some distant lineage says
 * nothing, while a gap against the nearest one is the thing worth checking.
 * The page displays none of this (it reaches no verdict); it is computed and
 * tested because the indel is the case the alignment-based ranking exists for.
 *
 * `position` is a 1-based position in the sequence AS SUBMITTED. The alignment
 * runs on the oriented query, so for a reverse-strand query the position is
 * turned round with `queryLength`, the length of the whole sequence aligned.
 */
export function describeIndel(hits, sliceOffset, orientation = "forward", queryLength = 0) {
  const best = hits[0];
  if (!best || !best.alignment || best.alignment.gaps < INDEL_MIN_GAPS) return null;
  const alignment = best.alignment;
  const positionInOriented = alignment.firstGapAt + (sliceOffset || 0);
  const position = orientation === "reverse" && queryLength
    ? queryLength - positionInOriented + 1
    : positionInOriented;
  return {
    lineage: best.name,
    gaps: alignment.gaps,
    // A gap in the query means the reference carries bases the query does not:
    // a deletion, from the query's point of view. The reverse is an insertion.
    kind: alignment.queryGaps >= alignment.referenceGaps ? "deletion" : "insertion",
    queryGaps: alignment.queryGaps,
    referenceGaps: alignment.referenceGaps,
    mismatches: alignment.mismatches,
    // Where to look, as a 1-based position in the sequence as submitted.
    position,
    // The same place in the oriented query, which is what the alignment shows.
    positionInOriented
  };
}

/** Every record in the pasted text, matched on its own. */
export function matchSequences(index, raw, options) {
  const records = splitFastaRecords(raw || "");
  if (!records.length) {
    return [{ name: "", result: matchSequence(index, "", options) }];
  }
  return records.map((record) => ({
    name: record.name,
    result: matchSequence(index, record.raw, options)
  }));
}

/* ---------------------------------------------------------------------------
 * Output
 * --------------------------------------------------------------------------- */

/**
 * One table row, in the Shiny app's column order and with its column names, so
 * that someone who used the app reads the same table here.
 *
 * Three columns are added at the end because they are what the ranking uses
 * and the app had no equivalent: Comparable (columns where both sides carry a
 * definite base), Differences (mismatches plus gaps), and AmbiguousMatches
 * (columns counted as a match only because an ambiguity code on one side is
 * compatible with the base on the other: R against A, N against anything).
 *
 * AmbiguousMatches is there so that a 100 % row can be read correctly. The
 * rule that a compatible code is a match is the submission checker's rule and
 * it stays, but without this column an R in the query against an A in the
 * release showed as identical with nothing to say it had been read that way
 * (Mélanie Duc, 2026-09-24: the WIMANET BLAST counted it a match and the old
 * MalAvi a difference, and this page gave no way to tell which it was doing).
 */
export function hitRow(hit) {
  const a = hit.alignment;
  const percent = a.alignmentLength
    ? Math.round((a.matches / a.alignmentLength) * 100000) / 1000
    : 0;
  return {
    Lineage: hit.name,
    ProportionMatch: `${a.matches}/${a.alignmentLength}`,
    PercentMatch: percent,
    AlignmentLength: a.alignmentLength,
    Matches: a.matches,
    Mismatches: a.mismatches,
    Score: a.score,
    QueryGapLength: a.queryGaps,
    ReferenceLineageLength: hit.entry.ungapped.length,
    Comparable: a.comparable,
    Differences: a.mismatches + a.gaps,
    AmbiguousMatches: a.ambiguousMatches,
    Genus: hit.genus,
    Accession: hit.accession
  };
}

export const TABLE_COLUMNS = [
  "Lineage", "ProportionMatch", "PercentMatch", "AlignmentLength", "Matches",
  "Mismatches", "Score", "QueryGapLength", "ReferenceLineageLength",
  "Comparable", "Differences", "AmbiguousMatches"
];

export const CSV_COLUMNS = ["Query"].concat(TABLE_COLUMNS, ["Genus", "Accession"]);

/**
 * One CSV cell. Quoted when it holds a quote, a comma or a line break of
 * either kind. A cell that a spreadsheet would read as a formula (starting
 * with =, +, @, or a - that is not a number) is prefixed with a single quote,
 * the usual defence against a Fasta header such as "=HYPERLINK(...)" being
 * executed when the file is opened. Negative scores stay numbers.
 */
export function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  const looksLikeFormula = /^[=+@]/.test(text) ||
    (/^-/.test(text) && !/^-?\d+(\.\d+)?$/.test(text));
  if (looksLikeFormula) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

/** The shown results as CSV, headed by what was run so the file stands alone. */
export function toCsv(index, records, { topN, when, page }) {
  const lines = [
    `# MalAvi BLAST (the site's sequence matcher; not NCBI BLAST). Release ${index.release}; ` +
      `${index.entries.length} reference sequences; window ${index.windowLength} bp; ` +
      `top N ${topN || "all"}; run ${when}; page ${page}`,
    `# Candidates aligned per query: up to ${CANDIDATE_LIMIT} by shared ${K}-mer count, ` +
      `plus every exact match. Alignment: overlap, free end gaps, ` +
      `match ${ALIGN_MATCH} mismatch ${ALIGN_MISMATCH} gap ${ALIGN_GAP}.`,
    `# Listed only when >= ${MIN_COMPARABLE_TO_LIST} comparable positions align ` +
      `with a score >= ${MIN_SCORE_TO_LIST}. ` +
      `Ranking: identical alignment over >= ${MIN_COMPARABLE_TO_RANK} positions (or the whole ` +
      `query when shorter) first; then references covering >= ${MIN_COMPARABLE_TO_RANK} ` +
      `positions; then rate of disagreement; then coverage.`,
    `# A position where an ambiguity code on one side is compatible with the base on the ` +
      `other (R vs A, N vs anything) counts as a match, as in the submission checker; ` +
      `AmbiguousMatches is how many of a row's Matches were counted that way.`,
    CSV_COLUMNS.join(",")
  ];
  records.forEach((record, i) => {
    const label = record.name || `query ${i + 1}`;
    for (const hit of record.result.hits) {
      const row = hitRow(hit);
      lines.push(CSV_COLUMNS
        .map((column) => csvCell(column === "Query" ? label : row[column]))
        .join(","));
    }
  });
  return lines.join("\n") + "\n";
}

/** The footer's one-line record of what was computed.

    It records the search, not a conclusion about it: no verdict field, because
    the page reaches no verdict. */
export function summaryLine(index, records, { topN, when, page }) {
  return [
    `Release=${index.release}`,
    `ReferenceN=${index.entries.length}`,
    `Window=${index.windowLength}`,
    `Queries=${records.length}`,
    `QueryLength=${records.map((r) => r.result.sequence.length).join("|")}`,
    `Orientation=${records.map((r) => r.result.orientation).join("|")}`,
    `CandidatesAligned=${records.map((r) => r.result.candidates).join("|")}`,
    `Listed=${records.map((r) => r.result.ranked.length).join("|")}`,
    `TopN=${topN || "all"}`,
    `Shown=${records.map((r) => r.result.hits.length).join("|")}`,
    `Scoring=${ALIGN_MATCH}/${ALIGN_MISMATCH}/${ALIGN_GAP}`,
    `MinListed=${MIN_COMPARABLE_TO_LIST}/${MIN_SCORE_TO_LIST}`,
    `Run=${when}`,
    `Page=${page}`
  ].join("; ");
}
