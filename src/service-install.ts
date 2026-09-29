import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dataDirectory, privateDirectory } from './store.js';
const LABEL = 'com.quotacheck.poller';
function xml(s: string) { return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
export function launchdPlist(node: string, cli: string, home: string) {
    const logs = dataDirectory(home);
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${[node, cli, 'daemon', '--home', home].map(s => `<string>${xml(s)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(`${join(home, '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)}</string></dict>
<key>StandardOutPath</key><string>${xml(join(logs, 'daemon.stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(logs, 'daemon.stderr.log'))}</string>
</dict></plist>\n`;
}
export function installService(home: string, node: string, cli: string) {
    if (process.platform !== 'darwin')
        throw Error('install-service currently supports macOS launchd; run quotacheck daemon under your process manager');
    privateDirectory(dataDirectory(home));
    const agents = join(home, 'Library', 'LaunchAgents');
    mkdirSync(agents, { recursive: true });
    const path = join(agents, `${LABEL}.plist`);
    writeFileSync(path, launchdPlist(node, cli, home), { mode: 0o600 });
    for (const name of ['daemon.stdout.log', 'daemon.stderr.log'])
        writeFileSync(join(dataDirectory(home), name), '', { mode: 0o600, flag: 'a' });
    const domain = `gui/${process.getuid!()}`;
    try {
        execFileSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'pipe' });
    }
    catch { /* first installation */ }
    execFileSync('launchctl', ['bootstrap', domain, path], { stdio: 'pipe' });
    return path;
}
