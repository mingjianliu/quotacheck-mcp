import { homedir } from 'node:os';
import { getLegacyQuotas } from '../src/query.js';
import { refreshSources } from '../src/tools.js';
const home = process.env.QUOTACHECK_HOME ?? homedir();
if (process.argv.includes('--force') || process.argv.includes('-f')) {
  const result = await refreshSources(home);
  console.error(JSON.stringify(result));
}
console.log(JSON.stringify(getLegacyQuotas(home)));
