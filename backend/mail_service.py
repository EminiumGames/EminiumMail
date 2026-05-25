#!/usr/bin/env python3

from __future__ import annotations

import argparse
import email
import imaplib
import json
import os
import re
import subprocess
import threading
import time
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from email.header import decode_header, make_header
from email.message import Message as EmailMessage
from email.parser import BytesParser
from email.policy import default as email_policy
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
STATE_FILE = DATA_DIR / "state.json"
REGISTRY_KEY = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run"
REGISTRY_VALUE = "EminiumMail"


@dataclass
class Account:
    id: str
    label: str
    host: str
    port: int
    encryption: str
    username: str
    password: str
    folder: str = "INBOX"
    pollInterval: int = 60
    last_uid: int = 0
    unreadCount: int = 0
    lastSyncAt: str = ""
    lastError: str = ""


@dataclass
class Message:
    id: str
    accountId: str
    accountLabel: str
    uid: int
    from_: str
    subject: str
    date: str
    snippet: str
    bodyText: str
    bodyHtml: str
    read: bool = False
    hasHtml: bool = False
    sortKey: int = 0


@dataclass
class Settings:
    autostartEnabled: bool = False
    launcherPath: str = ""


class State:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.settings = Settings()
        self.accounts: list[Account] = []
        self.messages: list[Message] = []
        self.events: list[dict[str, Any]] = []
        self.next_event_id = 1
        self.load()

    def load(self) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        if not STATE_FILE.exists():
            self.save()
            return

        try:
            raw = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            return

        settings = raw.get("settings", {})
        self.settings = Settings(
            autostartEnabled=bool(settings.get("autostartEnabled", False)),
            launcherPath=str(settings.get("launcherPath", "")),
        )
        self.accounts = [Account(**item) for item in raw.get("accounts", [])]
        self.messages = [Message(**item) for item in raw.get("messages", [])]
        self.events = raw.get("events", [])
        if self.events:
            self.next_event_id = max(event.get("id", 0) for event in self.events) + 1

    def save(self) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        payload = {
            "settings": asdict(self.settings),
            "accounts": [asdict(account) for account in self.accounts],
            "messages": [asdict(message) for message in self.messages],
            "events": self.events[-200:],
        }
        STATE_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def add_event(self, event_type: str, title: str, message: str, account_id: str = "", message_id: str = "") -> None:
        self.events.append(
            {
                "id": self.next_event_id,
                "type": event_type,
                "title": title,
                "message": message,
                "accountId": account_id,
                "messageId": message_id,
                "createdAt": now_iso(),
            }
        )
        self.next_event_id += 1
        self.events = self.events[-200:]


STATE = State()
POLL_LOCK = threading.Lock()


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower())
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug or "account"


def decode_mime(value: Optional[str]) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


def get_part_payload(part: EmailMessage) -> str:
    try:
        return part.get_content()
    except Exception:
        payload = part.get_payload(decode=True)
        if not payload:
            return ""
        charset = part.get_content_charset() or "utf-8"
        try:
            return payload.decode(charset, errors="replace")
        except Exception:
            return payload.decode("utf-8", errors="replace")


def extract_body(msg: EmailMessage) -> tuple[str, str, bool]:
    text_parts: list[str] = []
    html_parts: list[str] = []

    if msg.is_multipart():
        for part in msg.walk():
            content_type = part.get_content_type()
            if part.get_content_disposition() == "attachment":
                continue
            payload = get_part_payload(part)
            if content_type == "text/plain" and payload:
                text_parts.append(payload)
            elif content_type == "text/html" and payload:
                html_parts.append(payload)
    else:
        payload = get_part_payload(msg)
        if msg.get_content_type() == "text/html":
            html_parts.append(payload)
        else:
            text_parts.append(payload)

    text_body = "\n\n".join(text_parts).strip()
    html_body = "\n\n".join(html_parts).strip()
    return text_body, html_body, bool(html_body)


def snippet_for(text: str) -> str:
    return " ".join(text.split())[:240]


def connect_account(account: Account) -> imaplib.IMAP4:
    if account.encryption == "ssl":
        client: imaplib.IMAP4 = imaplib.IMAP4_SSL(account.host, account.port, timeout=20)
    else:
        client = imaplib.IMAP4(account.host, account.port, timeout=20)

    if account.encryption == "starttls":
        client.starttls()

    client.login(account.username, account.password)
    return client


