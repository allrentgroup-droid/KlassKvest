import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';
import { digest, hashPassword, token } from './security.js';

// Each administrator gets their own isolated sandbox. Never impersonate a real child.
export async function switchRole(pool: pg.Pool, administratorId: string, role: 'admin'|'teacher'|'student'|'parent', sessionHash: string) {
 const inaccessiblePassword = await hashPassword(token());
 return transaction(pool,async db=>{
  const owner=await db.query('SELECT id FROM users WHERE id=$1 AND active AND is_admin FOR UPDATE',[administratorId]);
  if (!owner.rowCount) return null;
  // Lock and validate the actual session too: parallel switches cannot reuse it.
  const session=await db.query('SELECT user_id,administrator_id FROM sessions WHERE token_hash=$1 AND expires_at>now() FOR UPDATE',[sessionHash]);
  if (!session.rowCount || (session.rows[0].administrator_id ?? session.rows[0].user_id)!==administratorId) return null;
  if (role!=='admin') {
   const existing=await db.query('SELECT role,user_id FROM admin_demo_accounts WHERE administrator_id=$1',[administratorId]);
   if (!existing.rowCount) {
    const users: Record<string,string>={};
    for (const r of ['teacher','student','parent']) {
     const u=await db.query('INSERT INTO users(login,role,alias,password_hash) VALUES($1,$2,$3,$4) RETURNING id',[`demo_${randomUUID().replaceAll('-','')}`,r,`Demo ${r}`,inaccessiblePassword]);
     users[r]=u.rows[0].id;
     await db.query('INSERT INTO admin_demo_accounts VALUES($1,$2,$3)',[administratorId,r,users[r]]);
    }
    const c=(await db.query("INSERT INTO classes(title) VALUES('Тестовый класс администратора') RETURNING id")).rows[0].id;
    for (const user of Object.values(users)) await db.query('INSERT INTO memberships VALUES($1,$2)',[c,user]);
    await db.query("INSERT INTO guardian_links(parent_id,student_id,consent_reference) VALUES($1,$2,'synthetic-demo-no-real-child')",[users.parent,users.student]);
    await db.query("INSERT INTO tasks(class_id,created_by,question,options,correct_index,reward) VALUES($1,$2,'Тест: сколько будет 2 + 2?','[\"4\",\"5\"]',0,10)",[c,users.teacher]);
    for (const audience of ['student','parent']) await db.query("INSERT INTO polls(class_id,created_by,title,audience,options,closes_at) VALUES($1,$2,'Тест: выбираем приключение',$3,'[\"Музей\",\"Парк\"]',now()+interval '90 days')",[c,users.teacher,audience]);
   }
  }
  const userId=role==='admin' ? administratorId : (await db.query('SELECT user_id FROM admin_demo_accounts WHERE administrator_id=$1 AND role=$2',[administratorId,role])).rows[0].user_id;
  const value=token();
  await db.query("INSERT INTO sessions(token_hash,user_id,administrator_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[digest(value),userId,role==='admin'?null:administratorId]);
  await db.query('DELETE FROM sessions WHERE token_hash=$1',[sessionHash]);
  await db.query('INSERT INTO admin_events(administrator_id,action) VALUES($1,$2)',[administratorId,role==='admin'?'return_admin':`switch_${role}`]);
  return {token:value,tokenType:'Bearer',expiresIn:3600};
 });
}
