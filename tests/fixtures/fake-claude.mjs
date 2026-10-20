#!/usr/bin/env node
// Stand-in for the Claude Code engine in tests. FAKE_CLAUDE_MODE picks the answer;
// FAKE_CLAUDE_PROFILE, when set, is rewritten mid-query to simulate a login change.
import { writeFileSync } from "node:fs";
const mode = process.env.FAKE_CLAUDE_MODE ?? "max";
const args = process.argv.slice(2);
if (args[0] === "auth") {
  process.stdout.write(JSON.stringify({ loggedIn: mode !== "signed-out", authMethod: "claude.ai" }) + "\n");
  process.exit(0);
}
if (process.env.CLAUDE_CODE_ENTRYPOINT !== "quotacheck" || !args.includes("--input-format")) process.exit(3);
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  const nl = buf.indexOf("\n");
  if (nl < 0) return;
  const req = JSON.parse(buf.slice(0, nl));
  if (req.request?.subtype !== "get_usage") process.exit(4);
  // Chatter before the answer, as the real engine prints init lines.
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\n");
  if (mode === "account-change") writeFileSync(process.env.FAKE_CLAUDE_PROFILE, JSON.stringify({ oauthAccount: { accountUuid: "other", organizationUuid: "org" } }));
  const response = mode === "error"
    ? { subtype: "error", request_id: req.request_id, error: "boom" }
    : { subtype: "success", request_id: req.request_id, response: mode === "max" || mode === "account-change"
      ? { subscription_type: "max", rate_limits_available: true, rate_limits: { five_hour: { utilization: 21, resets_at: "2026-09-07T10:20:00.182540+00:00" }, seven_day: { utilization: 70, resets_at: "2026-09-12T18:00:00.182559+00:00" }, seven_day_opus: null, extra_usage: { is_enabled: false } } }
      : { subscription_type: null, rate_limits_available: false, rate_limits: {} } };
  process.stdout.write(JSON.stringify({ type: "control_response", response }) + "\n");
});
