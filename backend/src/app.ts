import Fastify, { type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import type pg from 'pg';
import { readFile } from 'node:fs/promises';
import { transaction } from './db.js';
import { digest, token, hashPassword, verifyPassword } from './security.js';

type Actor = { id: string; role: 'teacher' | 'student' | 'parent' };
declare module 'fastify' { interface FastifyRequest { actor: Actor; sessionHash: string } }
export class HttpError extends Error { constructor(public statusCode: number, message: string) { super(message); } }
const uuid = z.string().uuid();
const choices = z.array(z.string().trim().min(1).max(300)).min(2).max(6);
const params = (r: FastifyRequest) => z.object({ classId: uuid, id: uuid.optional() }).parse(r.params);

export async function buildApp(pool: pg.Pool, sessionHours = 8, behindProxy = false) {
 const app = Fastify({ bodyLimit: 16384, trustProxy: behindProxy ? (_address,hop) => hop===0 : false, logger: false, requestTimeout: 15000 });
 await app.register(helmet);
 await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
 const dummyHash = await hashPassword(token());
 app.setErrorHandler((error, req, reply) => {
  const e = error as Error & { code?: string; statusCode?: number };
  const status = e instanceof z.ZodError ? 400 : e.code === '23505' ? 409 : e.statusCode ?? 500;
  // Never log request URLs, bodies, credentials, aliases or SQL errors.
  if (status >= 500) console.error(JSON.stringify({ event: 'request_failed', requestId: req.id }));
  reply.code(status).send({ error: status >= 500 ? 'Internal server error' : status === 409 ? 'Conflict' : e instanceof HttpError ? e.message : 'Request rejected', requestId: req.id });
 });
 app.addHook('onSend', async (_req, reply) => { reply.header('Cache-Control','no-store'); });
 app.decorateRequest('actor', null as unknown as Actor);
 app.decorateRequest('sessionHash', '');
 // Explicit public shell allowlist: no filesystem traversal or directory listing.
 for (const [path,mime] of Object.entries({ 'index.html':'text/html; charset=utf-8', 'app.js':'text/javascript; charset=utf-8', 'styles.css':'text/css; charset=utf-8', 'manifest.webmanifest':'application/manifest+json', 'sw.js':'text/javascript; charset=utf-8', 'icon.svg':'image/svg+xml', 'icon-192.png':'image/png', 'icon-512.png':'image/png' })) {
  const contents = await readFile(new URL(`../public/${path}`,import.meta.url));
  app.get(path==='index.html' ? '/' : `/${path}`, async (_req,reply) => reply.type(mime).send(contents));
 }
 app.get('/health/live', async () => ({ status: 'ok' }));
 app.get('/health/ready', async () => { await pool.query('SELECT 1 FROM schema_migrations LIMIT 1'); return { status: 'ok' }; });
 app.post('/api/auth/login', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
  const b = z.object({ login: z.string().min(3).max(64).regex(/^[a-z0-9_-]+$/), password: z.string().min(1).max(128) }).strict().parse(req.body);
  // Shared persistent account limiter survives restarts and multiple API processes.
  const key = digest(b.login);
  const limit = await pool.query(`INSERT INTO login_limits(key,attempts,window_start) VALUES($1,1,now()) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN login_limits.window_start < now()-interval '15 minutes' THEN 1 ELSE login_limits.attempts+1 END, window_start=CASE WHEN login_limits.window_start < now()-interval '15 minutes' THEN now() ELSE login_limits.window_start END RETURNING attempts`,[key]);
  if (limit.rows[0].attempts > 10) throw new HttpError(429,'Try later');
  const u = (await pool.query('SELECT id,role,password_hash,active FROM users WHERE login=$1',[b.login])).rows[0];
  const valid = await verifyPassword(b.password,u?.password_hash ?? dummyHash);
  if (!u?.active || !valid) throw new HttpError(401,'Invalid credentials');
  const value = token();
  await pool.query(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+($3 * interval '1 hour'))`,[digest(value),u.id,sessionHours]);
  return reply.send({ token: value, tokenType: 'Bearer', expiresIn: sessionHours*3600 });
 });
 app.register(async api => {
  api.addHook('preHandler', async req => {
   const raw = req.headers.authorization;
   if (!raw || !/^Bearer [A-Za-z0-9_-]{43}$/.test(raw)) throw new HttpError(401,'Authentication required');
   req.sessionHash = digest(raw.slice(7));
   const actor = (await pool.query(`SELECT u.id,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active`,[req.sessionHash])).rows[0];
   if (!actor) throw new HttpError(401,'Authentication required');
   req.actor = actor;
  });
  const member = async (req: FastifyRequest, classId: string, role?: Actor['role']) => {
   if (role && req.actor.role !== role) throw new HttpError(403,'Forbidden');
   const found = await pool.query(`SELECT 1 FROM memberships m WHERE m.class_id=$1 AND m.user_id=$2 AND ($3 <> 'student' OR EXISTS(SELECT 1 FROM guardian_links g JOIN users p ON p.id=g.parent_id AND p.active WHERE g.student_id=$2)) AND ($3 <> 'parent' OR EXISTS(SELECT 1 FROM guardian_links g JOIN memberships child ON child.user_id=g.student_id AND child.class_id=$1 JOIN users s ON s.id=g.student_id AND s.active WHERE g.parent_id=$2))`,[classId,req.actor.id,req.actor.role]);
   if (!found.rowCount) throw new HttpError(404,'Class not found');
  };
  api.get('/api/me', async req => ({ user: req.actor }));
  api.post('/api/auth/logout', async (req, reply) => { await pool.query('DELETE FROM sessions WHERE token_hash=$1',[req.sessionHash]); return reply.code(204).send(); });
  api.get('/api/classes', async req => {
   const rows = (await pool.query('SELECT c.id,c.title FROM classes c JOIN memberships m ON m.class_id=c.id WHERE m.user_id=$1 ORDER BY c.id LIMIT 100',[req.actor.id])).rows;
   const visible = [];
   for (const row of rows) { try { await member(req,row.id); visible.push(row); } catch (e) { if (!(e instanceof HttpError)) throw e; } }
   return { classes: visible };
  });
  api.post('/api/classes', async (req, reply) => {
   if (req.actor.role !== 'teacher') throw new HttpError(403,'Forbidden');
   const b = z.object({ title: z.string().trim().min(1).max(80) }).strict().parse(req.body);
   const row = await transaction(pool,async db => {
    const c = (await db.query('INSERT INTO classes(title) VALUES($1) RETURNING id,title',[b.title])).rows[0];
    await db.query('INSERT INTO memberships(class_id,user_id) VALUES($1,$2)',[c.id,req.actor.id]); return c;
   }); return reply.code(201).send(row);
  });
  api.get('/api/classes/:classId/bank', async req => {
   const { classId } = params(req); await member(req,classId);
   return (await pool.query('SELECT c.goal::text AS goal, (SELECT COALESCE(sum(amount),0)::text FROM coin_ledger WHERE class_id=c.id) AS coins FROM classes c WHERE c.id=$1',[classId])).rows[0];
  });
  api.patch('/api/classes/:classId/goal', async req => {
   const { classId } = params(req); await member(req,classId,'teacher');
   const b = z.object({ goal: z.number().int().min(100).max(1000000) }).strict().parse(req.body);
   return (await pool.query('UPDATE classes SET goal=$2 WHERE id=$1 RETURNING goal::text',[classId,b.goal])).rows[0];
  });
  api.get('/api/classes/:classId/tasks', async req => {
   const { classId } = params(req); await member(req,classId);
   const q = z.object({ after: uuid.optional() }).parse(req.query);
   // Answer keys and other children's submissions are never returned.
   return { tasks: (await pool.query(`SELECT t.id,t.question,t.options,t.reward, CASE WHEN a.id IS NULL THEN NULL ELSE json_build_object('selectedIndex',a.selected_index,'correct',a.correct,'awarded',CASE WHEN a.correct THEN t.reward ELSE 0 END) END AS "myAnswer" FROM tasks t LEFT JOIN answers a ON a.task_id=t.id AND a.student_id=$3 WHERE t.class_id=$1 AND ($2::uuid IS NULL OR t.id>$2) ORDER BY t.id LIMIT 100`,[classId,q.after ?? null,req.actor.id])).rows };
  });
  api.post('/api/classes/:classId/tasks', async (req,reply) => {
   const { classId } = params(req); await member(req,classId,'teacher');
   const b = z.object({ question: z.string().trim().min(1).max(2000), options: choices, correctIndex: z.number().int().min(0), reward: z.number().int().min(1).max(1000) }).strict().refine(v=>v.correctIndex<v.options.length).parse(req.body);
   const row = (await pool.query('INSERT INTO tasks(class_id,created_by,question,options,correct_index,reward) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[classId,req.actor.id,b.question,JSON.stringify(b.options),b.correctIndex,b.reward])).rows[0];
   return reply.code(201).send(row);
  });
  api.post('/api/classes/:classId/tasks/:id/answers', async req => {
   const { classId,id } = params(req); await member(req,classId,'student');
   const b = z.object({ selectedIndex: z.number().int().min(0).max(5) }).strict().parse(req.body);
   return transaction(pool,async db => {
    const task = (await db.query('SELECT * FROM tasks WHERE id=$1 AND class_id=$2',[id,classId])).rows[0];
    if (!task) throw new HttpError(404,'Task not found');
    if (b.selectedIndex>=task.options.length) throw new HttpError(400,'Invalid option');
    // Unique(task_id,student_id) serializes concurrent submissions. First answer is final.
    const inserted = (await db.query(`INSERT INTO answers(task_id,class_id,student_id,selected_index,correct) VALUES($1,$2,$3,$4,$5) ON CONFLICT(task_id,student_id) DO NOTHING RETURNING id,correct,selected_index`,[id,classId,req.actor.id,b.selectedIndex,b.selectedIndex===task.correct_index])).rows[0];
    const answer = inserted ?? (await db.query('SELECT id,correct,selected_index FROM answers WHERE task_id=$1 AND student_id=$2',[id,req.actor.id])).rows[0];
    if (inserted?.correct) await db.query('INSERT INTO coin_ledger(class_id,answer_id,amount) VALUES($1,$2,$3)',[classId,answer.id,task.reward]);
    return { answerId: answer.id, correct: answer.correct, selectedIndex: answer.selected_index, awarded: answer.correct ? task.reward : 0, replayed: !inserted };
   });
  });
  api.post('/api/classes/:classId/polls', async (req,reply) => {
   const { classId } = params(req); await member(req,classId,'teacher');
   const b = z.object({ title: z.string().trim().min(1).max(200), audience: z.enum(['student','parent']), options: choices, closesAt: z.iso.datetime({ offset:true }) }).strict().refine(v=>Date.parse(v.closesAt)>Date.now() && Date.parse(v.closesAt)<Date.now()+90*86400000).parse(req.body);
   return reply.code(201).send((await pool.query('INSERT INTO polls(class_id,created_by,title,audience,options,closes_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[classId,req.actor.id,b.title,b.audience,JSON.stringify(b.options),b.closesAt])).rows[0]);
  });
  api.get('/api/classes/:classId/polls', async req => {
   const { classId } = params(req); await member(req,classId);
   const q = z.object({ after: uuid.optional() }).parse(req.query);
   return { polls: (await pool.query(`SELECT p.id,p.title,p.audience,p.options,p.closes_at,v.option_index AS "myVote" FROM polls p LEFT JOIN votes v ON v.poll_id=p.id AND v.user_id=$4 WHERE p.class_id=$1 AND (p.audience=$2 OR $2='teacher') AND ($3::uuid IS NULL OR p.id>$3) ORDER BY p.id LIMIT 100`,[classId,req.actor.role,q.after ?? null,req.actor.id])).rows };
  });
  api.post('/api/classes/:classId/polls/:id/votes', async (req,reply) => {
   const { classId,id } = params(req); await member(req,classId);
   const b = z.object({ optionIndex: z.number().int().min(0).max(5) }).strict().parse(req.body);
   await transaction(pool,async db => {
    const p = (await db.query('SELECT * FROM polls WHERE id=$1 AND class_id=$2 FOR SHARE',[id,classId])).rows[0];
    if (!p) throw new HttpError(404,'Poll not found');
    if (p.audience!==req.actor.role) throw new HttpError(403,'Forbidden');
    if (b.optionIndex>=p.options.length) throw new HttpError(400,'Invalid option');
    // Database clock checked in the write, no dependence on API host time.
    const result = await db.query(`INSERT INTO votes(poll_id,user_id,option_index) SELECT $1,$2,$3 WHERE EXISTS(SELECT 1 FROM polls WHERE id=$1 AND closes_at>clock_timestamp()) ON CONFLICT(poll_id,user_id) DO UPDATE SET option_index=excluded.option_index WHERE EXISTS(SELECT 1 FROM polls WHERE id=$1 AND closes_at>clock_timestamp()) RETURNING poll_id`,[id,req.actor.id,b.optionIndex]);
    if (!result.rowCount) throw new HttpError(409,'Poll closed');
   }); return reply.code(204).send();
  });
  api.get('/api/classes/:classId/polls/:id/results', async req => {
   const { classId,id } = params(req); await member(req,classId,'teacher');
   if (!(await pool.query('SELECT 1 FROM polls WHERE id=$1 AND class_id=$2',[id,classId])).rowCount) throw new HttpError(404,'Poll not found');
   return { counts: (await pool.query('SELECT option_index,count(*)::int AS votes FROM votes WHERE poll_id=$1 GROUP BY option_index ORDER BY option_index',[id])).rows };
  });
 });
 return app;
}
