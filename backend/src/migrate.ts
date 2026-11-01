import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { createPool, transaction } from './db.js';
export async function migrate(pool: ReturnType<typeof createPool>) {
 await transaction(pool, async db => {
  await db.query('SELECT pg_advisory_xact_lock(81943021)');
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const version of ['001_initial','002_runtime_permissions','003_class_goal']) {
   if (!(await db.query('SELECT 1 FROM schema_migrations WHERE version=$1',[version])).rowCount) {
    await db.query(await readFile(new URL(`../migrations/${version}.sql`, import.meta.url),'utf8'));
    await db.query('INSERT INTO schema_migrations(version) VALUES($1)',[version]);
   }
  }
 });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
 const pool = createPool(config().connectionString);
 try { await migrate(pool); console.log('Migrations applied'); } finally { await pool.end(); }
}
