import { test as base, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/security.js';
import { buildApp } from '../src/app.js';

const password = 'browser-test-password-123';
type Pilot = { url: string; login: (page: Page, role: string) => Promise<void>; pool: ReturnType<typeof createPool>; ids: Record<string,string>; classId: string };
const test = base.extend<{ pilot: Pilot }>({
  pilot: async ({}, use) => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must point to a disposable test database');
    const pool = createPool(process.env.DATABASE_URL);
    await migrate(pool);
    const app = await buildApp(pool);
    const url = await app.listen({host:'127.0.0.1',port:0});
    const suffix = randomUUID().slice(0,8), ids: Record<string,string> = {};
    const hash = await hashPassword(password);
    const classId = (await pool.query("INSERT INTO classes(title,goal) VALUES('Пилотный 6 «А»',100) RETURNING id")).rows[0].id;
    try {
      for (const role of ['teacher','student','parent']) {
        ids[role] = (await pool.query('INSERT INTO users(login,role,alias,password_hash) VALUES($1,$2,$2,$3) RETURNING id',[`${role}_${suffix}`,role,hash])).rows[0].id;
        await pool.query('INSERT INTO memberships VALUES($1,$2)',[classId,ids[role]]);
      }
      await pool.query("INSERT INTO guardian_links(parent_id,student_id,consent_reference) VALUES($1,$2,'browser-test')",[ids.parent,ids.student]);
      await pool.query("INSERT INTO tasks(class_id,created_by,question,options,correct_index,reward) VALUES($1,$2,'Сколько будет 2 + 2?','[\"4\",\"5\"]',0,30)",[classId,ids.teacher]);
      for(const audience of ['student','parent']) await pool.query("INSERT INTO polls(class_id,created_by,title,audience,options,closes_at) VALUES($1,$2,$3,$4,'[\"Кино\",\"Квест\"]',now()+interval '1 day')",[classId,ids.teacher,audience==='student'?'Выбор учеников':'Выбор родителей',audience]);
      await use({url,pool,ids,classId,login:async(page,role)=>{
        await page.goto(url);
        await page.getByLabel('Логин',{exact:true}).fill(`${role}_${suffix}`);
        await page.getByLabel('Пароль',{exact:true}).fill(password);
        await page.getByRole('button',{name:'Войти в свой класс'}).click();
        await expect(page.getByRole('heading',{name:'Мой класс',exact:true})).toBeVisible();
        await expect(page.locator('#coins')).toHaveText('0');
      }});
    } finally {
      await app.close();
      const demos=(await pool.query('SELECT user_id FROM admin_demo_accounts WHERE administrator_id=$1',[ids.teacher])).rows.map(x=>x.user_id);
      const classes = (await pool.query('SELECT DISTINCT class_id FROM memberships WHERE user_id=ANY($1::uuid[])',[[ids.teacher,...demos]])).rows.map(c=>c.class_id);
      await pool.query('DELETE FROM votes WHERE poll_id IN (SELECT id FROM polls WHERE class_id=ANY($1::uuid[]))',[classes]);
      for (const table of ['polls','coin_ledger','answers','tasks','memberships','classes']) await pool.query(`DELETE FROM ${table} WHERE ${table==='classes'?'id':'class_id'}=ANY($1::uuid[])`,[classes]);
      await pool.query('DELETE FROM guardian_links WHERE parent_id=ANY($1::uuid[])',[[ids.parent,...demos]]);
      await pool.query('DELETE FROM sessions WHERE administrator_id=$1',[ids.teacher]);
      await pool.query('DELETE FROM admin_demo_accounts WHERE administrator_id=$1',[ids.teacher]);
      await pool.query('DELETE FROM admin_events WHERE administrator_id=$1',[ids.teacher]);
      await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[demos]);
      await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[Object.values(ids)]);
      await pool.end();
    }
  },
});

