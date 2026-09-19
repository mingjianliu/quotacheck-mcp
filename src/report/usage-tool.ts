import { readHistory } from "../history.js";
import type { SourceId } from "../types.js";
import { buildUsageHistory, type UsageHistory } from "./usage.js";
import { renderUsageText } from "./usage-text.js";

/**
 * Fixed at a week: weekly limits reset every seven days, so this window always
 * holds the whole of the current weekly cycle plus the tail of the one before.
 */
export const USAGE_WINDOW_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface UsageQuery {
  sources?: SourceId[];
  now?: Date;
  utcOffsetMin?: number;
}

export function getUsageHistory(
  homeDir: string,
  query: UsageQuery = {},
): { text: string; history: UsageHistory } {
  const until = query.now ?? new Date();
  const since = new Date(until.getTime() - USAGE_WINDOW_DAYS * DAY_MS);
  const history = buildUsageHistory(
    readHistory(homeDir, { since, until, sources: query.sources }),
    { since, until, utcOffsetMin: query.utcOffsetMin },
  );
  return { text: renderUsageText(history), history };
}
