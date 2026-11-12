import type { MediaType, ParsedItem } from "./gemini";

/**
 * Deterministic parser for the inbox template:
 *   Title (Type) | Status: Completed | Consumed: 2026 | Recommender: Justin | Notes: loved it
 * A line it recognises never reaches a model. Anything else returns null and goes to the model.
 */
const TYPE_WORDS: Record<string, MediaType> = {
  movie: "Movie",
  film: "Movie",
  tv: "TV",
  show: "TV",
  series: "TV",
  "tv show": "TV",
  "tv series": "TV",
  anime: "TV",
  book: "Book",
  novel: "Book",
  game: "Game",
  "video game": "Game",
  podcast: "Podcast",
  "one-off": "One-Off",
  "one off": "One-Off",
};

const CONSUMED = /\b(complete|completed|finished|watched|read|played|listened|done)\b/i;

function year(v: string): number | null {
  const m = /\b(1[89]\d\d|20\d\d)\b/.exec(v);
  return m ? Number(m[1]) : null;
}

function rating(v: string): number | null {
  const m = /(\d+(?:\.\d+)?)/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 5 && Number.isInteger(n * 2) ? n : null;
}

export function parseStructuredLine(line: string, lineIndex: number): ParsedItem | null {
  const parts = line.split("|").map((p) => p.trim());
  const head = parts[0] ?? "";
  const fields = parts.slice(1).filter((p) => p !== "");
  // The template always has at least one "Key: value" segment. Plain lines belong to the model.
  if (fields.length === 0 || !fields.every((f) => /^[A-Za-z][A-Za-z ]{0,30}:/.test(f))) return null;

  let title = head;
  let mediaType: MediaType | null = null;
  let yearHint: number | null = null;
  const paren = /^(.*\S)\s*\(([^()]+)\)$/.exec(head);
  if (paren) {
    let used = false;
    for (const bit of paren[2]!.split(",").map((b) => b.trim())) {
      const t = TYPE_WORDS[bit.toLowerCase()];
      if (t) {
        mediaType = t;
        used = true;
      } else if (/^(1[89]\d\d|20\d\d)$/.test(bit)) {
        yearHint = Number(bit);
        used = true;
      }
    }
    if (used) title = paren[1]!;
  }

  let recommender = "";
  let consumed = false;
  let consumedYear: number | null = null;
  let myRating: number | null = null;
  const notes: string[] = [];
  for (const f of fields) {
    const i = f.indexOf(":");
    const key = f.slice(0, i).trim().toLowerCase();
    const value = f.slice(i + 1).trim();
    if (key === "recommender" || key === "recommended by" || key === "from") recommender = value;
    else if (key === "notes" || key === "note") {
      if (value) notes.push(value);
    } else if (key === "type" || key === "media type") mediaType = TYPE_WORDS[value.toLowerCase()] ?? mediaType;
    else if (key === "year") yearHint = year(value) ?? yearHint;
    else if (key === "consumed" || key === "consumed year" || key === "finished") {
      consumedYear = year(value);
      consumed = consumed || value !== "";
    } else if (key === "rating" || key === "my rating") {
      myRating = rating(value);
      consumed = consumed || myRating !== null;
    } else if (key === "status") {
      if (CONSUMED.test(value)) consumed = true;
      else if (value && !/^backlog$/i.test(value)) notes.push(`Status: ${value}`);
    } else if (value) notes.push(`${f.slice(0, i).trim()}: ${value}`);
  }

  title = title.trim();
  // No type means the template was not followed closely enough: let the model classify it.
  if (!title || title.length > 300 || !mediaType) return null;
  const name = recommender || "Self";
  return {
    lineIndex,
    title,
    yearHint,
    mediaType,
    isAlreadyConsumed: consumed,
    recommenderName: name,
    trustWeight: name.toLowerCase() === "justin" ? 5 : 3,
    myRating,
    consumedYear,
    personalNotes: notes.join(" | ").slice(0, 2000),
    alternativeMatchesNote: "",
  };
}
