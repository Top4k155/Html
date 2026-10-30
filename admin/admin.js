// Админ-панель чата: то же, что делает allow_emails.py, только в браузере.
// Список почт живёт в базе (access/emails), правила базы читают его сами,
// поэтому после каждой правки публиковать правила вручную не нужно.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { getDatabase, ref, get, set, push, query, limitToLast, onValue, serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js';
import { firebaseConfig, ownerEmail } from '../firebase-config.js';

const $ = (s) => document.querySelector(s);
const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/;
const DEFAULT_OWNER = String(ownerEmail || '').toLowerCase();
// Пока в базе нет записи access/emails, действует этот список: ровно те почты,
// что были прописаны в правилах раньше, чтобы после публикации никто не потерял доступ.
// Зашитых почт в правилах больше нет: доступ решают только записи в базе.
const DEFAULT_EMAILS = [];

let auth;
let db;
let me = null;
let state = { owner: DEFAULT_OWNER, emails: [], updatedAt: 0, exists: false };
let draft = null;
let draftProviders = {};
let stopAccess;
let stopLog;

const isOwner = () => Boolean(me?.email) && String(me.email).toLowerCase() === state.owner;

function parseList(raw) {
  if (typeof raw !== 'string') return [];
  return [...new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
}
function packList(emails) {
  return emails.length ? `,${emails.join(',')},` : '';
}
// Способ входа для каждой почты: google или yandex. Хранится отдельно от списка,
// чтобы правила базы и вход через Яндекс работали как раньше: доступ по-прежнему
// решает только список почт. Почты без записи считаются Google (так было раньше).
const PROVIDERS = { google: 'Google', yandex: 'Яндекс' };
function parseProviders(raw) {
  const map = {};
  if (typeof raw !== 'string') return map;
  for (const part of raw.split(',')) {
    const [mail, p] = part.split(':').map((s) => (s || '').trim().toLowerCase());
    if (mail && PROVIDERS[p]) map[mail] = p;
  }
  return map;
}
function packProviders(map, emails) {
  const parts = emails.filter((e) => map[e]).map((e) => `${e}:${map[e]}`);
  return parts.length ? `,${parts.join(',')},` : '';
}
function providerOf(email) {
  return draftProviders[email] || 'google';
}
function syncProviderHint() {
  const yandex = $('#newProvider').value === 'yandex';
  $('#newEmail').placeholder = yandex ? 'почта@yandex.ru' : 'почта@gmail.com';
  $('#providerHint').textContent = yandex
    ? 'Войдёт через Яндекс ID. Укажите почту, которая в Яндекс ID стоит основной (обычно @yandex.ru или @ya.ru). Если вход не проходит, проверьте основную почту в профиле Яндекс ID.'
    : 'Войдёт через кнопку Google. Укажите почту Gmail или Google Workspace.';
}
function fmt(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  try {
    return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(n));
  } catch { return ''; }
}
function showError(s) {
  const code = s?.code || '';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return 'Вход отменён.';
  if (code === 'auth/network-request-failed') return 'Нет сети. Проверьте интернет и попробуйте снова.';
  if (/permission[-_ ]denied/i.test(`${code} ${s?.message || ''}`)) return 'База отказала в доступе. Проверьте, что вы вошли под почтой владельца.';
  if (code === 'auth/unauthorized-domain') return 'Адрес сайта не добавлен в Authentication → Settings → Authorized domains.';
  if (code === 'auth/operation-not-allowed') return 'Вход через Google выключен в Firebase Authentication.';
  return s?.message || 'Не удалось выполнить действие.';
}
function normalize(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new Error('Это не похоже на почту.');
  return email;
}

