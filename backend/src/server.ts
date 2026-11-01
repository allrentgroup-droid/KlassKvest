import { config } from './config.js';
import { createPool } from './db.js';
import { buildApp } from './app.js';
const env = config();
const pool = createPool(env.connectionString);
const app = await buildApp(pool,env.SESSION_HOURS,env.NODE_ENV==='production');
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,async()=>{ await app.close(); await pool.end(); });
try { await app.listen({ host:'0.0.0.0',port:env.PORT }); }
catch { console.error('Server startup failed'); await pool.end(); process.exitCode=1; }
