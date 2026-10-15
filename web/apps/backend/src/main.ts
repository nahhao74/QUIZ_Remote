import { createApp } from './app';
async function main() { const app = await createApp(); await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0'); }
void main().catch(() => { console.error(JSON.stringify({ event: 'startup_failed', message: 'Check PostgreSQL, migrations and required environment configuration.' })); process.exitCode = 1; });
