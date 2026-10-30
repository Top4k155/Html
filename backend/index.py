"""Серверная часть чата: вход через Яндекс ID.

Функция Яндекс Облака (Python 3.12), вызывается через API Gateway.
Секреты берутся из переменных окружения функции, в коде их нет:
  FIREBASE_SA_JSON  - JSON ключа сервисного аккаунта Firebase
  FIREBASE_DB_URL   - https://<проект>-default-rtdb.firebaseio.com
  OWNER_EMAIL       - почта владельца (на случай, если в базе ещё нет access/owner)
"""

import datetime
import hashlib
import hmac
import json
import os
import re
import urllib.parse
import uuid

import firebase_admin
import requests
from firebase_admin import auth as fb_auth
from firebase_admin import credentials, db as fb_db

YANDEX_INFO = "https://login.yandex.ru/info?format=json"
ALLOWED_ORIGIN = "https://top4k155.github.io"
JSON_HEADERS = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
}

_app = None


def _init_firebase():
    global _app
    if _app is None:
        cred = credentials.Certificate(json.loads(os.environ["FIREBASE_SA_JSON"]))
        _app = firebase_admin.initialize_app(cred, {"databaseURL": os.environ["FIREBASE_DB_URL"]})
    return _app


def _reply(status, body):
    return {"statusCode": status, "headers": JSON_HEADERS, "body": json.dumps(body, ensure_ascii=False)}


def _allowed_emails():
    """Список почт из access/emails (упакован как ',a,b,'). Владелец всегда допущен."""
    _init_firebase()
    access = fb_db.reference("access").get() or {}
    owner = str(access.get("owner") or os.environ.get("OWNER_EMAIL", "")).lower()
    packed = str(access.get("emails") or "")
    emails = {e for e in packed.lower().split(",") if e}
    if owner:
        emails.add(owner)
    return emails


def _yandex_profile(token):
    """Проверяет токен Яндекс ID и возвращает профиль или None."""
    try:
        r = requests.get(YANDEX_INFO, headers={"Authorization": "OAuth " + token}, timeout=5)
    except requests.RequestException:
        return None
    if r.status_code != 200:
        return None
    data = r.json()
    if not data.get("id") or not data.get("default_email"):
        return None
    return {
        "id": str(data["id"]),
        "email": str(data["default_email"]).lower(),
        "name": str(data.get("real_name") or data.get("display_name") or data.get("login") or "Участник")[:120],
    }


def _login_yandex(body):
    token = str(body.get("accessToken") or "")
    if not token or len(token) > 512:
        return _reply(400, {"error": "Нет токена входа."})
    profile = _yandex_profile(token)
    if not profile:
        return _reply(401, {"error": "Яндекс не подтвердил вход. Попробуйте ещё раз."})
    if profile["email"] not in _allowed_emails():
        return _reply(403, {"error": "Этой почты нет в списке участников чата."})

    claims = {"email": profile["email"], "email_verified": True}
    try:
        # Почта уже есть в Firebase (например, вход через Google): это тот же участник.
        uid = fb_auth.get_user_by_email(profile["email"]).uid
        fb_auth.update_user(uid, display_name=profile["name"])
    except fb_auth.UserNotFoundError:
        uid = "ya-" + profile["id"]
        try:
            fb_auth.get_user(uid)
            fb_auth.update_user(uid, email=profile["email"], email_verified=True, display_name=profile["name"])
        except fb_auth.UserNotFoundError:
            fb_auth.create_user(uid=uid, email=profile["email"], email_verified=True, display_name=profile["name"])
    custom = fb_auth.create_custom_token(uid, claims)
    if isinstance(custom, bytes):
        custom = custom.decode()
    return _reply(200, {"customToken": custom})


MAX_FILE_BYTES = 20 * 1024 * 1024
URL_TTL = 300
S3_REGION = "ru-central1"
S3_SUFFIX = "storage.yandexcloud.net"
SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")
KEY_RE = re.compile(r"[A-Za-z0-9_-]{1,128}/[0-9a-f]{32}-[A-Za-z0-9._-]{1,120}")


