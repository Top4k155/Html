// Параметры Web-приложения из Firebase Console → Project settings → Your apps.
// Это не пароль. Не публикуйте service account key или приватные ключи.
// Кто может войти, решают правила Realtime Database, не этот файл.
export const firebaseConfig = {
  apiKey: "AIzaSyA_yYo3Tw5Yf-uqwxHNG939XPAqfR2y2sQ",
  authDomain: "all823218.firebaseapp.com",
  databaseURL: "https://all823218-default-rtdb.firebaseio.com",
  projectId: "all823218",
  appId: "1:887986973315:web:ffb5229794697a80b289b6",
  // Sender ID для уведомлений: номер проекта из Project settings → Cloud Messaging.
  messagingSenderId: "887986973315"
};

// Владелец чата: может закреплять и откреплять сообщения.
// Это единственное место, где адрес вписан руками: allow_emails.py при команде
// owner переписывает эту строку сам, поэтому сайт и правила базы не разъезжаются.
export const ownerEmail = "aleksejmaksinov174@gmail.com";
