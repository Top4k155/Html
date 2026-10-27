import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { getDatabase, ref, push, query, limitToLast, onChildAdded, serverTimestamp, remove, set, onValue, onChildRemoved, get } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js';
import { firebaseConfig, ownerEmail } from './firebase-config.js';

const $ = (s) => document.querySelector(s);
const login = $('#login');
const appBox = $('#app');
const loginError = $('#loginError');
const status = $('#status');
const feed = $('#feed');
const messages = $('#messages');
const chatError = $('#chatError');
const menu = $('#messageMenu');

let auth;
let db;
let user;
let stopMessages;
let stopPin;
let stopConn;
let stopOwner;
let stickToBottom = true;
let menuPin = '';
// Владельца держим в одном месте — firebase-config.js, рядом с параметрами проекта.
const OWNER_EMAIL = String(ownerEmail || '').toLowerCase();
const placeholder = !firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith('ВСТАВЬТЕ') || firebaseConfig.projectId === 'ВАШ-ПРОЕКТ';

function safe(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function clockMode() {
  try { return localStorage.getItem('chat-clock-mode') || 'auto'; } catch { return 'auto'; }
}
function time(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  try {
    const mode = clockMode();
    const opts = { hour: 'numeric', minute: '2-digit' };
    if (mode === '12') opts.hour12 = true;
    if (mode === '24') opts.hour12 = false;
    return new Intl.DateTimeFormat(undefined, opts).format(new Date(n));
  } catch {
    return 'сейчас';
  }
}
function refreshTimes() {
  document.querySelectorAll('.msg').forEach((node) => {
    const stamp = node.dataset.timestamp;
    const target = node.querySelector('.time');
    if (target && stamp) target.textContent = time(stamp);
  });
}
function hiddenKey() {
  return 'chat-hidden-messages:' + (user?.uid || 'none');
}
function hiddenIds() {
  try {
    const parsed = JSON.parse(localStorage.getItem(hiddenKey()) || '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}
function rememberHidden(id) {
  const hidden = [...new Set([...hiddenIds(), id])].slice(-500);
  try { localStorage.setItem(hiddenKey(), JSON.stringify(hidden)); } catch {}
}
function isOwn(m) {
  return typeof user?.uid === 'string' && user.uid.length > 0 && m?.uid === user.uid;
}
let dbOwner = String(OWNER_EMAIL || '');
function isOwner() {
  return Boolean(dbOwner) && Boolean(user?.email) && user.email.toLowerCase() === dbOwner;
}
// Владелец может быть переназначен в админ-панели: она пишет access/owner в базу,
// поэтому закрепление и ссылка на панель переходят к новому владельцу сами.
function watchOwner() {
  try {
    return onValue(ref(db, 'access/owner'), (snap) => {
      const next = String(snap.val() || '').toLowerCase();
      if (next && next !== dbOwner) {
        dbOwner = next;
        syncAdminLink();
      }
    }, () => {});
  } catch {
    return undefined;
  }
}
function syncAdminLink() {
  const link = document.getElementById('adminLink');
  if (link) link.classList.toggle('hidden', !isOwner());
}
function showError(e) {
  const code = e?.code || '';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return 'Вход отменён.';
  if (code === 'auth/network-request-failed') return 'Нет сети. Проверьте интернет и попробуйте снова.';
  if (code.includes('PERMISSION_DENIED') || code.includes('permission_denied') || code.includes('permission-denied')) return 'Вы не в разрешенном списке пользователей, Обратитесь к администратору';
  if (code === 'auth/unauthorized-domain') return 'Добавьте адрес сайта в Authentication → Settings → Authorized domains.';
  return e?.message || 'Не удалось подключиться.';
}
function fail(e) {
  chatError.textContent = showError(e);
  if (String(e?.code || '').includes('permission')) status.textContent = 'нет доступа к базе';
}
function animateRemove(node) {
  if (!node || node.dataset.removing) return;
  node.dataset.removing = '1';
  const r = node.getBoundingClientRect();
  for (let i = 0; i < 18; i++) {
    const bit = document.createElement('i');
    bit.className = 'msg-piece';
    bit.style.left = (r.left + Math.random() * r.width) + 'px';
    bit.style.top = (r.top + Math.random() * r.height) + 'px';
    bit.style.setProperty('--dx', ((Math.random() - 0.5) * 220) + 'px');
    bit.style.setProperty('--dy', ((Math.random() - 0.65) * 190) + 'px');
    bit.style.setProperty('--rot', ((Math.random() - 0.5) * 600) + 'deg');
    document.body.append(bit);
    setTimeout(() => bit.remove(), 700);
  }
  node.classList.add('msg-removing');
  setTimeout(() => { node.remove(); refreshEmpty(); refreshSenders(); }, 500);
}
function closeMenu() {
  menu.classList.add('hidden');
  delete menu.dataset.id;
  delete menu.dataset.own;
  menuPin = '';
}
function safeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}
function closeSettings() {
  const panel = $('#settingsPanel');
  if (!panel || panel.classList.contains('hidden')) return;
  panel.classList.add('settings-closing');
  setTimeout(() => {
    panel.classList.add('hidden');
    panel.classList.remove('settings-closing');
  }, 180);
}
function nearBottom() {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
}
function refreshEmpty() {
  const empty = document.getElementById('empty');
  if (!empty) return;
  empty.classList.toggle('hidden', messages.children.length > 0);
}
function refreshSenders() {
  let prev = null;
  for (const node of messages.children) {
    const sender = node.querySelector('.sender');
    if (!sender) { prev = null; continue; }
    const uid = node.dataset.uid || '';
    const same = prev !== null && uid !== '' && uid === prev;
    sender.classList.toggle('sr-only', same);
    prev = uid;
  }
}
function findMessage(id) {
  if (!id) return null;
  return messages.querySelector(`[data-id="${CSS.escape(id)}"]`);
}
function addMessage(id, m) {
  if (!id || !user) return;
  if (findMessage(id)) return;
  if (hiddenIds().includes(id)) return;
  const own = isOwn(m);
  const follow = stickToBottom || own || nearBottom();
  const node = document.createElement('article');
  node.className = 'msg ' + (own ? 'mine' : 'other');
  node.dataset.id = id;
  node.dataset.uid = typeof m.uid === 'string' ? m.uid : '';
  node.dataset.timestamp = Number.isFinite(Number(m.createdAt)) ? String(Number(m.createdAt)) : '';
  const who = safe(m.name || m.email || 'Участник');
  node.innerHTML = `${own ? '' : `<div class="sender">${who}</div>`}<div class="body">${safe(m.text || '')}</div><div class="time">${time(m.createdAt)}</div>`;
  messages.append(node);
  bindMessageMenu(node, id, m);
  refreshSenders();
  refreshEmpty();
  if (follow) feed.scrollTop = feed.scrollHeight;
}
function bindMessageMenu(node, id, m) {
  let timer;
  let hold = false;
  let startX = 0;
  let startY = 0;
  const open = (x, y) => {
    if (!user) return;
    menu.dataset.id = id;
    menu.dataset.own = isOwn(m) ? '1' : '0';
    menuPin = String(m.text || '');
    menu.innerHTML = `<button type="button" data-action="delete-local">Удалить у меня</button>${isOwn(m) ? '<button type="button" data-action="delete">Удалить у всех</button>' : ''}${isOwner() ? '<button type="button" data-action="pin">Закрепить сообщение</button>' : ''}`;
    menu.classList.remove('hidden');
    const width = menu.offsetWidth || 180;
    const height = menu.offsetHeight || 44;
    menu.style.left = Math.max(8, Math.min(x, innerWidth - width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - height - 8)) + 'px';
  };
  node.addEventListener('contextmenu', (e) => { e.preventDefault(); open(e.clientX, e.clientY); });
  node.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    hold = false;
    startX = e.clientX;
    startY = e.clientY;
    timer = setTimeout(() => { hold = true; open(e.clientX, e.clientY); }, 550);
  });
  node.addEventListener('pointermove', (e) => {
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 12) clearTimeout(timer);
  });
  node.addEventListener('pointerup', () => clearTimeout(timer));
  node.addEventListener('pointercancel', () => clearTimeout(timer));
  node.addEventListener('click', (e) => {
    if (!hold) return;
    e.preventDefault();
    e.stopPropagation();
    hold = false;
  });
}
function listenPin() {
  stopPin?.();
  stopPin = onValue(ref(db, 'pinnedMessage'), (snap) => {
    const p = snap.val();
    const bar = $('#pinbar');
    if (p?.text) {
      bar.classList.add('visible');
      $('#pintext').textContent = String(p.text);
      $('#unpin').classList.toggle('hidden', !isOwner());
    } else {
      bar.classList.remove('visible');
      $('#pintext').textContent = '';
    }
  }, fail);
}
function listen() {
  stopMessages?.();
  messages.replaceChildren();
  stickToBottom = true;
  stopOwner?.();
  stopOwner = watchOwner();
  syncAdminLink();
  status.textContent = 'Соединяемся…';
  chatError.textContent = '';
  const q = query(ref(db, 'messages'), limitToLast(100));
  const stopAdded = onChildAdded(q, (s) => addMessage(s.key, s.val() || {}), fail);
  // Удаления слушаем на том же ограниченном запросе, иначе клиент скачивает всю переписку.
  const stopRemoved = onChildRemoved(q, (s) => {
    animateRemove(findMessage(s.key));
  }, fail);
  stopMessages = () => { stopAdded(); stopRemoved(); };
  listenPin();
  refreshEmpty();
  stopConn?.();
  stopConn = onValue(ref(db, '.info/connected'), (snap) => {
    status.textContent = snap.val() ? 'Подключено' : 'Нет сети, ждём связь';
  });
  setTimeout(() => {
    stickToBottom = false;
    feed.scrollTop = feed.scrollHeight;
  }, 0);
}
function stopAll() {
  stopMessages?.();
  stopMessages = null;
  stopPin?.();
  stopPin = null;
  stopConn?.();
  stopConn = null;
  stopOwner?.();
  stopOwner = null;
  user = null;
  messages.replaceChildren();
  $('#pinbar')?.classList.remove('visible');
  $('#pintext').textContent = '';
  closeMenu();
  closeSettings();
  const photo = $('#photo');
  photo.classList.add('hidden');
  photo.removeAttribute('src');
}
function showPhoto(url) {
  const photo = $('#photo');
  if (typeof url === 'string' && url.startsWith('https://')) {
    photo.src = url;
    photo.classList.remove('hidden');
    return;
  }
  photo.classList.add('hidden');
  photo.removeAttribute('src');
}
function bindViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => {
    appBox.style.height = Math.round(vv.height) + 'px';
    appBox.style.transform = vv.offsetTop ? `translateY(${Math.round(vv.offsetTop)}px)` : '';
    if (document.activeElement === $('#text')) feed.scrollTop = feed.scrollHeight;
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
}
function wantsRedirect() {
  return matchMedia('(pointer:coarse)').matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

bindViewport();
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

if (!placeholder) {
  const firebase = initializeApp(firebaseConfig);
  auth = getAuth(firebase);
  db = getDatabase(firebase);
  const loginBtn = $('#loginBtn');
  loginBtn.disabled = true;
  getRedirectResult(auth).catch((e) => { loginError.textContent = showError(e); }).finally(() => { loginBtn.disabled = false; });
  loginBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    loginBtn.disabled = true;
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
      loginError.textContent = showError(err);
    } finally {
      loginBtn.disabled = false;
    }
  });
  const ACCESS_DENIED = 'Вы не в разрешенном списке пользователей, Обратитесь к администратору';
  let pendingLoginError = '';
  let checkingAccess = false;
  function deniedByRules(err) {
    const blob = `${err?.code || ''} ${err?.message || ''}`;
    return /permission[-_ ]denied/i.test(blob);
  }
  async function openChatIfAllowed(u) {
    if (!u || checkingAccess) return;
    if (user?.uid === u.uid && stopMessages) return;
    checkingAccess = true;
    login.classList.remove('hidden');
    appBox.classList.add('hidden');
    loginError.textContent = 'Проверяем доступ…';
    loginBtn.disabled = true;
    try {
      await get(query(ref(db, 'messages'), limitToLast(1)));
    } catch (err) {
      login.classList.remove('hidden');
      appBox.classList.add('hidden');
      if (deniedByRules(err)) {
        pendingLoginError = ACCESS_DENIED;
        loginError.textContent = ACCESS_DENIED;
        try { await signOut(auth); } catch {}
        return;
      }
      loginError.textContent = showError(err);
      return;
    } finally {
      checkingAccess = false;
      loginBtn.disabled = false;
    }
    if (auth.currentUser?.uid !== u.uid) return;
    stopMessages?.();
    stopMessages = null;
    messages.replaceChildren();
    user = u;
    loginError.textContent = '';
    login.classList.add('hidden');
    appBox.classList.remove('hidden');
    status.textContent = u.email || 'Вход выполнен';
    showPhoto(u.photoURL);
    listen();
  }
  loginBtn.addEventListener('click', async (e) => {
    if (!auth.currentUser) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    await openChatIfAllowed(auth.currentUser);
  }, true);
  onAuthStateChanged(auth, (u) => {
    if (!u) {
      stopAll();
      appBox.classList.add('hidden');
      login.classList.remove('hidden');
      loginError.textContent = pendingLoginError;
      pendingLoginError = '';
      return;
    }
    openChatIfAllowed(u);
  });
} else {
  $('#loginBtn').addEventListener('click', (e) => {
    e.preventDefault();
    loginError.textContent = 'Сначала укажите настройки Firebase в firebase-config.js.';
  });
  status.textContent = 'Настройте Firebase';
}