test('login is responsive, installable and does not persist sessions',async({page,pilot},testInfo)=>{
  await page.goto(pilot.url);
  await expect(page.getByRole('heading',{name:'Войти в КлассКвест'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('login.png'),fullPage:true});
  const manifest=await page.request.get(pilot.url+'/manifest.webmanifest');
  expect(manifest.ok()).toBe(true); expect((await manifest.json()).display).toBe('standalone');
  await pilot.login(page,'student');
  expect(await page.evaluate(()=>({local:localStorage.length,session:sessionStorage.length}))).toEqual({local:0,session:0});
  await page.reload();
  await expect(page.getByRole('heading',{name:'Войти в КлассКвест'})).toBeVisible();
});

test('student answers once, reloads server history and votes only in student poll',async({page,pilot},testInfo)=>{
  await pilot.login(page,'student');
  await page.getByRole('button',{name:'Задания',exact:true}).click();
  await page.getByLabel('4',{exact:true}).check();
  await page.getByRole('button',{name:'Отправить ответ',exact:true}).click();
  await expect(page.locator('#notice')).toContainText('30 монет');
  await expect(page.getByText('Верно! +30 монет уже в общей копилке.')).toBeVisible();
  await page.getByRole('button',{name:'Копилка',exact:true}).click();
  await expect(page.locator('#coins')).toHaveText('30');
  await page.screenshot({path:testInfo.outputPath('bank.png'),fullPage:true});
  await page.getByRole('button',{name:'Выйти',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Войти в КлассКвест'})).toBeVisible();
  // Log in again without assuming the previous balance is zero.
  await page.getByLabel('Логин',{exact:true}).fill((await pilot.pool.query('SELECT login FROM users WHERE id=$1',[pilot.ids.student])).rows[0].login);
  await page.getByLabel('Пароль',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Войти в свой класс'}).click();
  await expect(page.locator('#coins')).toHaveText('30');
  await page.getByRole('button',{name:'Задания',exact:true}).click();
  await expect(page.getByText('Верно! +30 монет уже в общей копилке.')).toBeVisible();
  await expect(page.getByRole('button',{name:'Отправить ответ'})).toHaveCount(0);
  await page.getByRole('button',{name:'Голосования',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Выбор учеников'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Выбор родителей'})).toHaveCount(0);
  await page.getByLabel('Квест',{exact:true}).check();
  await page.getByRole('button',{name:'Голосовать',exact:true}).click();
  await expect(page.getByText('Ваш выбор сохранён.')).toBeVisible();
  await expect(page.getByRole('button',{name:'Изменить голос'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Посмотреть результаты'})).toHaveCount(0);
});

test('parent votes separately and cannot submit answers',async({page,pilot})=>{
  await pilot.login(page,'parent');
  await page.getByRole('button',{name:'Задания',exact:true}).click();
  await expect(page.getByRole('button',{name:'Отправить ответ'})).toHaveCount(0);
  await page.getByRole('button',{name:'Голосования',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Выбор родителей'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Выбор учеников'})).toHaveCount(0);
  await page.getByLabel('Кино',{exact:true}).check();
  await page.getByRole('button',{name:'Голосовать',exact:true}).click();
  await expect(page.getByText('Ваш выбор сохранён.')).toBeVisible();
});

test('teacher changes goal, publishes safely escaped task and views aggregate results',async({page,pilot})=>{
  await pilot.login(page,'teacher');
  await page.getByLabel('Цель класса в монетах').fill('200');
  await page.getByRole('button',{name:'Изменить цель',exact:true}).click();
  await expect(page.locator('#goal')).toHaveText('200');
  await page.getByRole('button',{name:'Задания',exact:true}).click();
  await page.getByText('Добавить задание',{exact:true}).click();
  const question='<img src=x onerror="window.bad=true">';
  await page.locator('#task-form').getByLabel('Вопрос',{exact:true}).fill(question);
  await page.getByLabel('Варианты ответа — каждый с новой строки').fill('Верно\nНеверно');
  await page.getByRole('button',{name:'Опубликовать задание'}).click();
  await expect(page.getByRole('heading',{name:question,exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as Window & {bad?:boolean}).bad)).toBeUndefined();
  await expect(page.locator('#tasks img')).toHaveCount(0);
  await page.getByRole('button',{name:'Голосования',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Выбор учеников'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Выбор родителей'})).toBeVisible();
  await page.getByRole('button',{name:'Посмотреть результаты'}).first().click();
  await expect(page.locator('.result-list li')).toHaveCount(2);
  await page.getByText('Создать голосование',{exact:true}).click();
  const pollForm=page.locator('#poll-form');
  await pollForm.getByLabel('Вопрос',{exact:true}).fill('Новое приключение');
  await pollForm.getByLabel('Варианты — каждый с новой строки').fill('Музей\nТеатр');
  await pollForm.getByLabel('Завершение по вашему местному времени').fill(new Date(Date.now()+86400000).toISOString().slice(0,16));
  await pollForm.getByRole('button',{name:'Открыть голосование'}).click();
  await expect(page.getByRole('heading',{name:'Новое приключение'})).toBeVisible();
});

test('network failure does not save or fabricate an answer; consent revocation clears class',async({page,pilot,context})=>{
  await pilot.login(page,'student');
  await page.getByRole('button',{name:'Задания',exact:true}).click();
  await context.setOffline(true);
  await page.getByLabel('4',{exact:true}).check();
  await page.getByRole('button',{name:'Отправить ответ'}).click();
  await expect(page.locator('#notice')).toContainText('Нет связи');
  expect((await pilot.pool.query('SELECT count(*)::int AS n FROM answers WHERE student_id=$1',[pilot.ids.student])).rows[0].n).toBe(0);
  await page.getByRole('button',{name:'Копилка',exact:true}).click();
  await pilot.pool.query('DELETE FROM guardian_links WHERE student_id=$1',[pilot.ids.student]);
  await context.setOffline(false); // Reconnection refreshes bank and discovers revocation.
  await expect(page.locator('#class-content')).toBeHidden();
  await expect(page.getByRole('heading',{name:'Здесь скоро будет ваш класс'})).toBeVisible();
  const cacheUrls=await page.evaluate(async()=>{ const result:string[]=[]; for(const key of await caches.keys()) for(const req of await (await caches.open(key)).keys()) result.push(req.url); return result; });
  expect(cacheUrls.some(url=>url.includes('/api/'))).toBe(false);
});


test('administrator panel switches sandbox roles and returns to real class',async({page,pilot},testInfo)=>{
 await pilot.pool.query('UPDATE users SET is_admin=true WHERE id=$1',[pilot.ids.teacher]);
 await pilot.login(page,'teacher');
 await expect(page.getByRole('heading',{name:'Панель администратора',exact:true})).toBeVisible();
 await expect(page.locator('#admin-counts')).toContainText('Активных аккаунтов:');
 await page.getByLabel('Режим проверки').selectOption('student');
 await page.getByRole('button',{name:'Переключить роль',exact:true}).click();
 await expect(page.locator('#admin-mode')).toHaveText('Тестовый режим: Ученик');
 await expect(page.locator('#class-select option')).toHaveText(['Тестовый класс администратора']);
 await page.getByRole('button',{name:'Задания',exact:true}).click();
 await page.getByRole('radio',{name:'4',exact:true}).check();
 await page.getByRole('button',{name:'Отправить ответ',exact:true}).click();
 await expect(page.getByText('Верно! +10 монет уже в общей копилке.',{exact:true})).toBeVisible();
 for (const [role,label] of [['parent','Родитель'],['teacher','Учитель']]) {
  await page.getByLabel('Режим проверки').selectOption(role);
  await page.getByRole('button',{name:'Переключить роль',exact:true}).click();
  await expect(page.locator('#admin-mode')).toHaveText('Тестовый режим: '+label);
 }
 await page.getByLabel('Режим проверки').selectOption('admin');
 await page.getByRole('button',{name:'Переключить роль',exact:true}).click();
 await expect(page.locator('#admin-mode')).toHaveText('Управление сайтом');
 await expect(page.locator('#class-select option')).toHaveText(['Пилотный 6 «А»']);
 await expect(page.locator('#coins')).toHaveText('0');
 await page.screenshot({path:testInfo.outputPath('administrator.png'),fullPage:true});
});

