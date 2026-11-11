// Shared builders for the 50-line intake spike (no network).
export const MEDIA_TYPES = ['Movie', 'TV', 'Book', 'Game', 'Podcast', 'One-Off'];
const enc = new TextEncoder();

export function syntheticLines(n = 50) {
  const kinds = ['movie', 'show', 'book', 'game', 'podcast'];
  return Array.from({ length: n }, (_, i) =>
    `  ${kinds[i % 5]} rec #${i}: The Example Title Number ${i} (${1990 + (i % 35)}) - Justin said it is great, watch with Sam  `);
}

export function normaliseLine(line) {
  return line.trim().toLowerCase();
}

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Synthetic Gemini structured-output response string, one item per line. */
export function syntheticGeminiJson(n = 50) {
  const items = Array.from({ length: n }, (_, i) => ({
    title: `The Example Title Number ${i}`,
    yearHint: i % 7 === 0 ? null : 1990 + (i % 35),
    mediaType: MEDIA_TYPES[i % MEDIA_TYPES.length],
    isAlreadyConsumed: i % 4 === 0,
    recommenderName: i % 3 === 0 ? 'Justin' : 'Self',
    trustWeight: i % 3 === 0 ? 5 : 3,
    myRating: i % 4 === 0 ? 4.5 : null,
    consumedYear: i % 4 === 0 ? 2020 + (i % 5) : null,
    personalNotes: 'Recommended in conversation; said the second half is much stronger than the first. Watch before the sequel.',
    alternativeMatchesNote: i % 5 === 0 ? 'Also matches a 1987 film and a 2015 TV series of the same name.' : '',
    sourceLineIndex: i,
  }));
  return JSON.stringify({ items });
}

export function validateItem(item, lineCount = Infinity) {
  const errors = [];
  if (typeof item?.title !== 'string' || !item.title.trim()) errors.push('title');
  if (!(item.yearHint === null || Number.isInteger(item.yearHint))) errors.push('yearHint');
  if (!MEDIA_TYPES.includes(item.mediaType)) errors.push('mediaType');
  if (typeof item.isAlreadyConsumed !== 'boolean') errors.push('isAlreadyConsumed');
  if (typeof item.recommenderName !== 'string') errors.push('recommenderName');
  if (!Number.isInteger(item.trustWeight) || item.trustWeight < 1 || item.trustWeight > 5) errors.push('trustWeight');
  if (!(item.myRating === null || (item.myRating >= 1 && item.myRating <= 5 && item.myRating * 2 === Math.round(item.myRating * 2)))) errors.push('myRating');
  if (!(item.consumedYear === null || Number.isInteger(item.consumedYear))) errors.push('consumedYear');
  if (typeof item.personalNotes !== 'string') errors.push('personalNotes');
  if (typeof item.alternativeMatchesNote !== 'string') errors.push('alternativeMatchesNote');
  if (!Number.isInteger(item.sourceLineIndex) || item.sourceLineIndex < 0 || item.sourceLineIndex >= lineCount) errors.push('sourceLineIndex');
  return { ok: errors.length === 0, errors };
}

export function mergeKey(item) {
  return `${item.title.trim().toLowerCase()}|${item.mediaType}|${item.yearHint ?? ''}`;
}

/** Parameter arrays for 3 insert statements per item (media_items, activity_log, intake_log). */
export function buildInsertParams(items, lines, hashes, source = 'webhook', now = new Date().toISOString()) {
  const media = [];
  const activity = [];
  const intake = [];
  items.forEach((it, i) => {
    const id = `itm_${i.toString(16).padStart(8, '0')}`;
    const status = it.isAlreadyConsumed ? 'Completed' : 'Backlog';
    media.push([id, it.title, lines[it.sourceLineIndex], it.yearHint, it.mediaType, status, 'PENDING', it.recommenderName, 1,
      it.trustWeight, it.personalNotes, it.myRating, it.consumedYear, it.alternativeMatchesNote, Number(Boolean(it.myRating)), now, now, now]);
    activity.push([id, it.title, it.mediaType, 'CREATED', null, status, 3, 14, now]);
    intake.push([hashes[it.sourceLineIndex], lines[it.sourceLineIndex], source, now]);
  });
  return { media, activity, intake };
}

/** The whole simulated intake CPU path for one batch. */
export async function runIntakeBatch(lines, geminiJson) {
  const hashes = await Promise.all(lines.map((l) => sha256Hex(normaliseLine(l))));
  const parsed = JSON.parse(geminiJson);
  const valid = [];
  for (const it of parsed.items) if (validateItem(it, lines.length).ok) valid.push(it);
  const seen = new Map();
  for (const it of valid) {
    const k = mergeKey(it);
    if (!seen.has(k)) seen.set(k, it);
  }
  const unique = [...seen.values()];
  const params = buildInsertParams(unique, lines, hashes);
  return { hashes, validCount: valid.length, params, statementCount: params.media.length + params.activity.length + params.intake.length };
}
