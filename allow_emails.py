# -*- coding: utf-8 -*-
"""Добавление разрешённых почт в правила Firebase Realtime Database.

Список лежит в emails.json рядом с этой программой.
Опубликовать его в базу может только ключ владельца проекта
(service-account.json). Ключ сайта из firebase-config.js для этого не годится.
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
        + " && newData.child('text').val().length <= 2000)"
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
    print("В базу это попадёт после публикации: пункт 4 или команда publish.")


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
    print("В базу это попадёт после публикации.")


def set_owner(data: dict, raw: str) -> None:
    email = normalize_email(raw)
    if email not in data["emails"]:
        data["emails"].insert(0, email)
    data["owner"] = email
    save(data)
    write_rules_file(data)
    print(f"Владелец: {email}")
    print("Закреплять сообщения сможет только эта почта. Опубликуйте правила.")


def access_token(key_path: Path) -> str:
    try:
        from google.auth.transport.requests import Request
        from google.oauth2 import service_account
    except ImportError as error:
        raise SystemExit(
            "Не хватает библиотеки. Один раз выполните:\n"
            "  pip install google-auth requests"
        ) from error
    creds = service_account.Credentials.from_service_account_file(
        str(key_path), scopes=SCOPES
    )
    creds.refresh(Request())
    if not creds.token:
        raise SystemExit("Google не выдал ключ доступа. Проверьте service-account.json.")
    return creds.token


def publish(data: dict) -> None:
    rules = write_rules_file(data)
    key_path = Path(data["service_account"])
    if not key_path.is_absolute():
        key_path = HERE / key_path
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
    print("Правила опубликованы.")
    print_list(data)
    print("Новая почта заработает сразу, файл на сайте менять не обязательно.")


def menu(data: dict) -> None:
    actions = {
        "1": "list",
        "2": "add",
        "3": "remove",
        "4": "publish",
        "5": "owner",
        "0": "quit",
    }
    while True:
        print()
        print("1  Показать список")
        print("2  Добавить почту")
        print("3  Удалить почту")
        print("4  Опубликовать правила в Firebase")
        print("5  Сменить владельца")
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
    elif command in {"help", "-h", "--help"}:
        print("Запуск без команд открывает меню.")
        print("  python allow_emails.py add name@gmail.com")
        print("  python allow_emails.py remove name@gmail.com")
        print("  python allow_emails.py owner name@gmail.com")
        print("  python allow_emails.py list")
        print("  python allow_emails.py publish")
    else:
        raise SystemExit("Не понял команду. Запустите без аргументов или с help.")


if __name__ == "__main__":
    main(sys.argv[1:])
