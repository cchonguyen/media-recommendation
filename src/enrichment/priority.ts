export interface PriorityInput {
  trustWeight: number;
  criticScore: number | null;
  recommenderCount: number;
  isAvailableNow: boolean;
  /** ISO date or datetime. Preferred over releaseYear. */
  releaseDate?: string | null;
  /** Used only when releaseDate is missing: treated as 31 December of that year. */
  releaseYear?: number | null;
}

const DAY_MS = 86_400_000;

function releasedWithinYear(input: PriorityInput, now: Date): boolean {
  let t: number | null = null;
  if (input.releaseDate) {
    const parsed = Date.parse(input.releaseDate);
    if (!Number.isNaN(parsed)) t = parsed;
  }
  if (t === null && input.releaseYear != null) t = Date.UTC(input.releaseYear, 11, 31);
  if (t === null) return false;
  const age = now.getTime() - t;
  return age >= 0 && age <= 365 * DAY_MS;
}

/** Spec 4.7. Clamped to 0..100 and rounded to one decimal. */
export function computePriorityScore(input: PriorityInput, now: Date): number {
  const trustPoints = (input.trustWeight / 5) * 50;
  const criticPoints = ((input.criticScore ?? 70) / 100) * 30;
  const multiRecommenderBonus = Math.min(Math.max(input.recommenderCount - 1, 0), 2) * 5;
  const recencyBonus = input.isAvailableNow && releasedWithinYear(input, now) ? 10 : 0;
  const total = trustPoints + criticPoints + multiRecommenderBonus + recencyBonus;
  return Math.round(Math.min(100, Math.max(0, total)) * 10) / 10;
}