// ---------- состояние ----------
function loadState(snapshot) {
  const v = snapshot && typeof snapshot === 'object' ? snapshot : {};
  state = {
    exists: Boolean(snapshot),
    owner: String(v.owner || DEFAULT_OWNER).toLowerCase(),
    emails: parseList(v.emails),
    updatedAt: Number(v.updatedAt) || 0,
    providers: parseProviders(v.providers),
  };
  if (!state.emails.length) state.emails = [...DEFAULT_EMAILS];
  if (state.owner && !state.emails.includes(state.owner)) state.emails.unshift(state.owner);
  draft = [...state.emails];
  draftProviders = { ...state.providers };
  render();
}
function dirty() {
  if (!state.exists) return true; // список ещё ни разу не сохранён в базу
  return draft.length !== state.emails.length || draft.some((e, i) => e !== state.emails[i]);
}
function render() {
  $('#whoami').textContent = me?.email || '';
  const list = $('#list');
  list.replaceChildren();
  if (!draft.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Список пуст. Добавьте хотя бы владельца.';
    list.append(li);
  }
  for (const email of draft) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.className = 'mail';
    span.textContent = email;
    li.append(span);
    const pv = document.createElement('span');
    pv.className = 'badge';
    pv.textContent = PROVIDERS[providerOf(email)];
    li.append(pv);
    if (email === state.owner) {
      const b = document.createElement('span');
      b.className = 'badge owner';
      b.textContent = 'владелец';
      li.append(b);
    }
    const del = document.createElement('button');
    del.className = 'btn danger';
    del.type = 'button';
    del.textContent = 'Убрать';
    del.disabled = email === state.owner;
    del.title = email === state.owner ? 'Сначала назначьте другого владельца' : 'Убрать из списка';
    del.onclick = () => {
      draft = draft.filter((e) => e !== email);
      delete draftProviders[email];
      $('#saveMsg').textContent = '';
      render();
    };
    li.append(del);
    list.append(li);
  }
  $('#count').textContent = String(draft.length);
  $('#state').textContent = state.exists ? 'в базе' : 'не создан';
  $('#ownerEmail').value = state.owner;
  const changed = dirty();
  $('#saveBtn').disabled = !changed;
  $('#revertBtn').disabled = !changed;
  $('#savedAt').textContent = state.updatedAt ? `Последнее изменение: ${fmt(state.updatedAt)}` : 'Список ещё не сохранён в базу.';
  $('#saveMsg').textContent = changed ? 'Есть несохранённые правки.' : $('#saveMsg').textContent;
}

// ---------- действия ----------
async function save() {
  $('#saveMsg').textContent = '';
  $('#listError').textContent = '';
  $('#saveBtn').disabled = true;
  try {
    const emails = [...new Set(draft)].map(normalize);
    const owner = emails.includes(state.owner) ? state.owner : emails[0];
    await set(ref(db, 'access'), {
      owner,
      emails: packList(emails),
      providers: packProviders(draftProviders, emails),
      updatedAt: Date.now(),
      updatedBy: me.email,
    });
    await log('save', `${emails.length} почт(ы): ${emails.join(', ')}`);
    $('#saveMsg').textContent = 'Сохранено. Новый список уже действует в чате.';
  } catch (err) {
    $('#listError').textContent = showError(err);
  } finally {
    $('#saveBtn').disabled = !dirty();
  }
}
async function setOwner() {
  $('#ownerError').textContent = '';
  try {
    const email = normalize($('#ownerEmail').value);
    if (!draft.includes(email)) {
      draft.push(email);
    }
    state.owner = email;
    render();
    $('#saveMsg').textContent = 'Владелец выбран, нажмите «Сохранить».';
  } catch (err) {
    $('#ownerError').textContent = err.message;
  }
}
async function log(action, text) {
  try {
    await set(push(ref(db, 'accessLog')), { action, text, by: me?.email || '', at: Date.now() });
  } catch { /* журнал не должен ломать сохранение */ }
}

