import type { Db } from "../google/token";
import { setCachedValue } from "../google/token";

export const LAST_INBOX_SYNC_KEY = "last_inbox_sync";
/** Far-future Unix seconds so the stamp never expires from system_kv. */
export const NEVER_EXPIRES = 4102444800;

const pacificYear = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric" });

export function pacificYearOf(date: Date): number {
  return Number(pacificYear.format(date));
}

export async function recordInboxSync(db: Db, now: Date): Promise<void> {
  await setCachedValue(db, LAST_INBOX_SYNC_KEY, now.toISOString(), NEVER_EXPIRES);
}
