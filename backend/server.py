#!/usr/bin/env python3
"""BrewClub HTTP server and SQLite-backed API."""

from __future__ import annotations

import csv
import hashlib
import hmac
import io
import json
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, time as datetime_time, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import qrcode
from qrcode.constants import ERROR_CORRECT_M


ROOT_DIR = Path(__file__).resolve().parent.parent
PUBLIC_STATIC_FILES = frozenset(
    {
        "akun.html",
        "admin.html",
        "admin.js",
        "app.js",
        "customer-api.js",
        "index.html",
        "login.html",
        "mont-logo.svg",
        "pengguna.html",
        "privacy.html",
        "reset-password.html",
        "script.js",
        "style.css",
    }
)
DATABASE_PATH = Path(
    os.environ.get("BREWCLUB_DATABASE", Path.home() / ".brewclub" / "customers.sqlite3")
).resolve()
MAX_REQUEST_SIZE = 16_384
SESSION_COOKIES = {"admin": "brewclub_admin", "customer": "brewclub_customer"}
SESSION_DURATION_SECONDS = 8 * 60 * 60
RESET_TOKEN_DURATION_MS = 60 * 60 * 1000
PASSWORD_MIN_LENGTH = 12
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PHONE_PATTERN = re.compile(r"^\+?[\d\s()-]{8,30}$")
PRIVACY_POLICY_VERSION = "2026-11-01"
RATE_LIMITS: dict[str, tuple[int, int]] = {
    "admin-login": (5, 5 * 60 * 1000),
    "customer-register": (10, 60 * 60 * 1000),
    "customer-login": (10, 15 * 60 * 1000),
    "customer-reset": (5, 60 * 60 * 1000),
    "customer-reset-confirm": (10, 15 * 60 * 1000),
}
_rate_attempts: dict[str, tuple[int, int]] = {}
_rate_lock = threading.Lock()

INITIAL_PROMOS = (
    ("diskon", "DISKON 20%", "Diskon 20% Semua Pastry", "Berlaku untuk croissant, danish, cinnamon roll, dan pastry lainnya.", "", ""),
    ("diskon", "DISKON 15%", "Diskon 15% Signature Latte", "Nikmati potongan harga untuk minuman latte andalan kami.", "", ""),
    ("diskon", "BUY 1 GET 1", "Diskon 50% Kopi Kedua", "Khusus pemesanan di hari Jumat. Berlaku untuk semua varian kopi.", "", ""),
    ("bundling", "HEMAT 30%", "Paket Ngopi Pagi", "1 Americano dingin/panas + 1 Butter Croissant.", "Rp 50.000", "Rp 35.000"),
    ("bundling", "HEMAT 40%", "Paket Berdua", "2 Signature Latte + 2 Potong Cake pilihan.", "Rp 140.000", "Rp 99.000"),
    ("bundling", "HEMAT 25%", "Paket WFH", "1 Kopi Susu + 1 Snack Box + 1 Air Mineral.", "Rp 65.000", "Rp 45.000"),
)


def now_ms() -> int:
    return int(time.time() * 1000)


