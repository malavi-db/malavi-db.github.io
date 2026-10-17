/* =============================================================================
 * board.mjs
 * -----------------------------------------------------------------------------
 * The curators' board: decrypting it, and putting what it says into words.
 *
 * WHAT THE BOARD IS
 *   One file, assets/data/board.json, written by curation/build_status_board.py
 *   from the review ledger. It says where every submission stands: its state,
 *   which curator recorded which verdict, what it is waiting on and since when,
 *   and where its report is. It is published ENCRYPTED, because this site is
 *   static and its repository is public, so nothing here can be kept from a
 *   reader except by encryption. The board page asks for a shared password and
 *   decrypts in the browser; nothing is sent anywhere.
 *
 * WHAT THE ENCRYPTION IS
 *   AES-256-GCM. The key is derived from the password with PBKDF2-HMAC-SHA256,
 *   using the salt and the iteration count carried in the file. Both are the
 *   browser's own WebCrypto, with no library. A wrong password fails the GCM
 *   authentication tag, which is how "wrong password" is told from "opened".
 *   The format is written by malavi_curation.status_board.encrypt, and a test on
 *   the Python side decrypts its output with THIS module under Node, so the two
 *   cannot drift apart unnoticed.
 *
 * WHAT IS NOT HERE
 *   No submitter's name, no reason for any verdict, no lineage name. The file
 *   does not carry them (see status_board.py), so this module could not show
 *   them if it tried.
 *
 * Pure functions with no DOM access, so all of it runs under Node. See
 * tests/test_board.mjs.
 * ============================================================================= */

/** Decode base64 into bytes, in the browser and under Node alike. */
function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* What decryptBoard throws. `code` lets the page say the right thing without
   matching on message text: "password" for a password that does not open the
   file, "format" for a file this module does not understand, "unsupported" when
   the browser has no WebCrypto (an insecure origin, in practice). */
export class BoardError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Open the encrypted board with a password. Resolves to the board's data.
 *
 * `envelope` is the parsed board.json. `subtle` is the WebCrypto SubtleCrypto
 * to use; it defaults to the platform's own and is a parameter only so a test
 * can pass Node's.
 */
export async function decryptBoard(envelope, password, subtle) {
  const crypto = subtle || (globalThis.crypto && globalThis.crypto.subtle);
  if (!crypto) {
    throw new BoardError("unsupported",
      "This browser will not decrypt here. Open the page over https.");
  }
  if (!envelope || envelope.v !== 1 || envelope.cipher !== "AES-256-GCM" ||
      envelope.kdf !== "PBKDF2-HMAC-SHA256" || !envelope.salt || !envelope.iv ||
      !envelope.ciphertext || !(Number(envelope.iterations) > 0)) {
    throw new BoardError("format", "The board file is not in a form this page reads.");
  }

  const material = await crypto.importKey(
    "raw", new TextEncoder().encode(String(password)), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: fromBase64(envelope.salt),
      iterations: Number(envelope.iterations) },
    material, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);

  let plain;
  try {
    plain = await crypto.decrypt(
      { name: "AES-GCM", iv: fromBase64(envelope.iv) }, key, fromBase64(envelope.ciphertext));
  } catch (err) {
    // AES-GCM authenticates: the wrong key cannot produce plausible garbage, it
    // fails outright. So a failure here is the password (or a damaged file).
    throw new BoardError("password", "That password does not open the board.");
  }
  try {
    return JSON.parse(new TextDecoder().decode(plain));
  } catch (err) {
    throw new BoardError("format", "The board opened but its contents could not be read.");
  }
}

/* ---- words ------------------------------------------------------------------
   The ledger's state names, as a curator would say them. */
const STATE_WORDS = {
  received: "Received, not screened yet",
  screening_failed: "Screening could not finish",
  ready_for_review: "Ready for review",
  in_review: "In review",
  held: "Flagged",
  awaiting_submitter: "Waiting for the submitter",
  approved: "Accepted",
  released: "Released",
  declined: "Declined",
  withdrawn: "Withdrawn",
  dormant: "Dormant"
};

