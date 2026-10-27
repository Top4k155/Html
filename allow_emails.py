# -*- coding: utf-8 -*-
"""Добавление разрешённых почт в правила Firebase Realtime Database.

Список лежит в emails.json рядом с этой программой.
При запуске программа читает правила базы и подтягивает почты,
которые добавили с телефона. Опубликовать список в базу может
только ключ владельца проекта (service-account.json).
Ключ сайта из firebase-config.js для этого не годится.
Ключ на сайт и в GitHub не класть.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SETTINGS = HERE / "emails.json"
RULES_FILE = HERE / "database.rules.json"

EMAIL_RE = re.compile(r"^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$")
EMAIL_IN_RULES = re.compile(r"auth\.token\.email\s*==\s*'([^']+)'")
SCOPES = [
    "https://www.googleapis.com/auth/firebase.database",
    "https://www.googleapis.com/auth/userinfo.email",
]


def setup_console() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")


def default_settings() -> dict:
    return {
        "database_url": "https://all823218-default-rtdb.firebaseio.com",
        "service_account": "service-account.json",
        "owner": "aleksejmaksinov174@gmail.com",
        "emails": [
            "aleksejmaksinov174@gmail.com",
            "alekseymakmunod@gmail.com",
            "olgamaksinova051@gmail.com",
        ],
    }


def normalize_email(value: str) -> str:
    email = value.strip().lower()
    if not EMAIL_RE.fullmatch(email):
        raise ValueError(f"Это не похоже на почту: {value}")
    return email


def load() -> dict:
    if not SETTINGS.exists():
        data = default_settings()
        save(data)
        return data
    data = json.loads(SETTINGS.read_text(encoding="utf-8"))
    data.setdefault("database_url", default_settings()["database_url"])
    data.setdefault("service_account", "service-account.json")
    emails = []
    for item in data.get("emails", []):
        emails.append(normalize_email(item))
    owner = normalize_email(data.get("owner") or emails[0])
    if owner not in emails:
        emails.insert(0, owner)
    data["owner"] = owner
    data["emails"] = emails
    return data


def save(data: dict) -> None:
    SETTINGS.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def allow_expr(emails: list[str]) -> str:
    checks = " || ".join(f"auth.token.email == '{email}'" for email in emails)
    return (
        "auth != null && auth.token.email_verified == true && ("
        + checks
        + ")"
    )


def build_rules(data: dict) -> dict:
    allowed = allow_expr(data["emails"])
    owner = (
        "auth != null && auth.token.email_verified == true && "
        f"auth.token.email == '{data['owner']}'"
    )
    message_write = (
        allowed
        + " && ("
        + "(newData.exists() && !data.exists()"
        + " && newData.child('uid').val() == auth.uid"
        + " && newData.child('text').isString()"
        + " && newData.child('text').val().length > 0"
        + " && newData.child('text').val().length <= 2000"
        # Почту подставить свою нельзя: она должна совпадать с токеном Google.
        + " && newData.child('email').val() == auth.token.email"
        # Имя только строкой и с разумной длиной (не привязано к токену:
        # у части аккаунтов displayName пустой, и запись бы отвалилась).
        + " && newData.child('name').isString()"
        + " && newData.child('name').val().length <= 120"
        # Пять известных полей, без лишних.
        + " && newData.hasChildren(['uid','name','email','text','createdAt'])"
        # Время ставит сервер, а не браузер. Допуск 60 секунд на неточные часы.
        + " && newData.child('createdAt').isNumber()"
        + " && newData.child('createdAt').val() <= now + 60000"
        + " && newData.child('createdAt').val() >= now - 60000)"
        + " || (data.exists() && !newData.exists()"
        + " && data.child('uid').val() == auth.uid)"
        + ")"
    )
    return {
        "rules": {
            ".read": False,
            ".write": False,
            "messages": {
                ".read": allowed,
                "$id": {".write": message_write},
            },
            "pinnedMessage": {
                ".read": allowed,
                ".write": owner,
            },
        }
    }


def write_rules_file(data: dict) -> dict:
    rules = build_rules(data)
    RULES_FILE.write_text(
        json.dumps(rules, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return rules


def print_list(data: dict) -> None:
    print("Разрешённые почты:")
    for email in data["emails"]:
        mark = "  (владелец, может закреплять)" if email == data["owner"] else ""
        print(f"  {email}{mark}")
    print(f"Всего: {len(data['emails'])}")


def add_email(data: dict, raw: str) -> None:
    email = normalize_email(raw)
    if email in data["emails"]:
        print(f"Уже есть: {email}")
        return
    data["emails"].append(email)
    save(data)
    write_rules_file(data)
    print(f"Добавлено: {email}")
    print("На телефоне это появится после публикации: пункт 4 или команда publish.")


def remove_email(data: dict, raw: str) -> None:
    email = normalize_email(raw)
    if email == data["owner"]:
        print("Нельзя удалить владельца. Сначала назначьте другого: owner новая@почта.ru")
        return
    if email not in data["emails"]:
        print(f"В списке нет: {email}")
        return
    data["emails"].remove(email)
    save(data)
    write_rules_file(data)
    print(f"Удалено: {email}")
    print("В базе это пропадёт после публикации.")


def set_owner(data: dict, raw: str) -> None:
    email = normalize_email(raw)
    if email not in data["emails"]:
        data["emails"].insert(0, email)
    data["owner"] = email
    save(data)
    write_rules_file(data)
    print(f"Владелец: {email}")
    print("Закреплять сообщения сможет только эта почта. Опубликуйте правила.")


def key_path_of(data: dict) -> Path:
    key_path = Path(data["service_account"])
    if not key_path.is_absolute():
        key_path = HERE / key_path
    return key_path


def clock_skew():
    """Насколько часы компьютера отстают от Google.

    На этом компьютере Windows отстаёт примерно на 3 часа, и без поправки
    Google отклоняет ключ. Системное время программа не меняет.
    """
    from datetime import datetime, timedelta, timezone
    from email.utils import parsedate_to_datetime

    import requests

    response = requests.head("https://www.google.com", timeout=15)
    server = parsedate_to_datetime(response.headers["Date"])
    if server.tzinfo is None:
        server = server.replace(tzinfo=timezone.utc)
    local = datetime.now(timezone.utc)
    skew = server - local
    if abs(skew) < timedelta(minutes=2):
        return timedelta(0)
    return skew


def access_token(key_path: Path) -> str:
    try:
        from google.auth import _helpers
        from google.auth.transport.requests import Request
        from google.oauth2 import service_account
    except ImportError as error:
        raise SystemExit(
            "Не хватает библиотеки. Один раз выполните:\n"
            "  pip install google-auth requests"
        ) from error
    skew = clock_skew()
    if skew:
        real_now = _helpers.utcnow
        _helpers.utcnow = lambda: real_now() + skew
    creds = service_account.Credentials.from_service_account_file(
        str(key_path), scopes=SCOPES
    )
    creds.refresh(Request())
    if not creds.token:
        raise SystemExit("Google не выдал ключ доступа. Проверьте service-account.json.")
    return creds.token


def emails_in_text(text: str) -> list[str]:
    found = []
    for match in EMAIL_IN_RULES.finditer(text):
        email = match.group(1).strip().lower()
        if EMAIL_RE.fullmatch(email) and email not in found:
            found.append(email)
    return found


def pull_from_firebase(data: dict) -> dict:
    """Подтянуть почты из правил базы в локальный emails.json.

    База считается источником правды: почта, добавленная на телефоне,
    появляется на компьютере. Почта, которая есть только в файле на
    компьютере и ещё не опубликована, не стирается.
    """
    key_path = key_path_of(data)
    if not key_path.exists():
        print("Ключа нет, список с базы не обновлён. Берётся локальный emails.json.")
        return data
    try:
        import requests
    except ImportError:
        print("Нет библиотеки requests, список с базы не обновлён.")
        print("Один раз выполните: pip install google-auth requests")
        return data
    base = data["database_url"].rstrip("/")
    url = f"{base}/.settings/rules.json"
    try:
        token = access_token(key_path)
        response = requests.get(
            url,
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
    except SystemExit as error:
        print(error)
        print("Список с базы не обновлён.")
        return data
    except Exception as error:
        print(f"Не удалось прочитать правила: {error}")
        print("Берётся локальный список.")
        return data
    if response.status_code >= 400:
        print(f"Firebase не отдал правила: {response.status_code}")
        print(response.text[:400])
        print("Берётся локальный список.")
        return data
    rules = response.json()
    remote = emails_in_text(json.dumps(rules, ensure_ascii=False))
    if not remote:
        print("В правилах базы почт не нашёл, локальный список не трогаю.")
        return data
    pinned = ""
    body = rules.get("rules", rules) if isinstance(rules, dict) else {}
    if isinstance(body, dict):
        pinned = body.get("pinnedMessage", {}).get(".write", "")
    pinned_emails = emails_in_text(pinned if isinstance(pinned, str) else "")
    owner = pinned_emails[0] if pinned_emails else data["owner"]
    if owner not in remote:
        remote.insert(0, owner)
    local = list(data["emails"])
    merged = list(remote)
    only_local = [email for email in local if email not in merged]
    merged.extend(only_local)
    added = [email for email in remote if email not in local]
    data["emails"] = merged
    data["owner"] = owner if owner in merged else merged[0]
    save(data)
    write_rules_file(data)
    if added:
        print("С базы (то, что меняли на телефоне) подтянуто:")
        for email in added:
            print(f"  {email}")
    if only_local:
        print("Только на компьютере, в базе ещё нет:")
        for email in only_local:
            print(f"  {email}")
        print("На телефоне они появятся после публикации, пункт 4.")
    if not added and not only_local:
        print("Список почт совпадает с правилами базы.")
    return data


def publish(data: dict) -> None:
    rules = write_rules_file(data)
    key_path = key_path_of(data)
    if not key_path.exists():
        print("Ключа владельца рядом нет, в базу ничего не отправлено.")
        print(f"Правила сохранены в файл: {RULES_FILE.name}")
        print("Их можно вставить вручную: Firebase → Realtime Database → Rules → Publish.")
        print("Либо положите сюда service-account.json и запустите публикацию снова.")
        print("Как получить ключ: Firebase → шестерёнка → Project settings →")
        print("Service accounts → Generate new private key. Файл скачается один раз.")
        print("Этот файл никому не отправляйте и на сайт не кладите.")
        return
    try:
        import requests
    except ImportError as error:
        raise SystemExit("Не хватает библиотеки. Выполните: pip install requests") from error
    base = data["database_url"].rstrip("/")
    url = f"{base}/.settings/rules.json"
    token = access_token(key_path)
    response = requests.put(
        url,
        json=rules,
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    if response.status_code >= 400:
        print(f"Firebase отказал: {response.status_code}")
        print(response.text[:800])
        print("Ключ должен быть от этого же проекта, роль Editor или Firebase Admin.")
        raise SystemExit(1)
    print("Правила опубликованы. Этот список теперь и в базе, и на компьютере.")
    print_list(data)


def menu(data: dict) -> None:
    actions = {
        "1": "list",
        "2": "add",
        "3": "remove",
        "4": "publish",
        "5": "owner",
        "6": "pull",
        "0": "quit",
    }
    while True:
        print()
        print("1  Показать список")
        print("2  Добавить почту")
        print("3  Удалить почту")
        print("4  Опубликовать правила в Firebase")
        print("5  Сменить владельца")
        print("6  Обновить список из базы")
        print("0  Выход")
        choice = input("> ").strip()
        command = actions.get(choice)
        if command == "quit":
            return
        if command == "list":
            print_list(data)
        elif command == "add":
            run(add_email, data, input("Почта: "))
        elif command == "remove":
            run(remove_email, data, input("Почта: "))
        elif command == "publish":
            publish(data)
        elif command == "owner":
            run(set_owner, data, input("Почта владельца: "))
        elif command == "pull":
            fresh = pull_from_firebase(data)
            data.update(fresh)
            print_list(data)
        else:
            print("Нет такого пункта.")


def run(action, *args) -> None:
    try:
        action(*args)
    except ValueError as error:
        print(error)


def main(argv: list[str]) -> None:
    setup_console()
    data = load()
    print("Сверяю список с правилами Firebase...")
    data = pull_from_firebase(data)
    write_rules_file(data)
    if not argv:
        print("Разрешённые почты чата")
        print_list(data)
        menu(data)
        return
    command, *rest = argv
    command = command.lower()
    if command in {"list", "ls"}:
        print_list(data)
    elif command == "add" and rest:
        run(add_email, data, rest[0])
    elif command in {"remove", "rm", "del"} and rest:
        run(remove_email, data, rest[0])
    elif command == "owner" and rest:
        run(set_owner, data, rest[0])
    elif command in {"publish", "push"}:
        publish(data)
    elif command in {"pull", "sync", "update"}:
        data = pull_from_firebase(data)
        print_list(data)
    elif command in {"help", "-h", "--help"}:
        print("Запуск без команд открывает меню и сначала читает почты из базы.")
        print("  python allow_emails.py add name@gmail.com")
        print("  python allow_emails.py remove name@gmail.com")
        print("  python allow_emails.py owner name@gmail.com")
        print("  python allow_emails.py list")
        print("  python allow_emails.py pull")
        print("  python allow_emails.py publish")
    else:
        raise SystemExit("Не понял команду. Запустите без аргументов или с help.")


if __name__ == "__main__":
    main(sys.argv[1:])
