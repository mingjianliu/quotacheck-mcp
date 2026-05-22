export type SourceId =
  | "claude-code"
  | "gemini-cli"
  | "gemini-web"
  | "claude-design"
  | "antigravity";

export const ALL_SOURCES: SourceId[] = [
  "claude-code",
  "gemini-cli",
  "gemini-web",
  "claude-design",
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
  antigravityUsageBinary: string;
  homeDir: string;
}
