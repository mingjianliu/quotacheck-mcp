import { homedir } from 'node:os';
import { callTool } from '../src/tools.js';
const home = process.env.QUOTACHECK_HOME ?? homedir();
for (const name of ['get_status', 'get_quotas']) {
  const result = await callTool(home, name);
  console.log(name, result.content[0].text);
}
