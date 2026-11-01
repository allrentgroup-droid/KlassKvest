// Local operator only. No public role assignment or registration endpoints.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { config } from './config.js';
import { createPool, transaction } from './db.js';
import { hashPassword } from './security.js';
const pool = createPool(config().connectionString);
const [command,...args] = process.argv.slice(2);
const id = z.string().uuid();
const password = () => z.string().min(12).max(128).parse(readFileSync(0,'utf8').trim());
try {
 if (command==='grant-admin' || command==='revoke-admin') {
  const [userId]=z.tuple([id]).parse(args);
  await transaction(pool,async db=>{
   const changed=await db.query("UPDATE users SET is_admin=$2 WHERE id=$1 AND role='teacher' RETURNING id",[userId,command==='grant-admin']);
   if (!changed.rowCount) throw new Error('Teacher account not found');
   await db.query('DELETE FROM sessions WHERE user_id=$1 OR administrator_id=$1',[userId]);
  });
 } else if (command==='user') {
  const [login,role,alias] = z.tuple([z.string().regex(/^[a-z0-9_-]{3,64}$/),z.enum(['teacher','parent','student']),z.string().min(1).max(40)]).parse(args);
  console.log((await pool.query('INSERT INTO users(login,role,alias,password_hash) VALUES($1,$2,$3,$4) RETURNING id',[login,role,alias,await hashPassword(password())])).rows[0]);
 } else if (command==='member') {
  const [classId,userId] = z.tuple([id,id]).parse(args);
  await pool.query('INSERT INTO memberships(class_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[classId,userId]);
 } else if (command==='guardian') {
  const [parent,student,reference] = z.tuple([id,id,z.string().min(1).max(100)]).parse(args);
  const result = await pool.query(`INSERT INTO guardian_links(parent_id,student_id,consent_reference) SELECT p.id,s.id,$3 FROM users p,users s WHERE p.id=$1 AND s.id=$2 AND p.role='parent' AND s.role='student' ON CONFLICT DO NOTHING RETURNING parent_id`,[parent,student,reference]);
  if (!result.rowCount) throw new Error('Invalid roles or link exists');
 } else if (command==='revoke-consent') {
  const [parent,student] = z.tuple([id,id]).parse(args);
  await pool.query('DELETE FROM guardian_links WHERE parent_id=$1 AND student_id=$2',[parent,student]);
 } else if (command==='remove-member') {
  const [classId,userId] = z.tuple([id,id]).parse(args);
  await pool.query('DELETE FROM memberships WHERE class_id=$1 AND user_id=$2',[classId,userId]);
 } else if (command==='disable' || command==='password') {
  const [userId] = z.tuple([id]).parse(args);
  const hash = command==='password' ? await hashPassword(password()) : undefined;
  await transaction(pool,async db=>{
   const result = hash ? await db.query('UPDATE users SET password_hash=$2 WHERE id=$1',[userId,hash]) : await db.query('UPDATE users SET active=false WHERE id=$1',[userId]);
   if (!result.rowCount) throw new Error('User not found');
   await db.query('DELETE FROM sessions WHERE user_id=$1',[userId]);
  });
 } else if (command==='cleanup') {
  await pool.query('DELETE FROM sessions WHERE expires_at<now()');
  await pool.query("DELETE FROM login_limits WHERE window_start<now()-interval '1 day'");
 } else throw new Error('Commands: user login role alias (password on stdin); member classId userId; guardian parentId studentId consentReference; revoke-consent parentId studentId; remove-member classId userId; disable userId; password userId (stdin); cleanup');
} finally { await pool.end(); }
