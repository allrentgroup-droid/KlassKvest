import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, transaction } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { buildApp } from '../src/app.js';
import { hashPassword, verifyPassword, digest } from '../src/security.js';

test('password hashing uses unique salts and verifies safely',async()=>{
 const a=await hashPassword('test-passphrase-123'); const b=await hashPassword('test-passphrase-123');
 assert.notEqual(a,b); assert(await verifyPassword('test-passphrase-123',a)); assert.equal(await verifyPassword('wrong',a),false);
 assert.equal(await verifyPassword('wrong','broken'),false);
});

// Integration tests require a disposable PostgreSQL database; never use production.
const database = process.env.DATABASE_URL;
test('PostgreSQL API integration', { skip: !database }, async t => {
 const pool=createPool(database!);
 await pool.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='klasskvest_app') THEN CREATE ROLE klasskvest_app; END IF; END $$");
 await migrate(pool); await migrate(pool); // reentrant migrations
 const app=await buildApp(pool);
 const suffix=randomUUID().slice(0,8);
 const ids: Record<string,string>={}; const tokens: Record<string,string>={};
 const password='integration-secret-123'; const hash=await hashPassword(password);
 const call=async(method:'GET'|'POST'|'PATCH',url:string,who?:string,body?:unknown)=>app.inject({method,url,headers:{...(who?{authorization:`Bearer ${tokens[who]}`}:{})},...(body ? {payload:body as object}:{}),remoteAddress:`10.0.0.${Object.keys(ids).indexOf(who??'')+2}`});
 let classId='',otherClass='',taskId='';
 try {
  for (const [name,role] of [['teacher','teacher'],['outsider','teacher'],['student','student'],['student2','student'],['parent','parent'],['stranger','student'],['unconsented','student']]) {
   ids[name!]=(await pool.query('INSERT INTO users(login,role,alias,password_hash) VALUES($1,$2,$3,$4) RETURNING id',[`${name}_${suffix}`,role,name,hash])).rows[0].id;
   const r=await call('POST','/api/auth/login',name,{login:`${name}_${suffix}`,password}); assert.equal(r.statusCode,200,r.body); tokens[name!]=r.json().token;
  }
  await t.test('anonymous requests and forged sessions fail',async()=>{
   assert.equal((await call('GET','/api/classes')).statusCode,401);
   const r=await app.inject({url:'/api/me',headers:{authorization:`Bearer ${'a'.repeat(43)}`}}); assert.equal(r.statusCode,401);
  });
  await t.test('login stores hashed tokens and hides credential errors',async()=>{
   const s=(await pool.query('SELECT token_hash FROM sessions WHERE user_id=$1',[ids.teacher])).rows[0]; assert.equal(s.token_hash,digest(tokens.teacher!)); assert.notEqual(s.token_hash,tokens.teacher);
   const bad=await call('POST','/api/auth/login','teacher',{login:`teacher_${suffix}`,password:'wrong'}); assert.equal(bad.statusCode,401); assert(!bad.body.includes('password_hash'));
  });
  await t.test('class creation requires teacher role',async()=>{
   assert.equal((await call('POST','/api/classes','student',{title:'Forbidden'})).statusCode,403);
   const c=await call('POST','/api/classes','teacher',{title:'Pilot'}); assert.equal(c.statusCode,201,c.body); classId=c.json().id;
   otherClass=(await call('POST','/api/classes','outsider',{title:'Other'})).json().id;
   for (const who of ['student','student2','parent','unconsented']) await pool.query('INSERT INTO memberships VALUES($1,$2)',[classId,ids[who]]);
   for (const who of ['student','student2']) await pool.query('INSERT INTO guardian_links(parent_id,student_id,consent_reference) VALUES($1,$2,$3)',[ids.parent,ids[who],'test-consent']);
  });
  await t.test('class isolation, parental link and consent are mandatory',async()=>{
   for(const who of ['outsider','stranger','unconsented']) assert.equal((await call('GET',`/api/classes/${classId}/bank`,who)).statusCode,404);
   assert.equal((await call('GET',`/api/classes/${otherClass}/bank`,'parent')).statusCode,404);
   assert.equal((await call('GET',`/api/classes/${classId}/bank`,'parent')).statusCode,200);
   assert.equal((await call('GET','/api/classes','unconsented')).json().classes.length,0);
  });
  const taskBody={question:'2+2?',options:['4','5'],correctIndex:0,reward:30};
  await t.test('task creation validates data and forbids client role escalation',async()=>{
   assert.equal((await call('POST',`/api/classes/${classId}/tasks`,'student',taskBody)).statusCode,403);
   assert.equal((await call('POST',`/api/classes/${classId}/tasks`,'teacher',{...taskBody,reward:1001})).statusCode,400);
   assert.equal((await call('POST',`/api/classes/${classId}/tasks`,'teacher',{...taskBody,correctIndex:2})).statusCode,400);
   assert.equal((await call('POST',`/api/classes/${classId}/tasks`,'teacher',{...taskBody,role:'teacher'})).statusCode,400);
   const r=await call('POST',`/api/classes/${classId}/tasks`,'teacher',taskBody); assert.equal(r.statusCode,201,r.body); taskId=r.json().id;
  });
  await t.test('task list never exposes keys or child identities',async()=>{
   const r=await call('GET',`/api/classes/${classId}/tasks`,'student'); assert.equal(r.statusCode,200);
   assert.deepEqual(Object.keys(r.json().tasks[0]).sort(),['id','myAnswer','options','question','reward']);
   assert.equal(r.json().tasks[0].myAnswer,null);
  });
  const answerUrl=()=>`/api/classes/${classId}/tasks/${taskId}/answers`;
  await t.test('concurrent repeated correct answers credit exactly once',async()=>{
   const responses=await Promise.all(Array.from({length:8},()=>call('POST',answerUrl(),'student',{selectedIndex:0})));
   responses.forEach(r=>assert.equal(r.statusCode,200,r.body));
   assert.equal(responses.filter(r=>!r.json().replayed).length,1);
   assert.equal((await call('GET',`/api/classes/${classId}/bank`,'parent')).json().coins,'30');
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM coin_ledger WHERE class_id=$1',[classId])).rows[0].n,1);
  });
  await t.test('wrong first answer remains final and never earns coins',async()=>{
   assert.equal((await call('POST',answerUrl(),'student2',{selectedIndex:1})).json().awarded,0);
   const retry=await call('POST',answerUrl(),'student2',{selectedIndex:0}); assert.equal(retry.json().correct,false); assert.equal(retry.json().replayed,true);
   assert.equal((await call('GET',`/api/classes/${classId}/bank`,'teacher')).json().coins,'30');
  });
  await t.test('task history contains only the requesting student answer',async()=>{
   const own=(await call('GET',`/api/classes/${classId}/tasks`,'student')).json().tasks[0];
   const other=(await call('GET',`/api/classes/${classId}/tasks`,'student2')).json().tasks[0];
   assert.deepEqual(own.myAnswer,{selectedIndex:0,correct:true,awarded:30});
   assert.deepEqual(other.myAnswer,{selectedIndex:1,correct:false,awarded:0});
   const parent=(await call('GET',`/api/classes/${classId}/tasks`,'parent')).json().tasks[0]; assert.equal(parent.myAnswer,null);
  });
  await t.test('class goal changes require its teacher and preserve balance',async()=>{
   const path=`/api/classes/${classId}/goal`;
   assert.equal((await call('PATCH',path,'student',{goal:100})).statusCode,403);
   assert.equal((await call('PATCH',path,'parent',{goal:100})).statusCode,403);
   assert.equal((await call('PATCH',path,'outsider',{goal:100})).statusCode,404);
   assert.equal((await call('PATCH',path,'teacher',{goal:1})).statusCode,400);
   assert.equal((await call('PATCH',path,'teacher',{goal:100})).statusCode,200);
   assert.deepEqual((await call('GET',`/api/classes/${classId}/bank`,'student')).json(),{coins:'30',goal:'100'});
  });
  await t.test('answer RBAC and task/class mismatch are enforced',async()=>{
   assert.equal((await call('POST',answerUrl(),'parent',{selectedIndex:0})).statusCode,403);
   assert.equal((await call('POST',`/api/classes/${otherClass}/tasks/${taskId}/answers`,'student',{selectedIndex:0})).statusCode,404);
   assert.equal((await call('POST',answerUrl(),'student',{selectedIndex:5})).statusCode,400);
  });
  await t.test('transaction rollback prevents partial credit',async()=>{
   const before=(await pool.query('SELECT count(*)::int AS n FROM coin_ledger WHERE class_id=$1',[classId])).rows[0].n;
   await assert.rejects(transaction(pool,async db=>{ await db.query('INSERT INTO classes(title) VALUES($1)',['rollback']); throw new Error('rollback'); }));
   assert.equal((await pool.query("SELECT count(*)::int AS n FROM classes WHERE title='rollback'")).rows[0].n,0);
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM coin_ledger WHERE class_id=$1',[classId])).rows[0].n,before);
   const faultTask=(await call('POST',`/api/classes/${classId}/tasks`,'teacher',taskBody)).json().id;
   const fn=`test_ledger_fail_${suffix}`;
   await pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated storage failure'; END $$`);
   await pool.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON coin_ledger FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
   try {
    const failed=await call('POST',`/api/classes/${classId}/tasks/${faultTask}/answers`,'student',{selectedIndex:0});
    assert.equal(failed.statusCode,500); assert(!failed.body.includes('simulated'));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM answers WHERE task_id=$1',[faultTask])).rows[0].n,0);
   } finally { await pool.query(`DROP TRIGGER ${fn} ON coin_ledger`); await pool.query(`DROP FUNCTION ${fn}()`); }
   assert.equal((await call('POST',`/api/classes/${classId}/tasks/${faultTask}/answers`,'student',{selectedIndex:0})).json().awarded,30);
  });
  await t.test('runtime database role cannot mutate identities or ledger history',async()=>{
   await transaction(pool,async db=>{ await db.query('SET LOCAL ROLE klasskvest_app'); assert.equal((await db.query('SELECT count(*) FROM coin_ledger')).rowCount,1); });
   for(const sql of ["UPDATE users SET role='teacher'",'DELETE FROM coin_ledger','UPDATE coin_ledger SET amount=999','DELETE FROM guardian_links']) {
    await assert.rejects(transaction(pool,async db=>{ await db.query('SET LOCAL ROLE klasskvest_app'); await db.query(sql); }), (e:unknown)=>(e as {code:string}).code==='42501');
   }
  });
  await t.test('separate student/parent polls, replaceable single votes, closed polls',async()=>{
   for (const audience of ['student','parent']) {
    const r=await call('POST',`/api/classes/${classId}/polls`,'teacher',{title:'Choice',audience,options:['A','B'],closesAt:new Date(Date.now()+60000).toISOString()}); assert.equal(r.statusCode,201,r.body);
    const poll=r.json().id,url=`/api/classes/${classId}/polls/${poll}/votes`;
    assert.equal((await call('POST',url,audience==='student'?'parent':'student',{optionIndex:0})).statusCode,403);
    assert.equal((await call('POST',url,audience,{optionIndex:0})).statusCode,204);
    assert.equal((await call('POST',url,audience,{optionIndex:1})).statusCode,204);
    const visible=(await call('GET',`/api/classes/${classId}/polls`,audience)).json().polls;
    assert.equal(visible.find((p:{id:string})=>p.id===poll).myVote,1);
    if(audience==='student') assert.equal((await call('GET',`/api/classes/${classId}/polls`,'student2')).json().polls.find((p:{id:string})=>p.id===poll).myVote,null);
    const results=await call('GET',`/api/classes/${classId}/polls/${poll}/results`,'teacher'); assert.deepEqual(results.json().counts,[{option_index:1,votes:1}]);
    assert.equal((await call('GET',`/api/classes/${classId}/polls/${poll}/results`,audience)).statusCode,403);
    await pool.query("UPDATE polls SET closes_at=now()-interval '1 second' WHERE id=$1",[poll]);
    assert.equal((await call('POST',url,audience,{optionIndex:0})).statusCode,409);
   }
  });
  await t.test('administrator sandbox switches rotate sessions and isolate real classes',async()=>{
   assert.equal((await call('POST','/api/admin/switch-role','outsider',{role:'student'})).statusCode,403);
   assert.equal((await call('GET','/api/admin/overview','parent')).statusCode,403);
   await pool.query('UPDATE users SET is_admin=true WHERE id=$1',[ids.outsider]);
   assert.equal((await call('GET','/api/admin/overview','outsider')).statusCode,200);
   const original=tokens.outsider;
   const runtimeUrl=new URL(database!); runtimeUrl.searchParams.set('options','-c role=klasskvest_app');
   const runtimePool=createPool(runtimeUrl.toString()); const runtimeApp=await buildApp(runtimePool);
   const switched=await runtimeApp.inject({method:'POST',url:'/api/admin/switch-role',headers:{authorization:`Bearer ${tokens.outsider}`},payload:{role:'student'}});
   await runtimeApp.close(); await runtimePool.end();
   assert.equal(switched.statusCode,200,switched.body);
   assert.equal((await call('GET','/api/me','outsider')).statusCode,401);
   tokens.outsider=switched.json().token;
   const demo=(await call('GET','/api/me','outsider')).json().user;
   assert.equal(demo.role,'student'); assert.equal(demo.testRole,true);
   assert.equal(demo.administratorId,ids.outsider);
   assert.equal((await call('GET','/api/admin/overview','outsider')).statusCode,403);
   assert.equal((await call('GET',`/api/classes/${classId}/bank`,'outsider')).statusCode,404);
   const dc=(await call('GET','/api/classes','outsider')).json().classes;
   assert.equal(dc.length,1);
   const dt=(await call('GET',`/api/classes/${dc[0].id}/tasks`,'outsider')).json().tasks[0];
   assert.equal((await call('POST',`/api/classes/${dc[0].id}/tasks/${dt.id}/answers`,'outsider',{selectedIndex:0})).json().awarded,10);
   for (const role of ['parent','teacher','admin']) {
    const r=await call('POST','/api/admin/switch-role','outsider',{role}); assert.equal(r.statusCode,200,r.body); tokens.outsider=r.json().token;
    assert.equal((await call('GET','/api/me','outsider')).json().user.role,role==='admin'?'teacher':role);
   }
   assert.notEqual(tokens.outsider,original);
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM admin_events WHERE administrator_id=$1',[ids.outsider])).rows[0].n,4);
   const r=await call('POST','/api/admin/switch-role','outsider',{role:'student'});tokens.outsider=r.json().token;
   await pool.query('UPDATE users SET is_admin=false WHERE id=$1',[ids.outsider]);
   assert.equal((await call('GET','/api/me','outsider')).statusCode,401);
   await pool.query('DELETE FROM sessions WHERE administrator_id=$1',[ids.outsider]);
   const demos=(await pool.query('SELECT user_id FROM admin_demo_accounts WHERE administrator_id=$1',[ids.outsider])).rows.map(x=>x.user_id);
   const demoClasses=(await pool.query('SELECT DISTINCT class_id FROM memberships WHERE user_id=ANY($1::uuid[])',[demos])).rows.map(x=>x.class_id);
   await pool.query('DELETE FROM votes WHERE user_id=ANY($1::uuid[])',[demos]);
   for(const table of ['polls','coin_ledger','answers','tasks','memberships','classes']) await pool.query(`DELETE FROM ${table} WHERE ${table==='classes'?'id':'class_id'}=ANY($1::uuid[])`,[demoClasses]);
   await pool.query('DELETE FROM guardian_links WHERE parent_id=ANY($1::uuid[])',[demos]);
   await pool.query('DELETE FROM admin_demo_accounts WHERE administrator_id=$1',[ids.outsider]);
   await pool.query('DELETE FROM admin_events WHERE administrator_id=$1',[ids.outsider]);
   await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[demos]);
   tokens.outsider=(await call('POST','/api/auth/login','outsider',{login:`outsider_${suffix}`,password})).json().token;
  });
  await t.test('revoking consent removes access immediately',async()=>{
   await pool.query('DELETE FROM guardian_links WHERE student_id=$1',[ids.student]);
   assert.equal((await call('GET',`/api/classes/${classId}/bank`,'student')).statusCode,404);
  });
  await t.test('expired, logged out and disabled sessions are rejected',async()=>{
   assert.equal((await call('POST','/api/auth/logout','parent')).statusCode,204);
   assert.equal((await call('GET','/api/me','parent')).statusCode,401);
   await pool.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",[ids.teacher]);
   assert.equal((await call('GET','/api/me','teacher')).statusCode,401);
   await pool.query('UPDATE users SET active=false WHERE id=$1',[ids.student2]);
   assert.equal((await call('GET','/api/me','student2')).statusCode,401);
  });
  await t.test('malformed IDs and oversized input are rejected without internals',async()=>{
   const r=await call('GET','/api/classes/not-uuid/bank','outsider'); assert.equal(r.statusCode,400); assert(!r.body.includes('SELECT'));
   const large=await call('POST','/api/classes','outsider',{title:'a'.repeat(20000)}); assert.equal(large.statusCode,413);
  });
  await t.test('public shell has strict CSP while API remains protected',async()=>{
   const home=await app.inject({url:'/'}); assert.equal(home.statusCode,200); assert(home.body.includes('КлассКвест')); assert(home.headers['content-security-policy']?.includes("script-src 'self'"));
   for(const path of ['/app.js','/styles.css','/manifest.webmanifest','/icon-192.png','/icon-512.png','/sw.js']) assert.equal((await app.inject({url:path})).statusCode,200,path);
   assert.equal((await app.inject({url:'/src/app.ts'})).statusCode,404);
   assert.equal((await app.inject({url:'/api/me'})).statusCode,401);
  });
 } finally {
  await app.close();
  const classes=[classId,otherClass].filter(Boolean);
  if(classes.length) {
   await pool.query('DELETE FROM votes WHERE poll_id IN (SELECT id FROM polls WHERE class_id=ANY($1::uuid[]))',[classes]);
   for(const table of ['polls','coin_ledger','answers','tasks','memberships','classes']) await pool.query(`DELETE FROM ${table} WHERE ${table==='classes'?'id':'class_id'}=ANY($1::uuid[])`,[classes]);
  }
  await pool.query('DELETE FROM guardian_links WHERE parent_id=ANY($1::uuid[]) OR student_id=ANY($1::uuid[])',[Object.values(ids)]);
  await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[Object.values(ids)]);
  await pool.end();
 }
});