// ---------- правила ----------
// В правилах нет тернарного оператора, зато && и || считаются слева направо
// с остановкой: если слева false, правая часть не вычисляется. Поэтому
// проверка exists() стоит перед contains() и null никогда не вызывается.
function allowExpr() {
  const list = "root.child('access/emails')";
  return (
    'auth != null && auth.token.email_verified == true && ('
    + `auth.token.email == '${DEFAULT_OWNER}'`
    + " || auth.token.email == root.child('access/owner').val()"
    + ' || '
    + `(${list}.exists() == true && ${list}.val().contains(',' + auth.token.email + ','))`
    + ')'
  );
}
// Первый владелец из конфига остаётся с доступом всегда: иначе при потере
// записи access/owner панель стала бы недоступна и починить её было бы нечем.
function ownerExpr() {
  return (
    'auth != null && auth.token.email_verified == true && ('
    + `auth.token.email == '${DEFAULT_OWNER}'`
    + " || auth.token.email == root.child('access/owner').val()"
    + ')'
  );
}
function buildRules() {
  const allowed = allowExpr();
  const owner = ownerExpr();
  const fileOk = `(!newData.child('file').exists() || (newData.child('file').hasChildren(['key','name','size','type']) && newData.child('file').child('key').isString() && newData.child('file').child('key').val().length <= 200 && newData.child('file').child('name').isString() && newData.child('file').child('name').val().length <= 200 && newData.child('file').child('size').isNumber()))`;
  const messageWrite = `${allowed} && ((newData.exists() && !data.exists() && newData.child('uid').val() == auth.uid && newData.child('text').isString() && newData.child('text').val().length > 0 && newData.child('text').val().length <= 2000 && newData.child('email').val() == auth.token.email && newData.child('name').isString() && newData.child('name').val().length <= 120 && newData.hasChildren(['uid','name','email','text','createdAt']) && ${fileOk} && newData.child('createdAt').isNumber() && newData.child('createdAt').val() <= now + 60000 && newData.child('createdAt').val() >= now - 60000) || (data.exists() && !newData.exists() && data.child('uid').val() == auth.uid))`;
  return {
    rules: {
      '.read': false,
      '.write': false,
      access: {
        '.read': owner,
        '.write': owner,
      },
      accessLog: {
        '.read': owner,
        $id: {
          '.write': `${owner} && newData.child('by').val() == auth.token.email && newData.child('at').isNumber() && newData.hasChildren(['action','text','by','at'])`,
        },
      },
      // Токены уведомлений: каждый пишет только свои, читает только сервер (он обходит правила).
      pushTokens: {
        '.read': false,
        $uid: {
          '.write': `${allowed} && auth.uid == $uid`,
          $token: {
            '.validate': "newData.hasChildren(['token','email','updatedAt']) && newData.child('token').isString() && newData.child('token').val().length <= 400",
          },
        },
      },
      messages: {
        '.read': allowed,
        $id: {
          '.write': messageWrite,
          uid: { '.validate': true },
          name: { '.validate': true },
          email: { '.validate': true },
          text: { '.validate': true },
          createdAt: { '.validate': true },
          file: {
            key: { '.validate': true },
            name: { '.validate': true },
            size: { '.validate': true },
            type: { '.validate': true },
            $other: { '.validate': false },
          },
          $other: { '.validate': false },
        },
      },
      pinnedMessage: {
        '.read': allowed,
        '.write': owner,
      },
    },
  };
}
function rulesText() {
  return JSON.stringify(buildRules(), null, 2) + '\n';
}

// ---------- вход ----------
function wantsRedirect() {
  return matchMedia('(pointer:coarse)').matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}
