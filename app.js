import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut, signInWithCustomToken } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { getDatabase, ref, push, query, limitToLast, onChildAdded, serverTimestamp, remove, set, onValue, onChildRemoved, get } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js';
import { firebaseConfig, ownerEmail } from './firebase-config.js';
import { YANDEX_CLIENT_ID, API_BASE } from './config.js';

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
function fmtSize(n) {
  const b = Number(n) || 0;
  if (b <= 0) return '';
  if (b < 1024 * 1024) return Math.max(1, Math.round(b / 1024)) + ' КБ';
  return (b / (1024 * 1024)).toFixed(1).replace('.', ',') + ' МБ';
}
function fileButton(f) {
  const name = safe(f.name || 'файл');
  const size = fmtSize(f.size);
  return `<button type="button" class="file" data-key="${safe(f.key)}" data-name="${name}" aria-label="Скачать файл ${name}"><span class="fi" aria-hidden="true">📄</span><span class="fmeta"><strong>${name}</strong><small>${size ? size + ' · ' : ''}Скачать</small></span></button>`;
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
  node.innerHTML = `${own ? '' : `<div class="sender">${who}</div>`}${m.file ? fileButton(m.file) : ''}${m.file && m.text === m.file.name ? '' : `<div class="body">${safe(m.text || '')}</div>`}<div class="time">${time(m.createdAt)}</div>`;
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
  const yandexBtn = $('#yandexBtn');
  yandexBtn.addEventListener('click', (e) => {
    e.preventDefault();
    loginError.textContent = '';
    if (!YANDEX_CLIENT_ID || !API_BASE) { loginError.textContent = 'Вход через Яндекс пока не настроен.'; return; }
    const back = location.origin + location.pathname;
    location.href = 'https://oauth.yandex.ru/authorize?response_type=token&client_id=' + encodeURIComponent(YANDEX_CLIENT_ID) + '&redirect_uri=' + encodeURIComponent(back);
  });
  const yaToken = new URLSearchParams(location.hash.slice(1)).get('access_token');
  if (yaToken) {
    history.replaceState(null, '', location.pathname + location.search);
    loginBtn.disabled = true;
    yandexBtn.disabled = true;
    fetch(API_BASE + '/yandex-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: yaToken }) })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Не удалось войти через Яндекс.');
        await signInWithCustomToken(auth, d.customToken);
      })
      .catch((err) => { loginError.textContent = err.message || 'Не удалось войти через Яндекс.'; })
      .finally(() => { loginBtn.disabled = false; yandexBtn.disabled = false; });
  }
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
  if (meta) meta.content = theme === 'dark' ? '#121614' : '#f3f1ec';
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

let pendingFile = null;
let sending = false;
const fileInput = $('#file');
const attachBtn = $('#attachBtn');
const chip = $('#filechip');
const sendBtn = $('#send');
const textInput = $('#text');
// Плашка выбранного файла: видно, что файл прикреплён, и его можно убрать до отправки.
function showChip(f) {
  $('#fcName').textContent = f.name;
  $('#fcSize').textContent = fmtSize(f.size) || 'Размер неизвестен';
  chip.classList.remove('sending', 'hidden');
}
function clearFile() {
  pendingFile = null;
  fileInput.value = '';
  attachBtn.classList.remove('on');
  attachBtn.title = 'Прикрепить файл';
  chip.classList.add('hidden');
  chip.classList.remove('sending');
  syncSend();
}
// Кнопка «Отправить» активна только если есть текст или файл и ничего не отправляется.
function syncSend() {
  const ready = Boolean(textInput.value.trim()) || Boolean(pendingFile);
  sendBtn.disabled = !ready || sending;
}
$('#fcRemove').onclick = clearFile;
textInput.addEventListener('input', syncSend);
syncSend();
attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files[0];
  chatError.textContent = '';
  if (!f) return;
  if (f.size > 20 * 1024 * 1024) { chatError.textContent = 'Файл больше 20 МБ.'; fileInput.value = ''; return; }
  pendingFile = f;
  attachBtn.classList.add('on');
  attachBtn.title = f.name;
  showChip(f);
  syncSend();
});
async function uploadFile(f) {
  const idToken = await user.getIdToken();
  const r = await fetch(API_BASE + '/upload-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken, fileName: f.name, size: f.size, contentType: f.type || 'application/octet-stream' }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Не удалось загрузить файл.');
  const put = await fetch(d.uploadUrl, { method: 'PUT', headers: { 'Content-Type': d.contentType }, body: f });
  if (!put.ok) throw new Error('Файл не загрузился, попробуйте ещё раз.');
  return { key: d.key, name: f.name, size: f.size, type: d.contentType };
}
messages.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-key]');
  if (!btn || !user) return;
  btn.disabled = true;
  try {
    const idToken = await user.getIdToken();
    const r = await fetch(API_BASE + '/file-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken, key: btn.dataset.key, name: btn.dataset.name }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Нет доступа к файлу.');
    // Ссылка отдаётся с заголовком attachment: браузер сохраняет файл, вкладка не открывается.
    const a = document.createElement('a');
    a.href = d.url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    chatError.textContent = err.message || 'Не удалось открыть файл.';
  } finally {
    btn.disabled = false;
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
  const caption = input.value.trim().slice(0, 2000);
  const file = pendingFile;
  if ((!caption && !file) || !user || !db) return;
  input.disabled = true;
  sending = true;
  sendBtn.disabled = true;
  sendBtn.classList.add('busy');
  attachBtn.disabled = true;
  if (file) {
    chip.classList.add('sending');
    $('#fcSize').textContent = 'Отправляется…';
  }
  try {
    const data = {
      uid: user.uid,
      name: user.displayName || user.email || 'Участник',
      email: user.email || '',
      text: caption || (file ? file.name : ''),
      createdAt: serverTimestamp()
    };
    if (file) data.file = await uploadFile(file);
    await push(ref(db, 'messages'), data);
    input.value = '';
    clearFile();
    chatError.textContent = '';
  } catch (err) {
    fail(err);
  } finally {
    input.disabled = false;
    sending = false;
    sendBtn.classList.remove('busy');
    attachBtn.disabled = false;
    chip.classList.remove('sending');
    if (pendingFile) $('#fcSize').textContent = fmtSize(pendingFile.size) || 'Размер неизвестен';
    syncSend();
    input.focus();
  }
});
