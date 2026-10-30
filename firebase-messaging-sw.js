// Service worker для уведомлений о новых сообщениях.
// Лежит в корне сайта рядом с index.html: браузер требует, чтобы он был по этому адресу.
importScripts('https://www.gstatic.com/firebasejs/11.10.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.10.0/firebase-messaging-compat.js');

// Публичные параметры проекта (как в firebase-config.js), секретов здесь нет.
firebase.initializeApp({
  apiKey: 'AIzaSyA_yYo3Tw5Yf-uqwxHNG939XPAqfR2y2sQ',
  authDomain: 'all823218.firebaseapp.com',
  projectId: 'all823218',
  appId: '1:887986973315:web:ffb5229794697a80b289b6',
  messagingSenderId: '887986973315',
});

const messaging = firebase.messaging();

// Сообщения приходят только с данными (без блока notification), показываем сами.
messaging.onBackgroundMessage(async (payload) => {
  // Если вкладка чата открыта и видна, уведомление не нужно: сообщение и так видно на экране.
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (wins.some((w) => w.visibilityState === 'visible')) return;
  const d = payload.data || {};
  return self.registration.showNotification(d.title || 'Новое сообщение', {
    body: d.body || '',
    tag: 'chat-message',
    renotify: true,
    icon: './favicon.svg',
    data: { url: d.url || './' },
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if ('focus' in w) return w.focus();
    }
    return self.clients.openWindow(url);
  })());
});