function startWatch() {
  stopAccess?.();
  stopLog?.();
  stopAccess = onValue(ref(db, 'access'), (snap) => {
    // Пока локальная копия не совпала с базой, не перерисовываем: иначе первая
    // же правка стирается первым снимком базы.
    if (state.exists && dirty()) return;
    loadState(snap.val());
  }, (err) => {
    $('#listError').textContent = showError(err);
  });
  stopLog = onValue(query(ref(db, 'accessLog'), limitToLast(15)), (snap) => {
    const items = [];
    snap.forEach((child) => items.push(child.val() || {}));
    const ul = $('#log');
    ul.replaceChildren();
    $('#logEmpty').classList.toggle('hidden', items.length > 0);
    for (const item of items.reverse()) {
      const li = document.createElement('li');
      const when = fmt(item.at);
      li.textContent = `${when} · ${item.action === 'owner' ? 'владелец' : 'список'}: ${item.text}${item.by ? ` — ${item.by}` : ''}`;
      ul.append(li);
    }
  }, () => {});
}
async function enter(u) {
  me = u;
  if (!u.email) {
    $('#loginError').textContent = 'У аккаунта Google нет почты, доступ невозможен.';
    return;
  }
  let snapshot = null;
  try {
    snapshot = (await get(ref(db, 'access'))).val();
  } catch (err) {
    $('#loginError').textContent = showError(err);
    await signOut(auth).catch(() => {});
    return;
  }
  const owner = String(snapshot?.owner || DEFAULT_OWNER).toLowerCase();
  if (String(u.email).toLowerCase() !== owner) {
    $('#loginError').textContent = `Это админ-панель владельца (${owner}). Вы вошли как ${u.email}.`;
    await signOut(auth).catch(() => {});
    return;
  }
  $('#loginError').textContent = '';
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  loadState(snapshot);
  startWatch();
}

function init() {
  // тема
  const saved = (() => { try { return localStorage.getItem('chat-theme'); } catch { return null; } })();
  const theme = saved === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  $('#themeBtn').onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('chat-theme', next); } catch {}
  };

  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const fb = initializeApp(firebaseConfig);
  auth = getAuth(fb);
  db = getDatabase(fb);

  $('#loginBtn').onclick = async () => {
    $('#loginError').textContent = '';
    try {
      if (wantsRedirect()) await signInWithRedirect(auth, provider);
      else {
        try { await signInWithPopup(auth, provider); }
        catch (err) {
          if (err?.code === 'auth/popup-blocked' || err?.code === 'auth/operation-not-supported-in-this-environment') await signInWithRedirect(auth, provider);
          else throw err;
        }
      }
    } catch (err) {
      $('#loginError').textContent = showError(err);
    }
  };
  getRedirectResult(auth).catch((err) => { $('#loginError').textContent = showError(err); });
  onAuthStateChanged(auth, async (u) => {
    if (!u) {
      me = null;
      stopAccess?.(); stopLog?.();
      $('#app').classList.add('hidden');
      $('#login').classList.remove('hidden');
      return;
    }
    await enter(u);
  });

  $('#addBtn').onclick = () => {
    $('#listError').textContent = '';
    try {
      const email = normalize($('#newEmail').value);
      if (draft.includes(email)) throw new Error('Такая почта уже в списке.');
      draft.push(email);
      draftProviders[email] = $('#newProvider').value === 'yandex' ? 'yandex' : 'google';
      $('#newEmail').value = '';
      $('#saveMsg').textContent = '';
      render();
    } catch (err) {
      $('#listError').textContent = err.message;
    }
  };
  $('#newEmail').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#addBtn').click(); });
  $('#newProvider').addEventListener('change', syncProviderHint);
  syncProviderHint();
  $('#saveBtn').onclick = save;
  $('#revertBtn').onclick = () => { draft = [...state.emails]; draftProviders = { ...state.providers }; $('#saveMsg').textContent = ''; $('#listError').textContent = ''; render(); };
  $('#ownerBtn').onclick = setOwner;
  $('#logout').onclick = () => auth && signOut(auth);

  $('#rulesBtn').onclick = () => {
    const pre = $('#rules');
    pre.textContent = rulesText();
    pre.classList.toggle('hidden');
  };
  $('#copyBtn').onclick = async () => {
    try {
      await navigator.clipboard.writeText(rulesText());
      $('#saveMsg').textContent = 'Правила скопированы в буфер обмена.';
    } catch {
      $('#listError').textContent = 'Браузер не дал скопировать. Откройте правила и выделите текст вручную.';
    }
  };
  $('#downloadBtn').onclick = () => {
    const blob = new Blob([rulesText()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'database.rules.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#rules').classList.add('hidden'); });
}

init();