export function stateWords(state) {
  return STATE_WORDS[state] || String(state || "");
}

/** "2026-10-04" from any timestamp the board carries; "" for none. */
export function dayOf(stamp) {
  const when = new Date(stamp);
  return Number.isNaN(when.getTime()) ? "" : when.toISOString().slice(0, 10);
}

/** "2026-10-04 21:50 UTC": for the one moment that matters to the hour. */
export function momentOf(stamp) {
  const when = new Date(stamp);
  return Number.isNaN(when.getTime())
    ? "" : when.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/** Whole days from `stamp` to `now`, never negative; null if `stamp` is unreadable. */
export function daysSince(stamp, now = new Date()) {
  const when = new Date(stamp);
  if (Number.isNaN(when.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - when.getTime()) / 86400000));
}

/** "today", "1 day", "12 days". */
export function daysWords(days) {
  if (days === null || days === undefined) return "";
  if (days === 0) return "today";
  return days === 1 ? "1 day" : `${days} days`;
}

/**
 * What a submission is waiting on, in words, as of `now`.
 *
 * The builder writes a code and its facts; the sentence is made here so that
 * the one thing that depends on when the page is read -- whether the hold after
 * an acceptance has run out -- is decided at reading time, not at build time.
 *
 * Returns { who, text }: `who` is the short answer to "whose move is it?"
 * (a curator, a lead curator, the submitter, the maintainer; empty while a hold
 * is running, when it is nobody's) and `text` is the sentence.
 */
export function waitingWords(waiting, now = new Date()) {
  const w = waiting || {};
  switch (w.code) {
    case "screening":
      return { who: "the maintainer", text: "The automated checks have not run yet." };
    case "verdict":
      return { who: "a curator", text: "No verdict has been recorded on this revision." };
    case "flag":
      return {
        who: "the submitter, or " + (w.by || "the curator who flagged it"),
        text: `Flag ${w.flag || ""} by ${w.by || "a curator"} stands. It ends when the ` +
          "submitter's answer comes in as a new revision, when the flag is withdrawn, or " +
          "when a lead curator clears it."
      };
    case "correction_approval":
      return { who: "a lead curator",
               text: `Correction ${w.correction || ""} is waiting for a lead curator's approval.` };
    case "correction_recording":
      return { who: "the maintainer",
               text: `Correction ${w.correction || ""} is approved and has to be recorded and applied.` };
    case "submitter":
      return { who: "the submitter", text: "A question was put to the submitter." };
    case "hold": {
      const ends = new Date(w.ends);
      if (!Number.isNaN(ends.getTime()) && now.getTime() < ends.getTime()) {
        // Nobody's move: the hold is a wait, so there is no "waiting on" to name.
        return {
          who: "",
          text: `Accepted. The ${w.hours || 72}-hour hold, in which any curator can still ` +
            `flag it, ends ${momentOf(w.ends)}.`
        };
      }
      return { who: "the maintainer",
               text: "Accepted and the hold has ended. Next: the name confirmation to the " +
                 "submitter, then the next release." };
    }
    default:
      return { who: "", text: "" };
  }
}

/** One verdict as a phrase: "V1 flagged by A Curator, 2026-10-01". */
export function verdictWords(verdict) {
  const base = `${verdict.id} ${verdict.verdict} by ${verdict.curator}, ${dayOf(verdict.at)}`;
  return verdict.standing ? base : `${base} (${verdict.ended || "no longer standing"})`;
}

/**
 * Only an https link to the two Google hosts the board links to is rendered as
 * a link. The file is ours, but it is also decrypted input, and a link is the
 * one place where its content becomes something a click acts on.
 */
export function safeLink(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (parsed.protocol !== "https:") return "";
    return ["drive.google.com", "docs.google.com"].includes(parsed.hostname) ? parsed.href : "";
  } catch (err) {
    return "";
  }
}
