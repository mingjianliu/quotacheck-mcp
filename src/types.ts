export type SourceId =
  | "claude-code"
  | "gemini-web"
  | "antigravity";

export const ALL_SOURCES: SourceId[] = [
  "claude-code",
  "gemini-web",
  "antigravity",
];

export interface Bucket {
  used: number;
  limit: number;
  pct: number;
  resetsAt?: string;
}

export interface SubModelBucket extends Bucket {
  name: string;
  /**
   * Buckets that share one underlying limit, e.g. Antigravity meters Gemini
   * models and Claude/GPT models as two groups. Drives the overview tiles.
   */
  group?: string;
}

export interface QuotaSnapshot {
  source: SourceId;
  collectedAt: string;
  session?: Bucket;
  weekly?: Bucket;
  subModels?: SubModelBucket[];
  error?: string;
}

export interface Collector {
  source: SourceId;
  collect(ctx: CollectorContext): Promise<QuotaSnapshot>;
}

export interface CollectorContext {
  chromeProfilePath: string;
  chromeExecutablePath?: string;
  playwrightTimeoutMs: number;
  homeDir: string;
  /** Antigravity CLI used to read quota. Defaults to "agy". */
  antigravityUsageBinary?: string;
  /** Defaults to true when unset. */
  historyEnabled?: boolean;
  /** Defaults to DEFAULT_RETENTION_DAYS when unset. */
  historyRetentionDays?: number;
}
