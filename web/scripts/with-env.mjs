// Keep all pnpm commands portable without committing or printing environment secrets.
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
if (existsSync('.env')) process.loadEnvFile('.env');
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Missing command');
const child = spawn(command, args, { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
