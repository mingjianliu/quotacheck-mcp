export function parseCli(args: string[]) {
    const command = args[0] ?? 'help';
    const input: Record<string, unknown> = {};
    let home: string | undefined;
    let id: string | undefined;
    const list: Record<string, string> = { 'sources': 'sources', 'account-keys': 'accountKeys', 'limit-ids': 'limitIds' };
    const strings: Record<string, string> = { from: 'from', to: 'to', granularity: 'granularity', cursor: 'cursor' };
    for (let i = 1; i < args.length; i++) {
        if (command === 'export' && !args[i].startsWith('--') && !id) {
            id = args[i];
            continue;
        }
        const key = args[i].replace(/^--/, '');
        if (args[i] === '--refresh' && command === 'legacy') {
            input.refresh = true;
            continue;
        }
        if (args[i] === '--include-raw') {
            input.includeRaw = true;
            continue;
        }
        if (!args[i].startsWith('--') || !['home', 'page-size', 'days', ...Object.keys(list), ...Object.keys(strings)].includes(key))
            throw Error(`Unknown argument: ${args[i]}`);
        const value = args[++i];
        if (!value || value.startsWith('--'))
            throw Error(`Missing value for --${key}`);
        if (key === 'home')
            home = value;
        else if (key === 'page-size' || key === 'days') {
            const n = Number(value);
            if (!Number.isSafeInteger(n) || n < 1)
                throw Error(`Invalid --${key}`);
            input[key === 'days' ? 'days' : 'pageSize'] = n;
        }
        else if (list[key])
            input[list[key]] = value.split(',').filter(Boolean);
        else
            input[strings[key]] = value;
    }
    return { command, input, home, id };
}