$('#clockMode').value = ['auto', '12', '24'].includes(clockMode()) ? clockMode() : 'auto';
$('#settingsBtn').onclick = () => $('#settingsPanel').classList.remove('hidden');
$('#settingsClose').onclick = closeSettings;
$('#settingsPanel').onclick = (e) => { if (e.target === $('#settingsPanel')) closeSettings(); };
$('#clockMode').onchange = (e) => {
  const mode = e.target.value;
  try { localStorage.setItem('chat-clock-mode', mode); } catch {}
  refreshTimes();
};
function themeMode() {
  try { return localStorage.getItem('chat-theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}
function applyTheme(mode) {
  const theme = mode === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'dark' ? '#0e1621' : '#f6f7f9';
}
applyTheme(themeMode());
$('#themeMode').value = themeMode();
$('#themeMode').onchange = (e) => {
  const mode = e.target.value === 'dark' ? 'dark' : 'light';
  try { localStorage.setItem('chat-theme', mode); } catch {}
  applyTheme(mode);
};
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeSettings();
  closeMenu();
});
feed.addEventListener('scroll', closeMenu, { passive: true });
window.addEventListener('resize', closeMenu);

document.addEventListener('click', async (e) => {
  if (!e.target.closest('#messageMenu')) {
    closeMenu();
    return;
  }
  const action = e.target.closest('button')?.dataset.action;
  const id = menu.dataset.id;
  const pinText = menuPin;
  const own = menu.dataset.own === '1';
  if (!action || !safeId(id) || !user) return;
  closeMenu();
  try {
    if (action === 'delete-local') {
      rememberHidden(id);
      animateRemove(findMessage(id));
      return;
    }
    if (action === 'delete') {
      if (!own) return;
      if (!confirm('Удалить это сообщение у всех участников?')) return;
      await remove(ref(db, `messages/${id}`));
      return;
    }
    if (action === 'pin') {
      if (!isOwner()) return;
      const text = pinText.trim().slice(0, 2000);
      if (!text) return;
      await set(ref(db, 'pinnedMessage'), { text, by: user.email, createdAt: Date.now() });
    }
  } catch (err) {
    fail(err);
  }
});

$('#unpin').onclick = async () => {
  if (!isOwner()) return;
  try { await remove(ref(db, 'pinnedMessage')); }
  catch (e) { fail(e); }
};
$('#logout').onclick = () => auth && signOut(auth);
$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#text');
  const text = input.value.trim().slice(0, 2000);
  if (!text || !user || !db) return;
  input.disabled = true;
  try {
    await push(ref(db, 'messages'), {
      uid: user.uid,
      name: user.displayName || user.email || 'Участник',
      email: user.email || '',
      text,
      createdAt: serverTimestamp()
    });
    input.value = '';
    chatError.textContent = '';
  } catch (err) {
    fail(err);
  } finally {
    input.disabled = false;
    input.focus();
  }
});
