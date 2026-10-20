#!/usr/bin/env node
// Stand-in for the agy CLI. FAKE_AGY_MODE=old rejects --output-format like builds before 1.1.11.
const args = process.argv.slice(2);
const old = process.env.FAKE_AGY_MODE === "old";
if (args.includes("--output-format")) {
  if (old) { process.stderr.write("error: unknown option '--output-format'\n"); process.exit(2); }
  process.stdout.write(JSON.stringify({ status: "SUCCESS", command: { name: "usage", data: { groups: [
    { name: "Gemini Models", buckets: [{ id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.4, reset_time: "2026-10-20T04:42:34Z" }] }] } } }) + "\n");
} else if (args.includes("/quota")) {
  process.stdout.write("Loading…\nGemini Models\tWeekly Limit Remaining\t40%\t2026-10-20T04:42:34Z\n");
} else process.exit(3);
