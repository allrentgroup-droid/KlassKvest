const $ = id => document.getElementById(id);
const state = { token: null, user: null, classId: '', classes: [], tasks: [], polls: [], revision: 0, requests: new Set(), timer: null, retry: 30000 };
const roleNames = { teacher: 'Учитель', student: 'Ученик', parent: 'Родитель' };
let noticeTimer;
function notice(message, error = false) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').dataset.error = String(error);
  $('notice').hidden = false;
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, error ? 16000 : 8000);
}
function scope() {
  state.revision++;
  for (const request of state.requests) request.abort();
  state.requests.clear();
  clearTimeout(state.timer);
}
function clearClass() {
  state.classId = ''; state.tasks = []; state.polls = [];
  $('class-content').hidden = true;
  $('tasks').replaceChildren(); $('polls').replaceChildren();
  $('coins').textContent = '—'; $('goal').textContent = '—';
  $('class-select').value = '';
}
function signedOut() {
  scope(); clearClass(); state.token = null; state.user = null; state.classes = [];
  $('login-screen').hidden = false; $('workspace').hidden = true;
  $('role').hidden = true; $('logout').hidden = true;
  $('admin-panel').hidden = true;
  $('admin-events').replaceChildren();
  $('class-select').replaceChildren();
  for (const name of ['login-form','class-form','goal-form','task-form','poll-form']) $(name).reset();
  $('login-form').elements.login.focus();
}
async function api(path, { method = 'GET', body } = {}) {
  const revision = state.revision;
  const controller = new AbortController(); state.requests.add(controller);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
  try {
    const response = await fetch(path, { method, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
      headers: { ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (revision !== state.revision) throw new DOMException('Stale request', 'AbortError');
    if (!response.ok) {
      if (response.status === 401 && state.token) { signedOut(); throw new Error('Сессия завершена. Войдите снова.'); }
      if (response.status === 404 && state.classId && path.startsWith(`/api/classes/${state.classId}/`)) {
        scope(); clearClass();
        $('no-classes').hidden = false;
        void loadClasses().catch(report);
        throw new Error('Этот класс или материал больше недоступен. Список классов обновлён.');
      }
      const messages = { 400:'Проверьте заполненные поля.', 401:'Логин или пароль не подошли.', 403:'Это действие недоступно вашей учётной записи.', 404:'Материал не найден.', 409:'Действие уже выполнено или голосование завершено. Обновите страницу класса.', 413:'Слишком большой объём данных.', 429:'Слишком много запросов. Подождите и попробуйте позже.' };
      throw new Error(messages[response.status] ?? 'Сервер временно недоступен. Попробуйте позже.');
    }
    const payload = response.status === 204 ? null : await response.json();
    if (revision !== state.revision) throw new DOMException('Stale request', 'AbortError');
    return payload;
  } catch (error) {
    if (timedOut) throw new Error('Сервер не ответил вовремя. Проверьте интернет и повторите запрос.');
    if (error instanceof TypeError) throw new Error('Нет связи с сервером. Проверьте подключение к интернету.');
    throw error;
  } finally { clearTimeout(timer); state.requests.delete(controller); }
}
function report(error) { if (error.name !== 'AbortError') notice(error.message, true); }
async function busy(form, action) {
  const controls = [...form.querySelectorAll('input,select,textarea,button')];
  const disabled = controls.map(c => c.disabled);
  controls.forEach(c => { c.disabled = true; }); form.setAttribute('aria-busy','true');
  try { await action(); } catch (error) { report(error); }
  finally { controls.forEach((c,i) => { c.disabled = disabled[i]; }); form.removeAttribute('aria-busy'); }
}
function node(tag, text, className) {
  const value = document.createElement(tag);
  if (text !== undefined) value.textContent = text;
  if (className) value.className = className;
  return value;
}
function empty(target, title, description) {
  const card = node('div',undefined,'card empty');
  card.append(node('h2',title),node('p',description)); target.append(card);
}
function teacherTools() {
  const teacher = state.user?.role === 'teacher';
  for (const name of ['class-form','goal-form','task-editor','poll-editor']) $(name).hidden = !teacher;
  $('task-hint').textContent = state.user?.role === 'student' ? 'Одна попытка на задание. Выберите ответ внимательно.' : 'Награды учеников пополняют общую копилку.';
  $('poll-hint').textContent = teacher ? 'Голосования учеников и родителей проходят отдельно.' : 'Один голос. До завершения его можно изменить.';
}
async function loadClasses(preferred) {
  const { classes } = await api('/api/classes'); state.classes = classes;
  $('class-select').replaceChildren(...classes.map(c => { const option = node('option',c.title); option.value = c.id; return option; }));
  $('no-classes').hidden = classes.length > 0;
  if (classes.length) await loadClass(classes.find(c => c.id===preferred)?.id ?? classes[0].id);
  else clearClass();
}
function scheduleBank() {
  clearTimeout(state.timer);
  if (state.token && state.classId && !document.hidden) state.timer = setTimeout(async () => {
    try { await loadBank(); state.retry = 30000; }
    catch (error) { if (error.name !== 'AbortError') { $('sync').textContent = 'Нет свежих данных'; state.retry = Math.min(state.retry*2,120000); if(!state.token) report(error); } }
    scheduleBank();
  }, state.retry);
}
async function loadBank() {
  if (!state.classId) return;
  const { coins,goal } = await api(`/api/classes/${state.classId}/bank`);
  $('coins').textContent = BigInt(coins).toLocaleString('ru-RU');
  $('goal').textContent = BigInt(goal).toLocaleString('ru-RU');
  const percent = Math.min(100,Number(BigInt(coins)*100n/BigInt(goal)));
  $('progress').value = percent; $('percent').textContent = `${percent}%`;
  $('goal-message').textContent = BigInt(coins)>=BigInt(goal) ? 'Цель достигнута! Пора выбирать следующее приключение.' : 'Каждый вклад приближает общее приключение.';
  $('sync').textContent = `Обновлено в ${new Date().toLocaleTimeString('ru-RU',{ hour:'2-digit',minute:'2-digit' })}`;
  // Do not overwrite an in-progress teacher edit during periodic refresh.
  if (document.activeElement !== $('goal-form').elements.goal) $('goal-form').elements.goal.value = goal;
}
async function loadClass(classId) {
  scope(); clearClass(); state.classId = classId; state.retry = 30000;
  $('class-select').value = classId;
  $('class-content').hidden = false;
  $('sync').textContent = 'Обновляем…';
  $('tasks').append(node('p','Загружаем задания…','muted')); $('polls').append(node('p','Загружаем голосования…','muted'));
  $('more-tasks').hidden = true; $('more-polls').hidden = true;
  try { await Promise.all([loadBank(),loadTasks(),loadPolls()]); }
  finally { scheduleBank(); }
}
async function loadTasks(more = false) {
  const after = more ? state.tasks.at(-1)?.id : null;
  const { tasks } = await api(`/api/classes/${state.classId}/tasks${after ? `?after=${after}` : ''}`);
  state.tasks = more ? [...state.tasks,...tasks] : tasks;
  $('more-tasks').hidden = tasks.length < 100;
  renderTasks();
}
function renderTasks() {
  $('tasks').replaceChildren();
  if (!state.tasks.length) return empty($('tasks'),'Первые задания уже в пути','Учитель добавит их сюда.');
  for (const task of state.tasks) {
    const card = node('article',undefined,'card task-card'); card.dataset.taskId = task.id;
    const meta = node('div',undefined,'task-meta'); meta.append(node('span',task.myAnswer ? 'Ответ сохранён' : 'Задание','badge'),node('b',`+${task.reward} монет`));
    const question = node('h3',task.question,'question'); question.id = `task-${task.id}`;
    card.append(meta,question);
    const form = node('form'); form.setAttribute('aria-labelledby',question.id);
    task.options.forEach((text,index) => {
      const label = node('label',undefined,`option${task.myAnswer?.selectedIndex===index ? ' is-chosen' : ''}`);
      const radio = node('input'); radio.type = 'radio'; radio.name = 'answer'; radio.value = index; radio.required = true;
      radio.disabled = !!task.myAnswer || state.user.role !== 'student'; radio.checked = task.myAnswer?.selectedIndex===index;
      label.append(radio,node('span',text)); form.append(label);
    });
    if (state.user.role === 'student' && !task.myAnswer) {
      const button = node('button','Отправить ответ','button primary'); button.type = 'submit'; form.append(button);
      form.addEventListener('submit',event => {
        event.preventDefault(); const selectedIndex = Number(new FormData(form).get('answer'));
        void busy(form,async () => {
          const result = await api(`/api/classes/${state.classId}/tasks/${task.id}/answers`,{ method:'POST',body:{selectedIndex} });
          task.myAnswer = result; renderTasks();
          notice(result.correct ? result.replayed ? 'Этот ответ уже сохранён. Повторного начисления нет.' : `Верно! В копилку класса добавлено ${result.awarded} монет.` : 'Ответ сохранён. В этот раз без монет — продолжаем учиться!');
          await loadBank();
        });
      });
    }
    card.append(form);
    if (task.myAnswer) card.append(node('p',task.myAnswer.correct ? `Верно! +${task.myAnswer.awarded} монет уже в общей копилке.` : 'Ответ сохранён. В этот раз без монет.',`answer-feedback${task.myAnswer.correct ? '' : ' incorrect'}`));
    $('tasks').append(card);
  }
}
async function loadPolls(more = false) {
  const after = more ? state.polls.at(-1)?.id : null;
  const { polls } = await api(`/api/classes/${state.classId}/polls${after ? `?after=${after}` : ''}`);
  state.polls = more ? [...state.polls,...polls] : polls;
  $('more-polls').hidden = polls.length < 100;
  renderPolls();
}
function renderPolls() {
  $('polls').replaceChildren();
  if (!state.polls.length) return empty($('polls'),'Пока без голосований','Когда откроется голосование для вас, оно появится здесь.');
  for (const poll of state.polls) {
    const card = node('article',undefined,'card poll-card'); card.dataset.pollId = poll.id;
    const closed = Date.parse(poll.closes_at) <= Date.now();
    const meta = node('div',undefined,'task-meta'); meta.append(node('span',poll.audience==='student' ? 'Ученики' : 'Родители','badge'),node('span',closed ? 'Завершено' : 'Голосование открыто','muted'));
    const title = node('h3',poll.title,'question'); title.id = `poll-${poll.id}`;
    card.append(meta,title,node('p',`До ${new Date(poll.closes_at).toLocaleString('ru-RU',{dateStyle:'medium',timeStyle:'short'})}`,'muted'));
    const form = node('form'); form.setAttribute('aria-labelledby',title.id);
    poll.options.forEach((text,index) => {
      const label = node('label',undefined,`option${poll.myVote===index ? ' is-chosen' : ''}`);
      const radio = node('input'); radio.type = 'radio'; radio.name = 'vote'; radio.value = index; radio.required = true; radio.checked = poll.myVote===index;
      radio.disabled = closed || state.user.role !== poll.audience;
      label.append(radio,node('span',text)); form.append(label);
    });
    if (state.user.role===poll.audience && !closed) {
      const button = node('button',poll.myVote===null ? 'Голосовать' : 'Изменить голос','button primary'); button.type = 'submit'; form.append(button);
      form.addEventListener('submit',event => {
        event.preventDefault(); const optionIndex = Number(new FormData(form).get('vote'));
        void busy(form,async () => {
          try { await api(`/api/classes/${state.classId}/polls/${poll.id}/votes`,{method:'POST',body:{optionIndex}}); poll.myVote = optionIndex; renderPolls(); notice('Ваш голос сохранён.'); }
          catch (error) { if (error.name!=='AbortError' && state.classId) void loadPolls().catch(report); throw error; }
        });
      });
    }
    card.append(form);
    if (poll.myVote!==null) card.append(node('p','Ваш выбор сохранён.','answer-feedback'));
    if (state.user.role==='teacher') {
      const button = node('button','Посмотреть результаты','button secondary');
      const results = node('ul',undefined,'result-list'); results.setAttribute('aria-live','polite');
      button.addEventListener('click',() => { void busy(card,async()=>{
        const { counts } = await api(`/api/classes/${state.classId}/polls/${poll.id}/results`);
        results.replaceChildren(...poll.options.map((text,index) => { const li = node('li'); li.append(node('span',text),node('b',String(counts.find(c=>c.option_index===index)?.votes ?? 0))); return li; }));
      }); }); card.append(button,results);
    }
    $('polls').append(card);
  }
}
function tab(name) {
  for (const target of ['bank','tasks','polls']) $(target+'-panel').hidden = target!==name;
  for (const button of document.querySelectorAll('[data-tab]')) {
    if (button.dataset.tab===name) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
  }
}
function optionsFrom(form) {
  const options = form.elements.options.value.trim().split(/\r?\n/).map(value=>value.trim());
  if (options.length<2 || options.length>6 || options.some(value=>!value || value.length>300)) throw new Error('Укажите от 2 до 6 вариантов, каждый до 300 символов, без пустых строк.');
  return options;
}
$('login-form').addEventListener('submit',event=>{
  event.preventDefault(); const form = event.currentTarget;
  const body = { login:form.elements.login.value.trim(),password:form.elements.password.value };
  form.elements.password.value = '';
  void busy(form,async()=>{
    const { token } = await api('/api/auth/login',{method:'POST',body});
    scope(); state.token = token;
    try { state.user = (await api('/api/me')).user; }
    catch (error) { signedOut(); throw error; }
    $('login-screen').hidden = true; $('workspace').hidden = false;
    $('role').textContent = roleNames[state.user.role]; $('role').hidden = false; $('logout').hidden = false;
    teacherTools(); await loadAdministration(); tab('bank');
    await loadClasses(); $('main').focus();
  });
});
$('logout').addEventListener('click',async()=>{
  $('logout').disabled = true;
  try { await api('/api/auth/logout',{method:'POST'}); signedOut(); notice('Вы вышли из класса.'); }
  catch (error) { signedOut(); if(error.name!=='AbortError') notice('На этом устройстве выполнен выход. Связи с сервером нет; серверная сессия истечёт автоматически.',true); }
  finally { $('logout').disabled = false; }
});
$('class-select').addEventListener('change',()=>{ if ($('class-select').value) void loadClass($('class-select').value).catch(report); });
$('retry-session').addEventListener('click',()=>{ void busy($('workspace'),()=>loadClasses(state.classId)); });
$('refresh').addEventListener('click',()=>{ void busy($('bank-panel'),async()=>{ await Promise.all([loadBank(),loadTasks(),loadPolls()]); notice('Данные класса обновлены.'); }); });
$('more-tasks').addEventListener('click',()=>{ void busy($('tasks-panel'),()=>loadTasks(true)); });
$('more-polls').addEventListener('click',()=>{ void busy($('polls-panel'),()=>loadPolls(true)); });
for (const button of document.querySelectorAll('[data-tab],[data-go]')) button.addEventListener('click',()=>tab(button.dataset.tab ?? button.dataset.go));
$('class-form').addEventListener('submit',event=>{
  event.preventDefault(); const form = event.currentTarget; const title = form.elements.title.value.trim();
  void busy(form,async()=>{ const result = await api('/api/classes',{method:'POST',body:{title}}); form.reset(); await loadClasses(result.id); notice('Класс создан. Организатор может добавить участников.'); });
});
$('goal-form').addEventListener('submit',event=>{
  event.preventDefault(); const form = event.currentTarget; const goal = Number(form.elements.goal.value);
  void busy(form,async()=>{ await api(`/api/classes/${state.classId}/goal`,{method:'PATCH',body:{goal}}); await loadBank(); notice('Цель класса обновлена.'); });
});
$('task-form').addEventListener('submit',event=>{
  event.preventDefault(); const form = event.currentTarget;
  void busy(form,async()=>{
    const options = optionsFrom(form), correctIndex = Number(form.elements.correctIndex.value)-1;
    if (correctIndex<0 || correctIndex>=options.length) throw new Error('Номер правильного варианта должен соответствовать одному из вариантов.');
    await api(`/api/classes/${state.classId}/tasks`,{method:'POST',body:{question:form.elements.question.value.trim(),options,correctIndex,reward:Number(form.elements.reward.value)}});
    form.reset(); await loadTasks(); notice('Задание опубликовано.');
  });
});
$('poll-form').addEventListener('submit',event=>{
  event.preventDefault(); const form = event.currentTarget;
  void busy(form,async()=>{
    const date = new Date(form.elements.closesAt.value);
    if (!Number.isFinite(date.getTime()) || date.getTime()<=Date.now() || date.getTime()>Date.now()+90*86400000) throw new Error('Выберите время в будущем, не позднее чем через 90 дней.');
    await api(`/api/classes/${state.classId}/polls`,{method:'POST',body:{title:form.elements.title.value.trim(),audience:form.elements.audience.value,options:optionsFrom(form),closesAt:date.toISOString()}});
    form.reset(); await loadPolls(); notice('Голосование открыто.');
  });
});
document.addEventListener('visibilitychange',()=>{ if(document.hidden) clearTimeout(state.timer); else scheduleBank(); });
window.addEventListener('online',()=>{ if(state.token && state.classId) void loadBank().then(scheduleBank).catch(report); });
window.addEventListener('offline',()=>{ if(state.token) { $('sync').textContent = 'Нет связи с сервером'; notice('Нет интернета. Ответы и голоса отправляются только при подключении.',true); } });
let installPrompt;
window.addEventListener('beforeinstallprompt',event=>{ event.preventDefault(); installPrompt = event; $('install').hidden = false; });
$('install').addEventListener('click',async()=>{
  if (!installPrompt) return;
  try { await installPrompt.prompt(); await installPrompt.userChoice; }
  catch { notice('Добавьте приложение на главный экран через меню браузера.'); }
  finally { installPrompt = null; $('install').hidden = true; }
});
window.addEventListener('appinstalled',()=>{ installPrompt = null; $('install').hidden = true; });
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(()=>{});

async function loadAdministration() {
  const visible=!!state.user?.administratorId;
  $('admin-panel').hidden=!visible;
  if (!visible) return;
  $('admin-mode').textContent=state.user.testRole ? 'Тестовый режим: '+roleNames[state.user.role] : 'Управление сайтом';
  $('admin-switch-form').elements.role.value=state.user.testRole ? state.user.role : 'admin';
  $('admin-counts').textContent=''; $('admin-events').replaceChildren();
  if (!state.user.testRole) {
    const {counts,events}=await api('/api/admin/overview');
    $('admin-counts').textContent='Активных аккаунтов: '+counts.users+' · Классов: '+counts.classes+' · Заданий: '+counts.tasks;
    for (const event of events) $('admin-events').append(node('li',({switch_teacher:'Тестовый учитель',switch_student:'Тестовый ученик',switch_parent:'Тестовый родитель',return_admin:'Возврат администратора'}[event.action] ?? event.action)+' · '+new Date(event.created_at).toLocaleString('ru-RU')));
  }
}
$('admin-switch-form').addEventListener('submit',event=>{
 event.preventDefault();
 const role=event.currentTarget.elements.role.value;
 void busy(event.currentTarget,async()=>{
  const result=await api('/api/admin/switch-role',{method:'POST',body:{role}});
  scope(); clearClass(); state.token=result.token;
  state.user=(await api('/api/me')).user;
  $('role').textContent=roleNames[state.user.role];
  teacherTools(); await loadAdministration(); await loadClasses();
  tab('bank'); notice(state.user.testRole ? 'Вы в отдельном тестовом классе.' : 'Вы вернулись в панель администратора.');
 });
});