def fetch_new_messages(account: Account) -> tuple[int, list[Message]]:
    client = connect_account(account)
    try:
        status, _ = client.select(account.folder, readonly=True)
        if status != "OK":
            raise RuntimeError(f"Impossible d'ouvrir le dossier {account.folder}")

        search_start = account.last_uid + 1
        status, data = client.uid("SEARCH", None, f"UID {search_start}:*")
        if status != "OK":
            raise RuntimeError("Recherche IMAP impossible")

        uids = [int(item) for item in data[0].split()] if data and data[0] else []
        if not uids:
            return account.last_uid, []

        messages: list[Message] = []
        highest_uid = account.last_uid
        for uid in uids:
            status, fetched = client.uid("FETCH", str(uid), "(RFC822)")
            if status != "OK" or not fetched:
                continue

            raw_bytes = None
            for entry in fetched:
                if isinstance(entry, tuple) and len(entry) == 2:
                    raw_bytes = entry[1]
                    break
            if not raw_bytes:
                continue

            parsed = BytesParser(policy=email_policy).parsebytes(raw_bytes)
            text_body, html_body, has_html = extract_body(parsed)
            subject = decode_mime(parsed.get("Subject")) or "Sans sujet"
            from_ = decode_mime(parsed.get("From")) or "Inconnu"
            date_value = decode_mime(parsed.get("Date")) or now_iso()
            message_id = f"{account.id}:{uid}"
            message = Message(
                id=message_id,
                accountId=account.id,
                accountLabel=account.label,
                uid=uid,
                from_=from_,
                subject=subject,
                date=date_value,
                snippet=snippet_for(text_body or html_body),
                bodyText=text_body,
                bodyHtml=html_body,
                read=False,
                hasHtml=has_html,
                sortKey=uid,
            )
            messages.append(message)
            highest_uid = max(highest_uid, uid)

        return highest_uid, messages
    finally:
        try:
            client.logout()
        except Exception:
            pass


def update_message_read(message_id: str, read: bool) -> None:
    for message in STATE.messages:
        if message.id == message_id:
            message.read = read
            return


def collect_accounts_view() -> list[dict[str, Any]]:
    unread_by_account = {account.id: 0 for account in STATE.accounts}
    for message in STATE.messages:
        if not message.read:
            unread_by_account[message.accountId] = unread_by_account.get(message.accountId, 0) + 1

    accounts_view = []
    for account in STATE.accounts:
        record = asdict(account)
        record["unreadCount"] = unread_by_account.get(account.id, 0)
        accounts_view.append(record)
    return accounts_view


def find_account(account_id: str) -> Optional[Account]:
    return next((account for account in STATE.accounts if account.id == account_id), None)


def is_autostart_enabled() -> bool:
    if os.name != "nt":
        return False
    try:
        result = subprocess.run(
            ["reg", "query", REGISTRY_KEY, "/v", REGISTRY_VALUE],
            capture_output=True,
            text=True,
            check=False,
        )
        return result.returncode == 0
    except Exception:
        return False


def ensure_default_settings() -> None:
    if os.name == "nt" and STATE.settings.launcherPath:
        STATE.settings.autostartEnabled = is_autostart_enabled()


def set_autostart(enabled: bool, launcher_path: str) -> None:
    if os.name != "nt":
        raise RuntimeError("Le demarrage automatique est supporte uniquement sur Windows")

    if enabled:
        command = [
            "reg",
            "add",
            REGISTRY_KEY,
            "/v",
            REGISTRY_VALUE,
            "/t",
            "REG_SZ",
            "/d",
            launcher_path,
            "/f",
        ]
    else:
        command = ["reg", "delete", REGISTRY_KEY, "/v", REGISTRY_VALUE, "/f"]

    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "Commande registre echouee")

    STATE.settings.autostartEnabled = enabled
    if launcher_path:
        STATE.settings.launcherPath = launcher_path
    STATE.save()


def poll_account(account: Account) -> None:
    if not account.password:
        return

    try:
        highest_uid, new_messages = fetch_new_messages(account)
        if new_messages:
            known_ids = {message.id for message in STATE.messages}
            for message in new_messages:
                if message.id not in known_ids:
                    STATE.messages.append(message)
                    STATE.add_event(
                        "new_message",
                        f"Nouveau mail sur {account.label}",
                        f"{message.from_} - {message.subject}",
                        account.id,
                        message.id,
                    )
        account.last_uid = max(account.last_uid, highest_uid)
        account.unreadCount = sum(1 for message in STATE.messages if message.accountId == account.id and not message.read)
        account.lastSyncAt = now_iso()
        account.lastError = ""
    except Exception as error:
        account.lastError = str(error)
    finally:
        STATE.save()


def parse_iso(value: str) -> Optional[float]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value).timestamp()
    except Exception:
        return None


def polling_loop() -> None:
    while True:
        with POLL_LOCK:
            with STATE.lock:
                current_time = time.time()
                for account in STATE.accounts:
                    last_sync = parse_iso(account.lastSyncAt)
                    interval = max(15, int(account.pollInterval or 60))
                    if last_sync is None or current_time - last_sync >= interval:
                        poll_account(account)
        time.sleep(1)