def _hmac(key, msg):
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _presign(method, key, extra=None):
    """Подписанная ссылка Object Storage (AWS SigV4 в query), без boto3.
    extra: дополнительные параметры запроса (например, response-content-disposition), они тоже подписываются."""
    bucket = os.environ["S3_BUCKET"]
    host = S3_SUFFIX
    now = datetime.datetime.now(datetime.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date = now.strftime("%Y%m%d")
    scope = date + "/" + S3_REGION + "/s3/aws4_request"
    uri = "/" + bucket + "/" + urllib.parse.quote(key, safe="/-_.~")
    params = {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": os.environ["S3_KEY_ID"] + "/" + scope,
        "X-Amz-Date": amz_date,
        "X-Amz-Expires": str(URL_TTL),
        "X-Amz-SignedHeaders": "host",
    }
    params.update(extra or {})
    query = "&".join(
        urllib.parse.quote(k, safe="-_.~") + "=" + urllib.parse.quote(v, safe="-_.~")
        for k, v in sorted(params.items())
    )
    canonical = "\n".join([method, uri, query, "host:" + host + "\n", "host", "UNSIGNED-PAYLOAD"])
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical.encode("utf-8")).hexdigest()])
    k = _hmac(("AWS4" + os.environ["S3_SECRET"]).encode("utf-8"), date)
    k = _hmac(k, S3_REGION)
    k = _hmac(k, "s3")
    k = _hmac(k, "aws4_request")
    signature = hmac.new(k, to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    return "https://" + host + uri + "?" + query + "&X-Amz-Signature=" + signature


def _verify_user(id_token):
    """Проверяет ID-токен Firebase и возвращает uid, если почта допущена в чат."""
    _init_firebase()
    try:
        decoded = fb_auth.verify_id_token(id_token, check_revoked=False)
    except Exception:
        return None
    email = str(decoded.get("email") or "").lower()
    if not email or decoded.get("email_verified") is not True:
        return None
    if email not in _allowed_emails():
        return None
    return decoded["uid"]


def _safe_key(uid, file_name):
    uid = re.sub(r"[^A-Za-z0-9_-]", "_", str(uid))[:100]
    base = SAFE_NAME.sub("_", os.path.basename(str(file_name or "file")))[:100] or "file"
    return uid + "/" + uuid.uuid4().hex + "-" + base


def _upload_url(body):
    uid = _verify_user(str(body.get("idToken") or ""))
    if not uid:
        return _reply(403, {"error": "Нет доступа."})
    try:
        size = int(body.get("size") or 0)
    except (TypeError, ValueError):
        size = 0
    if size <= 0 or size > MAX_FILE_BYTES:
        return _reply(400, {"error": "Файл больше 20 МБ или пустой."})
    content_type = str(body.get("contentType") or "application/octet-stream")[:100]
    key = _safe_key(uid, body.get("fileName"))
    return _reply(200, {"uploadUrl": _presign("PUT", key), "key": key, "contentType": content_type})


def _download_name(body, key):
    """Имя для сохранения: исходное имя из сообщения, без управляющих символов, либо имя из ключа."""
    name = str(body.get("name") or "").replace("\r", "").replace("\n", "").strip()[:200]
    if not name:
        name = key.split("-", 1)[-1] if "-" in key else "file"
    return name


def _file_url(body):
    if not _verify_user(str(body.get("idToken") or "")):
        return _reply(403, {"error": "Нет доступа."})
    key = str(body.get("key") or "")
    if not KEY_RE.fullmatch(key):
        return _reply(400, {"error": "Неверный файл."})
    name = _download_name(body, key)
    # Заголовок ответа: браузер сохранит файл, а не откроет его во вкладке.
    ascii_name = re.sub(r"[^A-Za-z0-9._-]+", "_", name) or "file"
    disposition = "attachment; filename=\"" + ascii_name + "\"; filename*=UTF-8''" + urllib.parse.quote(name, safe="")
    return _reply(200, {"url": _presign("GET", key, {"response-content-disposition": disposition})})


ROUTES = {
    "/yandex-login": _login_yandex,
    "/upload-url": _upload_url,
    "/file-url": _file_url,
}


def handler(event, context):
    method = (event.get("httpMethod") or "").upper()
    path = (event.get("path") or "").rstrip("/")
    if method == "OPTIONS":
        return _reply(204, {})
    if method != "POST":
        return _reply(405, {"error": "Только POST."})
    fn = ROUTES.get(path)
    if fn is None:
        return _reply(404, {"error": "Нет такого действия."})
    raw = event.get("body") or "{}"
    if len(raw) > 8192:
        return _reply(413, {"error": "Слишком большой запрос."})
    try:
        body = json.loads(raw)
    except ValueError:
        return _reply(400, {"error": "Некорректный запрос."})
    if not isinstance(body, dict):
        return _reply(400, {"error": "Некорректный запрос."})
    try:
        return fn(body)
    except Exception:
        return _reply(500, {"error": "Ошибка сервера, попробуйте позже."})
