// Spike 3: CPU cost of serialising media_items rows into a Sheets values.batchUpdate body.
import { coldAndWarm, printTable, f, isMain } from './measure.mjs';

export const COLUMNS = [
  'id', 'title', 'raw_input', 'year_hint', 'media_type', 'status', 'enrichment_status', 'enrichment_attempts',
  'enrichment_error', 'tmdb_id', 'imdb_id', 'igdb_id', 'isbn13', 'itunes_id', 'source_url', 'recommender_name',
  'recommender_count', 'trust_weight', 'personal_notes', 'my_rating', 'personal_tier', 'review_text', 'review_done',
  'consumed_year', 'completed_at', 'creator', 'release_year', 'release_date', 'release_state', 'release_access_display',
  'streaming_providers_json', 'genres_json', 'is_available_now', 'critic_score', 'critic_score_display',
  'time_commitment_display', 'time_commitment_minutes', 'amazon_link', 'poster_image_url', 'alternative_matches_note',
  'category_metadata_json', 'priority_score', 'last_status_change_at', 'last_enriched_at', 'created_at', 'updated_at',
];

// Columns exported to the sheet (about 26, per the brief): the human-useful subset of 4.1.
export const SHEET_COLUMNS = [
  'id', 'title', 'year_hint', 'media_type', 'status', 'recommender_name', 'recommender_count', 'trust_weight',
  'personal_notes', 'my_rating', 'personal_tier', 'review_text', 'consumed_year', 'completed_at', 'creator',
  'release_year', 'release_state', 'streaming_providers_json', 'genres_json', 'critic_score_display',
  'time_commitment_display', 'amazon_link', 'poster_image_url', 'alternative_matches_note', 'priority_score',
  'updated_at',
];

const TYPES = ['Movie', 'TV', 'Book', 'Game', 'Podcast', 'One-Off'];
const STATUSES = ['Backlog', 'Up Next', 'Active', 'Paused', 'Completed', 'Abandoned', 'Archived'];

export function syntheticRows(n) {
  const iso = '2026-11-11T12:00:00.000Z';
  return Array.from({ length: n }, (_, i) => ({
    id: `itm_${i.toString(16).padStart(8, '0')}`,
    title: `The Example Title Number ${i}: A Longer Subtitle`,
    raw_input: `rec from Sam: The Example Title Number ${i} - said it is great`,
    year_hint: 1990 + (i % 35),
    media_type: TYPES[i % 6],
    status: STATUSES[i % 7],
    enrichment_status: 'ENRICHED',
    enrichment_attempts: 1,
    enrichment_error: null,
    tmdb_id: String(100000 + i), imdb_id: `tt${1000000 + i}`, igdb_id: null, isbn13: null, itunes_id: null,
    source_url: `https://example.com/title/${i}`,
    recommender_name: 'Justin, Sam',
    recommender_count: 2,
    trust_weight: 5,
    personal_notes: 'Recommended in conversation; said the second half is much stronger than the first. Watch before the sequel.',
    my_rating: i % 3 === 0 ? 4.5 : null,
    personal_tier: i % 3 === 0 ? 'A' : null,
    review_text: i % 3 === 0 ? 'Smart, funny, a little long. The ending lands and the lead performance carries the weaker middle section.' : '',
    review_done: i % 3 === 0,
    consumed_year: i % 3 === 0 ? 2024 : null,
    completed_at: i % 3 === 0 ? iso : null,
    creator: 'Some Director Name',
    release_year: 1990 + (i % 35),
    release_date: `${1990 + (i % 35)}-06-15`,
    release_state: 'Streaming',
    release_access_display: 'Streaming on 2 services',
    streaming_providers_json: JSON.stringify([{ name: 'Netflix', type: 'flatrate' }, { name: 'Max', type: 'flatrate' }]),
    genres_json: JSON.stringify(['Drama', 'Comedy', 'Science Fiction']),
    is_available_now: true,
    critic_score: 82.5,
    critic_score_display: '8.3/10 IMDb, 91% RT',
    time_commitment_display: '2h 14m',
    time_commitment_minutes: 134,
    amazon_link: `https://www.amazon.com/s?k=The%20Example%20Title%20Number%20${i}`,
    poster_image_url: `https://image.tmdb.org/t/p/w500/abcdefghijklmnopqrstuvwxyz${i}.jpg`,
    alternative_matches_note: i % 5 === 0 ? 'Also matches a 1987 film and a 2015 TV series of the same name.' : '',
    category_metadata_json: JSON.stringify({ runtimeMinutes: 134, cast: ['A Actor', 'B Actor', 'C Actor'], tagline: 'A tagline goes here.' }),
    priority_score: 77.5,
    last_status_change_at: iso, last_enriched_at: iso, created_at: iso, updated_at: iso,
  }));
}

export function rowToValues(row) {
  return SHEET_COLUMNS.map((c) => {
    const v = row[c];
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return v;
  });
}

const HEADERS = SHEET_COLUMNS;

/** Three tabs; each tab receives the full row set here (worst case: every row appears on each tab). */
export function buildBatchUpdateBody(rows) {
  const values = [HEADERS, ...rows.map(rowToValues)];
  const tab = (name) => ({ range: `${name}!A1`, majorDimension: 'ROWS', values });
  return {
    valueInputOption: 'RAW',
    data: ['Library_Archive', 'Active_Queue', 'Curated_Lists'].map(tab),
  };
}

export function serialise(rows) {
  return JSON.stringify(buildBatchUpdateBody(rows));
}

async function main() {
  const rows300 = syntheticRows(300);
  const rows1000 = syntheticRows(1000);
  const r300 = await coldAndWarm(async () => serialise(rows300), 200);
  const r1000 = await coldAndWarm(async () => serialise(rows1000), 200);
  const kb = (rows) => (serialise(rows).length / 1024).toFixed(0);
  console.log(`node ${process.version}  v8 ${process.versions.v8}  sheet columns: ${SHEET_COLUMNS.length}`);
  const row = (label, kbv, r) => ({
    rows: label, body_kb: kbv, cold: f(r.cold.cpuMs), warm_mean: f(r.warmCpu.mean), warm_p50: f(r.warmCpu.p50),
    warm_p95: f(r.warmCpu.p95), warm_max: f(r.warmCpu.max),
  });
  printTable('Sheets batchUpdate serialise (3 tabs, all rows on each tab), CPU ms; budget 10 ms per invocation', [
    row('300', kb(rows300), r300),
    row('1000', kb(rows1000), r1000),
  ]);
  const perRow = r1000.warmCpu.mean / 1000;
  console.log(`\nExtrapolation (linear, from 1000-row warm mean ${f(r1000.warmCpu.mean)} ms): ${f(perRow * 1000)} ms/1000 rows; warm mean would pass 5 ms at about ${Math.round(5 / perRow)} rows.`);
}

if (isMain(import.meta.url)) await main();