class MailRequestHandler(BaseHTTPRequestHandler):
    server_version = "EminiumMail/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        return

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        route = parsed.path

        if route == "/api/health":
            self.send_json({"ok": True})
            return

        if route == "/api/bootstrap":
            with STATE.lock:
                self.send_json(
                    {
                        "ok": True,
                        "settings": asdict(STATE.settings),
                        "accounts": collect_accounts_view(),
                        "messages": [self.serialise_message(message) for message in STATE.messages],
                        "events": STATE.events,
                    }
                )
            return

        if route == "/api/events":
            after = int(parse_qs(parsed.query).get("after", [0])[0] or 0)
            with STATE.lock:
                events = [event for event in STATE.events if event.get("id", 0) > after]
            self.send_json({"ok": True, "events": events})
            return

        if route.startswith("/api/messages/"):
            message_id = route.split("/api/messages/", 1)[1]
            if message_id.endswith("/read"):
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            with STATE.lock:
                message = next((item for item in STATE.messages if item.id == message_id), None)
            if not message:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            self.send_json({"ok": True, "message": self.serialise_message(message)})
            return

        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        route = parsed.path
        body = self.read_json_body()

        if route == "/api/accounts":
            account = self.save_account(body)
            self.send_json({"ok": True, "account": asdict(account)})
            return

        if route == "/api/test-account":
            try:
                temp_account = Account(
                    id="test",
                    label="Test",
                    host=str(body.get("host", "")),
                    port=int(body.get("port", 993)),
                    encryption=str(body.get("encryption", "ssl")),
                    username=str(body.get("username", "")),
                    password=str(body.get("password", "")),
                    folder=str(body.get("folder", "INBOX")),
                )
                client = connect_account(temp_account)
                client.logout()
                self.send_json({"ok": True, "message": "Connexion etablie"})
            except Exception as error:
                self.send_json({"ok": False, "message": str(error)}, status=HTTPStatus.BAD_REQUEST)
            return

        if route.endswith("/sync") and route.startswith("/api/accounts/"):
            account_id = route.split("/api/accounts/", 1)[1].split("/sync", 1)[0]
            account = find_account(account_id)
            if not account:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            poll_account(account)
            self.send_json({"ok": True})
            return

        if route.endswith("/read") and route.startswith("/api/messages/"):
            message_id = route.split("/api/messages/", 1)[1].split("/read", 1)[0]
            read_state = bool(body.get("read", True))
            with STATE.lock:
                update_message_read(message_id, read_state)
                STATE.save()
            self.send_json({"ok": True})
            return

        if route == "/api/startup":
            enabled = bool(body.get("enabled", False))
            launcher_path = str(body.get("launcherPath", "")).strip()
            try:
                set_autostart(enabled, launcher_path)
                self.send_json({"ok": True, "enabled": enabled})
            except Exception as error:
                self.send_json({"ok": False, "message": str(error)}, status=HTTPStatus.BAD_REQUEST)
            return

        self.send_error(HTTPStatus.NOT_FOUND)

    def do_DELETE(self) -> None:
        route = urlparse(self.path).path
        if route.startswith("/api/accounts/"):
            account_id = route.split("/api/accounts/", 1)[1]
            with STATE.lock:
                STATE.accounts = [account for account in STATE.accounts if account.id != account_id]
                STATE.messages = [message for message in STATE.messages if message.accountId != account_id]
                STATE.save()
            self.send_json({"ok": True})
            return

        self.send_error(HTTPStatus.NOT_FOUND)

    def save_account(self, body: dict[str, Any]) -> Account:
        with STATE.lock:
            account_id = str(body.get("id") or f"acc-{slugify(str(body.get('label', 'account')))}-{int(datetime.now().timestamp())}")
            existing = find_account(account_id)
            password = str(body.get("password", ""))
            if existing and not password:
                password = existing.password

            account = Account(
                id=account_id,
                label=str(body.get("label", "Compte")),
                host=str(body.get("host", "")),
                port=int(body.get("port", 993)),
                encryption=str(body.get("encryption", "ssl")),
                username=str(body.get("username", "")),
                password=password,
                folder=str(body.get("folder", "INBOX")) or "INBOX",
                pollInterval=max(15, int(body.get("pollInterval", 60))),
                last_uid=existing.last_uid if existing else 0,
                unreadCount=existing.unreadCount if existing else 0,
                lastSyncAt=existing.lastSyncAt if existing else "",
                lastError=existing.lastError if existing else "",
            )

            STATE.accounts = [item for item in STATE.accounts if item.id != account.id] + [account]
            STATE.save()
            return account

    def serialise_message(self, message: Message) -> dict[str, Any]:
        payload = asdict(message)
        payload["from"] = payload.pop("from_")
        return payload

    def read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def send_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(encoded)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=6117, type=int)
    args = parser.parse_args()

    ensure_default_settings()

    thread = threading.Thread(target=polling_loop, daemon=True)
    thread.start()

    server = ThreadingHTTPServer((args.host, args.port), MailRequestHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