def generate_member_qr(member_id: str) -> bytes:
    code = qrcode.QRCode(
        version=None,
        error_correction=ERROR_CORRECT_M,
        box_size=8,
        border=4,
    )
    code.add_data(member_id)
    code.make(fit=True)
    image = code.make_image(fill_color="#29491f", back_color="white")
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def open_database(database_path: Path | str = DATABASE_PATH) -> sqlite3.Connection:
    path = Path(database_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    database = sqlite3.connect(path, timeout=10)
    database.row_factory = sqlite3.Row
    database.execute("PRAGMA busy_timeout = 10000")
    return database


def initialize_database(database_path: Path | str = DATABASE_PATH) -> None:
    database = open_database(database_path)
    try:
        database.executescript(
            """
            CREATE TABLE IF NOT EXISTS customers (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              member_id TEXT NOT NULL UNIQUE,
              name TEXT NOT NULL,
              email TEXT NOT NULL COLLATE NOCASE UNIQUE,
              phone TEXT NOT NULL,
              joined INTEGER NOT NULL,
              password_hash TEXT,
              consent_at INTEGER,
              privacy_policy_version TEXT,
              qr_code BLOB
            );
            CREATE TABLE IF NOT EXISTS promos (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              category TEXT NOT NULL CHECK (category IN ('diskon', 'bundling')),
              label TEXT NOT NULL,
              title TEXT NOT NULL,
              description TEXT NOT NULL,
              price_old TEXT NOT NULL DEFAULT '',
              price_new TEXT NOT NULL DEFAULT '',
              active INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS app_settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS promo_claims (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              promo_id INTEGER,
              promo_title TEXT NOT NULL,
              member_id TEXT NOT NULL,
              customer_name TEXT NOT NULL,
              claimed_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS auth_sessions (
              token_hash TEXT PRIMARY KEY,
              role TEXT NOT NULL CHECK (role IN ('admin', 'customer')),
              username TEXT,
              member_id TEXT,
              created_at INTEGER NOT NULL,
              expires_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions (expires_at);
            CREATE TABLE IF NOT EXISTS password_reset_tokens (
              token_hash TEXT PRIMARY KEY,
              customer_id INTEGER NOT NULL,
              created_at INTEGER NOT NULL,
              expires_at INTEGER NOT NULL,
              used_at INTEGER
            );
            """
        )

        customer_columns = {
            column["name"] for column in database.execute("PRAGMA table_info(customers)")
        }
        for column, definition in (
            ("password_hash", "TEXT"),
            ("consent_at", "INTEGER"),
            ("privacy_policy_version", "TEXT"),
            ("qr_code", "BLOB"),
        ):
            if column not in customer_columns:
                database.execute(f"ALTER TABLE customers ADD COLUMN {column} {definition}")

        customers_without_qr = database.execute(
            "SELECT id, member_id FROM customers WHERE qr_code IS NULL"
        ).fetchall()
        for customer in customers_without_qr:
            database.execute(
                "UPDATE customers SET qr_code = ? WHERE id = ?",
                (generate_member_qr(customer["member_id"]), customer["id"]),
            )

        promo_columns = {
            column["name"] for column in database.execute("PRAGMA table_info(promos)")
        }
        for column in ("starts_on", "ends_on"):
            if column not in promo_columns:
                database.execute(f"ALTER TABLE promos ADD COLUMN {column} TEXT")

        seeded = database.execute(
            "SELECT 1 FROM app_settings WHERE key = 'initial_promos_seeded'"
        ).fetchone()
        promo_count = database.execute("SELECT COUNT(*) AS count FROM promos").fetchone()["count"]
        if not seeded and promo_count == 0:
            database.executemany(
                """
                INSERT INTO promos (category, label, title, description, price_old, price_new)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                INITIAL_PROMOS,
            )
        database.execute(
            "INSERT OR IGNORE INTO app_settings (key, value) VALUES ('initial_promos_seeded', '1')"
        )
        database.execute("DELETE FROM auth_sessions WHERE expires_at <= ?", (now_ms(),))
        database.execute(
            "DELETE FROM password_reset_tokens WHERE expires_at <= ? OR used_at IS NOT NULL",
            (now_ms(),),
        )
        database.commit()
    finally:
        database.close()


def session_token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=32768, r=8, p=1, dklen=64,
        maxmem=128 * 1024 * 1024,
    )
    return f"scrypt$32768${salt.hex()}${derived.hex()}"


def verify_password(password: str, encoded_hash: str) -> bool:
    try:
        algorithm, cost, salt_hex, hash_hex = encoded_hash.split("$")
        if algorithm != "scrypt":
            return False
        expected = bytes.fromhex(hash_hex)
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=bytes.fromhex(salt_hex),
            n=int(cost),
            r=8,
            p=1,
            dklen=len(expected),
            maxmem=128 * 1024 * 1024,
        )
        return bool(expected) and hmac.compare_digest(actual, expected)
    except (ValueError, TypeError, OverflowError):
        return False


def validate_password(password: object) -> bool:
    return (
        isinstance(password, str)
        and PASSWORD_MIN_LENGTH <= len(password) <= 128
        and not re.search(r"[\x00-\x1f\x7f]", password)
    )


def parse_cookies(header: str) -> dict[str, str]:
    cookies = {}
    for part in header.split(";"):
        name, separator, value = part.partition("=")
        if not separator:
            continue
        try:
            cookies[name.strip()] = urllib.parse.unquote(value.strip(), errors="strict")
        except (UnicodeDecodeError, ValueError):
            continue
    return cookies


def get_client_address(handler: BaseHTTPRequestHandler) -> str:
    if os.environ.get("TRUST_PROXY") == "1":
        forwarded = handler.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",", 1)[0].strip()
    return handler.client_address[0] if handler.client_address else "unknown"


def rate_limit_key(handler: BaseHTTPRequestHandler, name: str) -> str:
    return f"{name}:{get_client_address(handler)}"


def rate_limited(handler: BaseHTTPRequestHandler, name: str) -> bool:
    limit, window_ms = RATE_LIMITS[name]
    key = rate_limit_key(handler, name)
    now = now_ms()
    with _rate_lock:
        started, count = _rate_attempts.get(key, (0, 0))
        if now - started >= window_ms:
            _rate_attempts[key] = (now, 0)
            return False
        return count >= limit


def record_rate_attempt(handler: BaseHTTPRequestHandler, name: str) -> None:
    _, window_ms = RATE_LIMITS[name]
    key = rate_limit_key(handler, name)
    now = now_ms()
    with _rate_lock:
        started, count = _rate_attempts.get(key, (0, 0))
        if now - started >= window_ms:
            _rate_attempts[key] = (now, 1)
        else:
            _rate_attempts[key] = (started, count + 1)
        if len(_rate_attempts) > 10_000:
            for attempt_key, (attempt_started, _) in list(_rate_attempts.items()):
                if now - attempt_started >= 60 * 60 * 1000:
                    _rate_attempts.pop(attempt_key, None)


def clear_rate_limit(handler: BaseHTTPRequestHandler, name: str) -> None:
    with _rate_lock:
        _rate_attempts.pop(rate_limit_key(handler, name), None)


def validate_promo_date(value: object) -> str | None | bool:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return False
    if parsed.isoformat() != value:
        return False
    return value


def safe_csv_value(value: object) -> str:
    text = "" if value is None else str(value)
    return "'" + text if re.match(r"^[\s]*[=+\-@\t\r]", text) else text


def send_password_reset_email(email: str, token: str) -> None:
    base_url = os.environ.get("BASE_URL", "")
    reset_url = urllib.parse.urljoin(base_url.rstrip("/") + "/", "reset-password.html")
    reset_url += "?" + urllib.parse.urlencode({"token": token})
    payload = json.dumps(
        {
            "from": os.environ["EMAIL_FROM"],
            "to": [email],
            "subject": "Atur ulang kata sandi BrewClub",
            "text": (
                "Gunakan tautan berikut untuk mengatur ulang kata sandi BrewClub. "
                "Tautan berlaku 1 jam dan hanya dapat digunakan sekali:\n\n"
                f"{reset_url}\n\nJika Anda tidak meminta pengaturan ulang, abaikan email ini."
            ),
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        "https://api.resend.com/emails",
        data=payload,
        headers={
            "Authorization": f"Bearer {os.environ['RESEND_API_KEY']}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            if not 200 <= response.status < 300:
                raise RuntimeError(f"Layanan email menolak reset kata sandi ({response.status})")
    except urllib.error.HTTPError as error:
        detail = error.read(2048).decode("utf-8", errors="replace")
        raise RuntimeError(
            f"Layanan email menolak reset kata sandi ({error.code}): {detail}"
        ) from error


def create_server(
    host: str | None = None,
    port: int | None = None,
    database_path: Path | str | None = None,
) -> ThreadingHTTPServer:
    selected_database = Path(database_path or DATABASE_PATH).resolve()
    initialize_database(selected_database)

    class BrewClubHandler(BaseHTTPRequestHandler):
        server_version = "BrewClub"

        def log_message(self, format_string: str, *args: object) -> None:
            message = format_string % args
            message = re.sub(
                r'(?<=\s)(/[^\s?"]*)\?[^\s"]*',
                r"\1?[REDACTED]",
                message,
            )
            logging.info("%s - %s", self.address_string(), message)

        def do_GET(self) -> None:
            self.dispatch()

        def do_HEAD(self) -> None:
            self.dispatch()

        def do_POST(self) -> None:
            self.dispatch()

        def do_PUT(self) -> None:
            self.dispatch()

        def do_PATCH(self) -> None:
            self.dispatch()

        def do_DELETE(self) -> None:
            self.dispatch()

        def send_json(
            self, status: int, payload: object, headers: dict[str, str] | None = None
        ) -> None:
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            response_headers = {
                "Content-Type": "application/json; charset=utf-8",
                "Content-Length": str(len(body)),
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "X-Frame-Options": "DENY",
                "Referrer-Policy": "strict-origin-when-cross-origin",
            }
            response_headers.update(headers or {})
            self.send_response(status)
            for name, value in response_headers.items():
                self.send_header(name, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def send_error_json(self, status: int, message: str) -> None:
            self.send_json(status, {"error": message})

        def send_csv(self, customers: list[sqlite3.Row]) -> None:
            output = io.StringIO(newline="")
            writer = csv.writer(output, lineterminator="\r\n", quoting=csv.QUOTE_ALL)
            writer.writerow(("ID Member", "Nama", "Email", "WhatsApp", "Bergabung"))
            for customer in customers:
                joined = datetime.fromtimestamp(customer["joined"] / 1000).date().isoformat()
                writer.writerow(
                    [safe_csv_value(customer[field]) for field in ("member_id", "name", "email", "phone")]
                    + [joined]
                )
            body = ("\ufeff" + output.getvalue()).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", 'attachment; filename="pelanggan-brewclub.csv"')
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def send_static(self, parsed_path: str) -> None:
            try:
                decoded_path = urllib.parse.unquote(parsed_path, errors="strict")
            except (UnicodeDecodeError, ValueError):
                self.send_error_json(400, "Alamat file tidak valid.")
                return
            if decoded_path.endswith("/"):
                decoded_path += "index.html"
            relative_path = decoded_path.lstrip("/")
            if relative_path not in PUBLIC_STATIC_FILES:
                self.send_error_json(404, "File tidak ditemukan.")
                return
            resolved_path = ROOT_DIR / relative_path
            if not resolved_path.is_file():
                self.send_error_json(404, "File tidak ditemukan.")
                return

            content_types = {
                ".css": "text/css; charset=utf-8",
                ".html": "text/html; charset=utf-8",
                ".ico": "image/x-icon",
                ".jpeg": "image/jpeg",
                ".jpg": "image/jpeg",
                ".js": "text/javascript; charset=utf-8",
                ".json": "application/json; charset=utf-8",
                ".png": "image/png",
                ".svg": "image/svg+xml",
                ".txt": "text/plain; charset=utf-8",
                ".webp": "image/webp",
            }
            body = resolved_path.read_bytes()
            headers = {
                "Content-Type": content_types.get(
                    resolved_path.suffix.lower(), "application/octet-stream"
                ),
                "Content-Length": str(len(body)),
                "Cache-Control": "no-cache",
                "X-Content-Type-Options": "nosniff",
                "X-Frame-Options": "DENY",
                "Referrer-Policy": "strict-origin-when-cross-origin",
            }
            if os.environ.get("NODE_ENV") == "production":
                headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
            self.send_response(200)
            for name, value in headers.items():
                self.send_header(name, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def has_valid_origin(self) -> bool:
            origin = self.headers.get("Origin")
            if not origin:
                return False
            try:
                return urllib.parse.urlsplit(origin).netloc == self.headers.get("Host")
            except ValueError:
                return False

        def session_cookie(
            self, token: str, role: str, max_age: int = SESSION_DURATION_SECONDS
        ) -> str:
            secure = os.environ.get("NODE_ENV") == "production" or (
                os.environ.get("TRUST_PROXY") == "1"
                and self.headers.get("X-Forwarded-Proto") == "https"
            )
            parts = [
                f"{SESSION_COOKIES[role]}={urllib.parse.quote(token, safe='')}",
                "Path=/",
                "HttpOnly",
                "SameSite=Strict",
                f"Max-Age={max_age}",
            ]
            if secure:
                parts.append("Secure")
            return "; ".join(parts)

        def get_session(
            self, database: sqlite3.Connection, role: str
        ) -> sqlite3.Row | None:
            token = parse_cookies(self.headers.get("Cookie", "")).get(SESSION_COOKIES[role])
            if not token:
                return None
            return database.execute(
                """
                SELECT role, username, member_id, expires_at
                FROM auth_sessions WHERE token_hash = ? AND role = ? AND expires_at > ?
                """,
                (session_token_hash(token), role, now_ms()),
            ).fetchone()

        def require_session(
            self,
            database: sqlite3.Connection,
            role: str,
            mutation: bool = False,
        ) -> sqlite3.Row | None:
            if mutation and not self.has_valid_origin():
                self.send_error_json(403, "Asal request tidak diizinkan.")
                return None
            session = self.get_session(database, role)
            if not session:
                label = "admin" if role == "admin" else "pelanggan"
                self.send_error_json(401, f"Sesi {label} berakhir. Silakan masuk kembali.")
            return session

        def create_session(
            self,
            database: sqlite3.Connection,
            role: str,
            username: str | None = None,
            member_id: str | None = None,
        ) -> str:
            now = now_ms()
            database.execute("DELETE FROM auth_sessions WHERE expires_at <= ?", (now,))
            token = secrets.token_urlsafe(32)
            database.execute(
                """
                INSERT INTO auth_sessions
                  (token_hash, role, username, member_id, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    session_token_hash(token),
                    role,
                    username,
                    member_id,
                    now,
                    now + SESSION_DURATION_SECONDS * 1000,
                ),
            )
            database.commit()
            return token

        def read_json(self) -> dict[str, object] | None:
            if self.headers.get_content_type().lower() != "application/json":
                self.send_error_json(415, "Content-Type harus application/json.")
                return None
            try:
                content_length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                content_length = 0
            if content_length <= 0 or content_length > MAX_REQUEST_SIZE:
                self.send_error_json(413, "Ukuran data tidak valid atau terlalu besar.")
                return None
            body = self.rfile.read(content_length)
            if len(body) != content_length:
                self.send_error_json(400, "Format JSON tidak valid.")
                return None
            try:
                payload = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self.send_error_json(400, "Format JSON tidak valid.")
                return None
            if not isinstance(payload, dict):
                self.send_error_json(400, "Data harus berupa objek.")
                return None
            return payload

        def create_customer_session_payload(
            self, database: sqlite3.Connection, session: sqlite3.Row
        ) -> dict[str, object] | None:
            customer = database.execute(
                """
                SELECT member_id AS id, name, email, phone, joined
                FROM customers WHERE member_id = ?
                """,
                (session["member_id"],),
            ).fetchone()
            return dict(customer) if customer else None

        def customer_search(
            self, database: sqlite3.Connection, search: str
        ) -> list[sqlite3.Row]:
            sql = "SELECT member_id, name, email, phone, joined FROM customers"
            parameters: tuple[object, ...] = ()
            if search:
                escaped = search.replace("!", "!!").replace("%", "!%").replace("_", "!_")
                pattern = f"%{escaped}%"
                sql += """
                  WHERE member_id LIKE ? ESCAPE '!'
                     OR name LIKE ? ESCAPE '!'
                     OR email LIKE ? ESCAPE '!'
                     OR phone LIKE ? ESCAPE '!'
                """
                parameters = (pattern, pattern, pattern, pattern)
            sql += " ORDER BY joined DESC"
            return database.execute(sql, parameters).fetchall()

        def list_promos(
            self, database: sqlite3.Connection, active_only: bool
        ) -> list[sqlite3.Row]:
            if not active_only:
                return database.execute("SELECT * FROM promos ORDER BY category, id").fetchall()
            today = date.today().isoformat()
            return database.execute(
                """
                SELECT * FROM promos
                WHERE active = 1
                  AND (starts_on IS NULL OR starts_on = '' OR starts_on <= ?)
                  AND (ends_on IS NULL OR ends_on = '' OR ends_on >= ?)
                ORDER BY category, id
                """,
                (today, today),
            ).fetchall()

        def save_promo(
            self,
            database: sqlite3.Connection,
            payload: dict[str, object],
            promo_id: int | None = None,
        ) -> tuple[int, dict[str, object] | str]:
            category = payload.get("category")
            label = payload.get("label")
            title = payload.get("title")
            description = payload.get("description")
            price_old = payload.get("price_old", "")
            price_new = payload.get("price_new", "")
            raw_starts = payload.get("starts_on", "")
            raw_ends = payload.get("ends_on", "")
            if category not in ("diskon", "bundling"):
                return 400, "Kategori promo tidak valid."
            raw_values = (label, title, description, price_old, price_new, raw_starts, raw_ends)
            if not all(isinstance(value, str) for value in raw_values):
                return 400, "Data promo tidak valid."
            values = (
                label.strip(),
                title.strip(),
                description.strip(),
                price_old.strip(),
                price_new.strip(),
            )
            if (
                not values[0]
                or len(values[0]) > 40
                or not values[1]
                or len(values[1]) > 120
                or not values[2]
                or len(values[2]) > 500
            ):
                return 400, "Label, judul, atau deskripsi promo tidak valid."
            if len(values[3]) > 40 or len(values[4]) > 40:
                return 400, "Harga maksimal 40 karakter."
            starts_on = raw_starts.strip()
            ends_on = raw_ends.strip()
            start = validate_promo_date(starts_on) if starts_on else None
            end = validate_promo_date(ends_on) if ends_on else None
            if start is False or end is False:
                return 400, "Tanggal promo harus valid."
            if start and end and start > end:
                return 400, "Tanggal berakhir tidak boleh sebelum tanggal mulai."
            if promo_id is None:
                cursor = database.execute(
                    """
                    INSERT INTO promos
                      (category, label, title, description, price_old, price_new, active, starts_on, ends_on)
                    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
                    """,
                    (category, *values, start, end),
                )
                promo_id = int(cursor.lastrowid)
                status = 201
            else:
                cursor = database.execute(
                    """
                    UPDATE promos SET category = ?, label = ?, title = ?, description = ?,
                      price_old = ?, price_new = ?, starts_on = ?, ends_on = ? WHERE id = ?
                    """,
                    (category, *values, start, end, promo_id),
                )
                if cursor.rowcount == 0:
                    return 404, "Promo tidak ditemukan."
                status = 200
            database.commit()
            promo = database.execute("SELECT * FROM promos WHERE id = ?", (promo_id,)).fetchone()
            return status, dict(promo)

        def get_analytics(self, database: sqlite3.Connection) -> dict[str, object]:
            today = date.today()
            start_date = today - timedelta(days=6)
            start_timestamp = int(
                datetime.combine(start_date, datetime_time.min).timestamp() * 1000
            )
            total = database.execute("SELECT COUNT(*) AS count FROM promo_claims").fetchone()[
                "count"
            ]
            last_week = database.execute(
                "SELECT COUNT(*) AS count FROM promo_claims WHERE claimed_at >= ?",
                (start_timestamp,),
            ).fetchone()["count"]
            rows = database.execute(
                """
                SELECT date(claimed_at / 1000, 'unixepoch', 'localtime') AS day,
                       COUNT(*) AS count
                FROM promo_claims WHERE claimed_at >= ? GROUP BY day
                """,
                (start_timestamp,),
            ).fetchall()
            by_day = {row["day"]: row["count"] for row in rows}
            daily = [
                {
                    "date": (start_date + timedelta(days=offset)).isoformat(),
                    "count": by_day.get((start_date + timedelta(days=offset)).isoformat(), 0),
                }
                for offset in range(7)
            ]
            top_promos = database.execute(
                """
                SELECT promo_title AS title, COUNT(*) AS count
                FROM promo_claims GROUP BY promo_title
                ORDER BY count DESC, title LIMIT 5
                """
            ).fetchall()
            return {
                "total_claims": total,
                "last_7_days": last_week,
                "daily": daily,
                "top_promos": [dict(row) for row in top_promos],
            }

        def dispatch(self) -> None:
            try:
                self._dispatch()
            except (BrokenPipeError, ConnectionResetError):
                return
            except Exception:
                logging.exception("Kesalahan backend")
                if not self.wfile.closed:
                    try:
                        self.send_error_json(500, "Permintaan gagal diproses.")
                    except (BrokenPipeError, ConnectionResetError):
                        pass

        def _dispatch(self) -> None:
            try:
                parsed = urllib.parse.urlsplit(self.path)
            except ValueError:
                self.send_error_json(400, "Alamat request tidak valid.")
                return
            pathname = parsed.path
            method = self.command
            if method == "GET" and pathname == "/api/health":
                self.send_json(200, {"status": "ok"})
                return
            if not pathname.startswith("/api/"):
                if method in ("GET", "HEAD"):
                    self.send_static(pathname)
                else:
                    self.send_error_json(405, "Metode request tidak diizinkan.")
                return

            database = open_database(selected_database)
            try:
                self.api_request(database, method, pathname, parsed.query)
            finally:
                database.close()

        def api_request(
            self,
            database: sqlite3.Connection,
            method: str,
            pathname: str,
            query_string: str,
        ) -> None:
            query = urllib.parse.parse_qs(query_string, keep_blank_values=True)
            if method == "GET" and pathname == "/api/promos":
                self.send_json(200, [dict(promo) for promo in self.list_promos(database, True)])
                return
            if method == "GET" and pathname == "/api/admin/session":
                session = self.get_session(database, "admin")
                self.send_json(
                    200,
                    {
                        "authenticated": bool(session),
                        "username": session["username"] if session else None,
                    },
                )
                return
            if method == "GET" and pathname == "/api/customer/session":
                session = self.get_session(database, "customer")
                self.send_json(
                    200,
                    {
                        "authenticated": bool(session),
                        "customer": (
                            self.create_customer_session_payload(database, session)
                            if session
                            else None
                        ),
                    },
                )
                return
            if method == "GET" and pathname == "/api/customer/qr":
                session = self.require_session(database, "customer")
                if not session:
                    return
                customer = database.execute(
                    "SELECT qr_code FROM customers WHERE member_id = ?",
                    (session["member_id"],),
                ).fetchone()
                if not customer or not customer["qr_code"]:
                    self.send_error_json(404, "QR Code member tidak ditemukan.")
                    return
                image = customer["qr_code"]
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(image)))
                self.send_header("Cache-Control", "private, no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(image)
                return
            if method == "POST" and pathname == "/api/admin/login":
                self.login_admin(database)
                return
            if method == "POST" and pathname in (
                "/api/admin/logout",
                "/api/customer/logout",
            ):
                self.logout(database, "admin" if "/admin/" in pathname else "customer")
                return
            if method == "POST" and pathname == "/api/customers":
                self.register_customer(database)
                return
            if method == "POST" and pathname == "/api/customer/login":
                self.login_customer(database)
                return
            if method == "POST" and pathname == "/api/customer/forgot-password":
                self.forgot_password(database)
                return
            if method == "POST" and pathname == "/api/customer/reset-password":
                self.reset_password(database)
                return
            if method == "GET" and pathname.startswith("/api/admin/"):
                if not self.require_session(database, "admin"):
                    return
                self.admin_get(database, pathname, query)
                return
            if method == "POST" and pathname.startswith("/api/admin/"):
                if not self.require_session(database, "admin", mutation=True):
                    return
                self.admin_post(database, pathname)
                return
            promo_match = re.fullmatch(r"/api/admin/promos/(\d+)", pathname)
            if method == "PUT" and promo_match:
                if not self.require_session(database, "admin", mutation=True):
                    return
                payload = self.read_json()
                if payload is None:
                    return
                status, result = self.save_promo(database, payload, int(promo_match.group(1)))
                if isinstance(result, str):
                    self.send_error_json(status, result)
                else:
                    self.send_json(status, result)
                return
            active_match = re.fullmatch(r"/api/admin/promos/(\d+)/active", pathname)
            if method == "PATCH" and active_match:
                if not self.require_session(database, "admin", mutation=True):
                    return
                payload = self.read_json()
                if payload is None:
                    return
                if not isinstance(payload.get("active"), bool):
                    self.send_error_json(400, "Status promo tidak valid.")
                    return
                result = database.execute(
                    "UPDATE promos SET active = ? WHERE id = ?",
                    (int(payload["active"]), int(active_match.group(1))),
                )
                database.commit()
                if result.rowcount == 0:
                    self.send_error_json(404, "Promo tidak ditemukan.")
                else:
                    self.send_json(200, {"ok": True})
                return
            if method == "DELETE" and promo_match:
                if not self.require_session(database, "admin", mutation=True):
                    return
                result = database.execute(
                    "DELETE FROM promos WHERE id = ?", (int(promo_match.group(1)),)
                )
                database.commit()
                if result.rowcount == 0:
                    self.send_error_json(404, "Promo tidak ditemukan.")
                else:
                    self.send_json(200, {"ok": True})
                return
            self.send_error_json(404, "Endpoint tidak ditemukan.")

        def login_admin(self, database: sqlite3.Connection) -> None:
            if not self.has_valid_origin():
                self.send_error_json(403, "Asal request tidak diizinkan.")
                return
            payload = self.read_json()
            if payload is None:
                return
            username = os.environ.get("ADMIN_USERNAME", "admin")
            password = os.environ.get("ADMIN_PASSWORD", "")
            if len(password) < PASSWORD_MIN_LENGTH:
                self.send_error_json(
                    503, "Atur ADMIN_PASSWORD minimal 12 karakter sebelum login admin."
                )
                return
            if rate_limited(self, "admin-login"):
                self.send_error_json(429, "Terlalu banyak percobaan. Coba lagi dalam 5 menit.")
                return
            supplied_username = payload.get("username")
            supplied_password = payload.get("password")
            if not isinstance(supplied_username, str) or not isinstance(
                supplied_password, str
            ):
                self.send_error_json(400, "Username dan kata sandi wajib diisi.")
                return
            valid = hmac.compare_digest(supplied_username, username) and hmac.compare_digest(
                supplied_password, password
            )
            if not valid:
                record_rate_attempt(self, "admin-login")
                self.send_error_json(401, "Username atau kata sandi salah.")
                return
            clear_rate_limit(self, "admin-login")
            token = self.create_session(database, "admin", username=username)
            self.send_json(
                200,
                {"authenticated": True, "username": username},
                {"Set-Cookie": self.session_cookie(token, "admin")},
            )

        def logout(self, database: sqlite3.Connection, role: str) -> None:
            if not self.has_valid_origin():
                self.send_error_json(403, "Asal request tidak diizinkan.")
                return
            token = parse_cookies(self.headers.get("Cookie", "")).get(
                SESSION_COOKIES[role]
            )
            if token:
                database.execute(
                    "DELETE FROM auth_sessions WHERE token_hash = ? AND role = ?",
                    (session_token_hash(token), role),
                )
                database.commit()
            self.send_json(
                200,
                {"ok": True},
                {"Set-Cookie": self.session_cookie("", role, max_age=0)},
            )

        def register_customer(self, database: sqlite3.Connection) -> None:
            if not self.has_valid_origin():
                self.send_error_json(403, "Asal request tidak diizinkan.")
                return
            if rate_limited(self, "customer-register"):
                self.send_error_json(
                    429, "Terlalu banyak percobaan pendaftaran. Coba lagi nanti."
                )
                return
            record_rate_attempt(self, "customer-register")
            payload = self.read_json()
            if payload is None:
                return
            name, email, phone = payload.get("name"), payload.get("email"), payload.get("phone")
            password, consent = payload.get("password"), payload.get("consent")
            if not all(isinstance(value, str) for value in (name, email, phone)):
                self.send_error_json(
                    400, "Nama, email, dan nomor WhatsApp wajib diisi."
                )
                return
            if not validate_password(password):
                self.send_error_json(
                    400, f"Kata sandi harus {PASSWORD_MIN_LENGTH}–128 karakter."
                )
                return
            if consent is not True:
                self.send_error_json(400, "Persetujuan Kebijakan Privasi wajib diberikan.")
                return
            clean_name, clean_email, clean_phone = name.strip(), email.strip().lower(), phone.strip()
            if not clean_name or len(clean_name) > 100:
                self.send_error_json(400, "Nama wajib diisi dan maksimal 100 karakter.")
                return
            if len(clean_email) > 254 or not EMAIL_PATTERN.fullmatch(clean_email):
                self.send_error_json(400, "Format email tidak valid.")
                return
            if not PHONE_PATTERN.fullmatch(clean_phone):
                self.send_error_json(400, "Format nomor WhatsApp tidak valid.")
                return
            joined = now_ms()
            member_id = f"BC-{secrets.token_hex(8).upper()}"
            password_hash = hash_password(password)
            member_qr = generate_member_qr(member_id)
            try:
                database.execute(
                    """
                    INSERT INTO customers (
                      member_id, name, email, phone, joined, password_hash,
                      consent_at, privacy_policy_version, qr_code
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        member_id,
                        clean_name,
                        clean_email,
                        clean_phone,
                        joined,
                        password_hash,
                        joined,
                        PRIVACY_POLICY_VERSION,
                        member_qr,
                    ),
                )
                database.commit()
            except sqlite3.IntegrityError as error:
                database.rollback()
                if "customers.email" in str(error) or "UNIQUE constraint failed" in str(error):
                    self.send_error_json(409, "Email ini sudah terdaftar.")
                    return
                raise
            token = self.create_session(database, "customer", member_id=member_id)
            self.send_json(
                201,
                {
                    "id": member_id,
                    "name": clean_name,
                    "email": clean_email,
                    "phone": clean_phone,
                    "joined": joined,
                },
                {"Set-Cookie": self.session_cookie(token, "customer")},
            )

        def login_customer(self, database: sqlite3.Connection) -> None:
            if not self.has_valid_origin():
                self.send_error_json(403, "Asal request tidak diizinkan.")
                return
            if rate_limited(self, "customer-login"):
                self.send_error_json(
                    429, "Terlalu banyak percobaan masuk. Coba lagi dalam 15 menit."
                )
                return
            payload = self.read_json()
            if payload is None:
                return
            email, password = payload.get("email"), payload.get("password")
            if not isinstance(email, str) or not isinstance(password, str):
                self.send_error_json(400, "Email dan kata sandi wajib diisi.")
                return
            customer = database.execute(
                """
                SELECT member_id AS id, name, email, phone, joined, password_hash
                FROM customers WHERE email = ?
                """,
                (email.strip().lower(),),
            ).fetchone()
            password_valid = validate_password(password)
            matches = False
            if customer and customer["password_hash"] and password_valid:
                matches = verify_password(password, customer["password_hash"])
            elif not password_valid:
                hash_password(secrets.token_hex(24))
            if not matches:
                record_rate_attempt(self, "customer-login")
                self.send_error_json(
                    401,
                    "Email atau kata sandi salah. Jika memiliki akun lama, gunakan fitur Lupa kata sandi.",
                )
                return
            clear_rate_limit(self, "customer-login")
            token = self.create_session(database, "customer", member_id=customer["id"])
            response_customer = {
                key: customer[key]
                for key in ("id", "name", "email", "phone", "joined")
            }
            self.send_json(
                200,
                response_customer,
                {"Set-Cookie": self.session_cookie(token, "customer")},
            )

        def forgot_password(self, database: sqlite3.Connection) -> None:
            if not self.has_valid_origin():
                self.send_error_json(403, "Asal request tidak diizinkan.")
                return
            if rate_limited(self, "customer-reset"):
                self.send_error_json(429, "Terlalu banyak permintaan. Coba lagi nanti.")
                return
            record_rate_attempt(self, "customer-reset")
            if not all(
                os.environ.get(key)
                for key in ("RESEND_API_KEY", "EMAIL_FROM", "BASE_URL")
            ):
                self.send_error_json(503, "Layanan pemulihan kata sandi belum dikonfigurasi.")
                return
            payload = self.read_json()
            if payload is None:
                return
            email = payload.get("email")
            if not isinstance(email, str) or not EMAIL_PATTERN.fullmatch(email.strip()):
                self.send_error_json(400, "Format email tidak valid.")
                return
            customer = database.execute(
                "SELECT id, email FROM customers WHERE email = ?",
                (email.strip().lower(),),
            ).fetchone()
            if customer:
                current = now_ms()
                database.execute(
                    "DELETE FROM password_reset_tokens WHERE expires_at <= ? OR used_at IS NOT NULL",
                    (current,),
                )
                token = secrets.token_urlsafe(32)
                token_hash = session_token_hash(token)
                database.execute(
                    """
                    INSERT INTO password_reset_tokens
                      (token_hash, customer_id, created_at, expires_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (token_hash, customer["id"], current, current + RESET_TOKEN_DURATION_MS),
                )
                database.commit()
                try:
                    send_password_reset_email(customer["email"], token)
                except Exception as error:
                    database.execute(
                        "DELETE FROM password_reset_tokens WHERE token_hash = ?", (token_hash,)
                    )
                    database.commit()
                    logging.error("Gagal mengirim email pemulihan kata sandi: %s", error)
            self.send_json(
                202,
                {"message": "Jika email terdaftar, tautan pengaturan ulang akan dikirim."},
            )

        def reset_password(self, database: sqlite3.Connection) -> None:
            if not self.has_valid_origin():
                self.send_error_json(403, "Asal request tidak diizinkan.")
                return
            if rate_limited(self, "customer-reset-confirm"):
                self.send_error_json(429, "Terlalu banyak percobaan. Coba lagi nanti.")
                return
            record_rate_attempt(self, "customer-reset-confirm")
            payload = self.read_json()
            if payload is None:
                return
            token, password = payload.get("token"), payload.get("password")
            if not isinstance(token, str) or not validate_password(password):
                self.send_error_json(
                    400,
                    f"Tautan atau kata sandi tidak valid. Kata sandi harus {PASSWORD_MIN_LENGTH}–128 karakter.",
                )
                return
            reset = database.execute(
                """
                SELECT token_hash, customer_id FROM password_reset_tokens
                WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
                """,
                (session_token_hash(token), now_ms()),
            ).fetchone()
            if not reset:
                self.send_error_json(
                    400, "Tautan pengaturan ulang tidak valid atau sudah kedaluwarsa."
                )
                return
            password_hash = hash_password(password)
            try:
                database.execute("BEGIN IMMEDIATE")
                updated = database.execute(
                    "UPDATE customers SET password_hash = ? WHERE id = ?",
                    (password_hash, reset["customer_id"]),
                )
                consumed = database.execute(
                    """
                    UPDATE password_reset_tokens SET used_at = ?
                    WHERE token_hash = ? AND used_at IS NULL
                    """,
                    (now_ms(), reset["token_hash"]),
                )
                if updated.rowcount != 1 or consumed.rowcount != 1:
                    raise RuntimeError("Tautan reset kata sandi sudah digunakan.")
                customer = database.execute(
                    "SELECT member_id FROM customers WHERE id = ?", (reset["customer_id"],)
                ).fetchone()
                database.execute(
                    "DELETE FROM auth_sessions WHERE member_id = ? AND role = 'customer'",
                    (customer["member_id"],),
                )
                database.commit()
            except Exception:
                database.rollback()
                raise
            self.send_json(
                200, {"message": "Kata sandi berhasil diperbarui. Silakan masuk."}
            )

        def admin_get(
            self,
            database: sqlite3.Connection,
            pathname: str,
            query: dict[str, list[str]],
        ) -> None:
            if pathname == "/api/admin/promos":
                self.send_json(200, [dict(row) for row in self.list_promos(database, False)])
            elif pathname == "/api/admin/customers":
                search = (query.get("q", [""])[0] or "").strip()[:100]
                self.send_json(
                    200,
                    [dict(row) for row in self.customer_search(database, search)],
                )
            elif pathname == "/api/admin/customers.csv":
                search = (query.get("q", [""])[0] or "").strip()[:100]
                self.send_csv(self.customer_search(database, search))
            elif pathname == "/api/admin/claims":
                rows = database.execute(
                    """
                    SELECT id, promo_id, promo_title, member_id, customer_name, claimed_at
                    FROM promo_claims ORDER BY claimed_at DESC LIMIT 500
                    """
                ).fetchall()
                self.send_json(200, [dict(row) for row in rows])
            elif pathname == "/api/admin/analytics":
                self.send_json(200, self.get_analytics(database))
            else:
                self.send_error_json(404, "Endpoint tidak ditemukan.")

        def admin_post(self, database: sqlite3.Connection, pathname: str) -> None:
            if pathname == "/api/admin/promos":
                payload = self.read_json()
                if payload is None:
                    return
                status, result = self.save_promo(database, payload)
                if isinstance(result, str):
                    self.send_error_json(status, result)
                else:
                    self.send_json(status, result)
                return
            if pathname == "/api/admin/claims":
                payload = self.read_json()
                if payload is None:
                    return
                member_id, promo_id = payload.get("member_id"), payload.get("promo_id")
                if (
                    not isinstance(member_id, str)
                    or not member_id.strip()
                    or isinstance(promo_id, bool)
                    or not isinstance(promo_id, int)
                    or promo_id <= 0
                ):
                    self.send_error_json(400, "Pelanggan dan promo wajib dipilih.")
                    return
                customer = database.execute(
                    "SELECT member_id, name FROM customers WHERE member_id = ?",
                    (member_id.strip(),),
                ).fetchone()
                if not customer:
                    self.send_error_json(404, "Pelanggan tidak ditemukan.")
                    return
                today = date.today().isoformat()
                promo = database.execute(
                    """
                    SELECT id, title FROM promos
                    WHERE id = ? AND active = 1
                      AND (starts_on IS NULL OR starts_on = '' OR starts_on <= ?)
                      AND (ends_on IS NULL OR ends_on = '' OR ends_on >= ?)
                    """,
                    (promo_id, today, today),
                ).fetchone()
                if not promo:
                    self.send_error_json(
                        400, "Promo tidak aktif atau di luar masa berlaku."
                    )
                    return
                claimed_at = now_ms()
                cursor = database.execute(
                    """
                    INSERT INTO promo_claims
                      (promo_id, promo_title, member_id, customer_name, claimed_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        promo["id"],
                        promo["title"],
                        customer["member_id"],
                        customer["name"],
                        claimed_at,
                    ),
                )
                database.commit()
                self.send_json(
                    201,
                    {
                        "id": cursor.lastrowid,
                        "promo_id": promo["id"],
                        "promo_title": promo["title"],
                        "member_id": customer["member_id"],
                        "customer_name": customer["name"],
                        "claimed_at": claimed_at,
                    },
                )
                return
            self.send_error_json(404, "Endpoint tidak ditemukan.")

    class Server(ThreadingHTTPServer):
        daemon_threads = True
        allow_reuse_address = True

    return Server((host or os.environ.get("HOST", "0.0.0.0"), port if port is not None else int(os.environ.get("PORT", "8000"))), BrewClubHandler)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if os.environ.get("NODE_ENV") == "production":
        if len(os.environ.get("ADMIN_PASSWORD", "")) < PASSWORD_MIN_LENGTH:
            logging.error("ADMIN_PASSWORD wajib diatur (minimal 12 karakter) untuk production.")
            return 1
        if not os.environ.get("BASE_URL", "").startswith("https://"):
            logging.error("BASE_URL HTTPS wajib diatur untuk production.")
            return 1
    try:
        server = create_server()
    except OSError as error:
        logging.error("Database gagal dibuka: %s", error)
        return 1
    port = server.server_address[1]
    logging.info("BrewClub berjalan di http://127.0.0.1:%s", port)
    if len(os.environ.get("ADMIN_PASSWORD", "")) < PASSWORD_MIN_LENGTH:
        logging.warning(
            "Login admin belum aktif: set ADMIN_PASSWORD (minimal 12 karakter) lalu mulai ulang server."
        )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logging.info("Server dihentikan.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
