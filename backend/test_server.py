from __future__ import annotations

import csv
import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from PIL import Image

from backend import server as app


ROOT_DIR = Path(__file__).resolve().parent.parent


class BrewClubServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temp_directory = tempfile.TemporaryDirectory(prefix="brewclub-python-test-")
        cls.database_path = Path(cls.temp_directory.name) / "customers.sqlite3"
        os.environ["ADMIN_USERNAME"] = "admin"
        os.environ["ADMIN_PASSWORD"] = "BrewClub-test-password-2026"
        os.environ["RESEND_API_KEY"] = "test-resend-key"
        os.environ["EMAIL_FROM"] = "BrewClub <test@example.invalid>"
        os.environ["BASE_URL"] = "https://brewclub.example.invalid"
        cls.http_server = app.create_server("127.0.0.1", 0, cls.database_path)
        cls.server_thread = threading.Thread(target=cls.http_server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.origin = f"http://127.0.0.1:{cls.http_server.server_address[1]}"
        cls.admin_cookie = None

    @classmethod
    def tearDownClass(cls) -> None:
        cls.http_server.shutdown()
        cls.http_server.server_close()
        cls.server_thread.join(timeout=5)
        cls.temp_directory.cleanup()

    def request(
        self,
        path: str,
        method: str = "GET",
        payload: dict | None = None,
        cookie: str | None = None,
        authenticated: bool = False,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, object, dict[str, str]]:
        request_headers = dict(headers or {})
        body = None
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        if method != "GET":
            request_headers["Origin"] = self.origin
        if cookie:
            request_headers["Cookie"] = cookie
        elif authenticated and self.admin_cookie:
            request_headers["Cookie"] = self.admin_cookie
        request = Request(
            self.origin + path,
            data=body,
            headers=request_headers,
            method=method,
        )
        try:
            response = urlopen(request, timeout=5)
        except HTTPError as error:
            response = error
        raw_body = response.read()
        content_type = response.headers.get("Content-Type", "")
        response_headers = dict(response.headers.items())
        response.close()
        result = (
            json.loads(raw_body)
            if "application/json" in content_type
            else raw_body
            if content_type == "image/png"
            else raw_body.decode("utf-8-sig", errors="replace")
        )
        return response.status, result, response_headers

    @staticmethod
    def cookie_value(headers: dict[str, str]) -> str:
        set_cookie = next(value for key, value in headers.items() if key.lower() == "set-cookie")
        return set_cookie.split(";", 1)[0]

    def test_existing_database_migrates_without_losing_customer_or_promo(self) -> None:
        legacy_path = Path(self.temp_directory.name) / "legacy.sqlite3"
        legacy = sqlite3.connect(legacy_path)
        legacy.executescript(
            """
            CREATE TABLE customers (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              member_id TEXT NOT NULL UNIQUE,
              name TEXT NOT NULL,
              email TEXT NOT NULL COLLATE NOCASE UNIQUE,
              phone TEXT NOT NULL,
              joined INTEGER NOT NULL
            );
            CREATE TABLE promos (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              category TEXT NOT NULL,
              label TEXT NOT NULL,
              title TEXT NOT NULL,
              description TEXT NOT NULL,
              price_old TEXT NOT NULL DEFAULT '',
              price_new TEXT NOT NULL DEFAULT '',
              active INTEGER NOT NULL DEFAULT 1
            );
            INSERT INTO customers (member_id, name, email, phone, joined)
              VALUES ('BC-LEGACY', 'Legacy Customer', 'legacy@example.invalid', '08123456789', 1);
            INSERT INTO promos (category, label, title, description)
              VALUES ('diskon', 'OLD', 'Legacy Promo', 'Preserve this promo.');
            """
        )
        legacy.close()

        app.initialize_database(legacy_path)
        migrated = sqlite3.connect(legacy_path)
        customer_columns = {
            row[1] for row in migrated.execute("PRAGMA table_info(customers)")
        }
        promo_columns = {row[1] for row in migrated.execute("PRAGMA table_info(promos)")}
        self.assertTrue(
            {"password_hash", "consent_at", "privacy_policy_version", "qr_code"}
            <= customer_columns
        )
        self.assertTrue({"starts_on", "ends_on"} <= promo_columns)
        self.assertEqual(
            migrated.execute("SELECT name FROM customers WHERE member_id = 'BC-LEGACY'").fetchone()[0],
            "Legacy Customer",
        )
        legacy_qr = migrated.execute(
            "SELECT qr_code FROM customers WHERE member_id = 'BC-LEGACY'"
        ).fetchone()[0]
        self.assertTrue(legacy_qr.startswith(b"\x89PNG\r\n\x1a\n"))
        with Image.open(io.BytesIO(legacy_qr)) as image:
            self.assertEqual(image.format, "PNG")
            image.load()
        self.assertEqual(migrated.execute("SELECT title FROM promos WHERE id = 1").fetchone()[0], "Legacy Promo")
        self.assertEqual(migrated.execute("SELECT COUNT(*) FROM promos").fetchone()[0], 1)
        migrated.close()

        backup_directory = Path(self.temp_directory.name) / "backups"
        subprocess.run(
            [sys.executable, str(ROOT_DIR / "scripts" / "backup.py"), str(backup_directory)],
            check=True,
            capture_output=True,
            text=True,
            env={**os.environ, "BREWCLUB_DATABASE": str(legacy_path)},
        )
        backup_path = next(backup_directory.glob("*.sqlite3"))
        backup = sqlite3.connect(backup_path)
        self.assertEqual(backup.execute("PRAGMA quick_check").fetchone()[0], "ok")
        self.assertEqual(
            backup.execute("SELECT name FROM customers WHERE member_id = 'BC-LEGACY'").fetchone()[0],
            "Legacy Customer",
        )
        backup.close()

    def test_customer_admin_promo_and_password_recovery_workflows(self) -> None:
        status, health, _ = self.request("/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(health["status"], "ok")

        status, page, headers = self.request("/admin.html")
        self.assertEqual(status, 200)
        self.assertIn("text/html", next(v for k, v in headers.items() if k.lower() == "content-type"))
        status, member_page, _ = self.request("/pengguna.html")
        self.assertEqual(status, 200)
        self.assertIn('id="qrCodeImage"', member_page)
        status, member_script, _ = self.request("/script.js")
        self.assertEqual(status, 200)
        self.assertIn("'/api/customer/qr'", member_script)
        status, legacy_account_page, _ = self.request("/akun.html")
        self.assertEqual(status, 200)
        self.assertIn('id="qrCodeImage"', legacy_account_page)
        status, privacy_page, _ = self.request("/privacy.html")
        self.assertEqual(status, 200)
        self.assertIn("achmadgibranarrasyid@gmail.com", privacy_page)
        self.assertIn("paling lambat 7 hari", privacy_page)
        self.assertIn("disimpan tanpa batas waktu", privacy_page)
        with self.assertLogs(level="INFO") as request_logs:
            status, _, _ = self.request("/reset-password.html?token=secret-reset-token")
        self.assertEqual(status, 200)
        self.assertIn("[REDACTED]", "\n".join(request_logs.output))
        self.assertNotIn("secret-reset-token", "\n".join(request_logs.output))
        status, logo, headers = self.request("/mont-logo.svg")
        self.assertEqual(status, 200)
        self.assertIn("image/svg+xml", next(v for k, v in headers.items() if k.lower() == "content-type"))
        self.assertIn("#29491f", logo)
        status, css, _ = self.request("/style.css")
        self.assertEqual(status, 200)
        self.assertIn("--bg:#F2F2C0", css)
        self.assertIn("--accent:#F15A24", css)
        for private_path in (
            "/README.md",
            "/.env.example",
            "/backend/server.py",
            "/backend/test_server.py",
            "/scripts/backup.py",
            "/backups/customer-data.sqlite3",
        ):
            with self.subTest(path=private_path):
                status, _, _ = self.request(private_path)
                self.assertEqual(status, 404)

        status, _, _ = self.request("/api/admin/customers")
        self.assertEqual(status, 401)
        status, _, _ = self.request("/api/customer/qr")
        self.assertEqual(status, 401)

        status, customer, headers = self.request(
            "/api/customers",
            "POST",
            {
                "name": "=2+3",
                "email": "python-test@example.invalid",
                "phone": "08123456789",
                "password": "Customer-password-2026",
                "consent": True,
            },
        )
        self.assertEqual(status, 201)
        self.assertRegex(customer["id"], r"^BC-[A-F0-9]{16}$")
        customer_cookie = self.cookie_value(headers)
        set_cookie = next(v for k, v in headers.items() if k.lower() == "set-cookie")
        self.assertIn("HttpOnly", set_cookie)
        status, qr_png, qr_headers = self.request(
            "/api/customer/qr", cookie=customer_cookie
        )
        self.assertEqual(status, 200)
        self.assertEqual(
            next(v for k, v in qr_headers.items() if k.lower() == "content-type"),
            "image/png",
        )
        self.assertEqual(
            next(v for k, v in qr_headers.items() if k.lower() == "cache-control"),
            "private, no-store",
        )
        self.assertTrue(qr_png.startswith(b"\x89PNG\r\n\x1a\n"))
        with Image.open(io.BytesIO(qr_png)) as image:
            self.assertEqual(image.format, "PNG")
            image.load()
        database = sqlite3.connect(self.database_path)
        try:
            stored_qr = database.execute(
                "SELECT qr_code FROM customers WHERE member_id = ?", (customer["id"],)
            ).fetchone()[0]
        finally:
            database.close()
        self.assertEqual(qr_png, stored_qr)
        status, session, _ = self.request("/api/customer/session", cookie=customer_cookie)
        self.assertEqual(status, 200)
        self.assertTrue(session["authenticated"])
        self.assertEqual(session["customer"]["id"], customer["id"])

        second_server = app.create_server(
            "127.0.0.1", 0, self.database_path
        )
        second_thread = threading.Thread(target=second_server.serve_forever, daemon=True)
        second_thread.start()
        try:
            second_origin = f"http://127.0.0.1:{second_server.server_address[1]}"
            with urlopen(
                Request(
                    second_origin + "/api/customer/session",
                    headers={"Cookie": customer_cookie},
                ),
                timeout=5,
            ) as response:
                persisted_session = json.loads(response.read())
            self.assertTrue(persisted_session["authenticated"])
            self.assertEqual(persisted_session["customer"]["id"], customer["id"])
        finally:
            second_server.shutdown()
            second_server.server_close()
            second_thread.join(timeout=5)

        status, _, _ = self.request(
            "/api/customers",
            "POST",
            {
                "name": "Duplicate",
                "email": "PYTHON-TEST@example.invalid",
                "phone": "08123456789",
                "password": "Customer-password-2026",
                "consent": True,
            },
        )
        self.assertEqual(status, 409)
        status, _, _ = self.request(
            "/api/customers",
            "POST",
            {
                "name": "No Consent",
                "email": "no-consent@example.invalid",
                "phone": "08123456789",
                "password": "Customer-password-2026",
                "consent": False,
            },
        )
        self.assertEqual(status, 400)

        status, customer_login, headers = self.request(
            "/api/customer/login",
            "POST",
            {"email": "python-test@example.invalid", "password": "Customer-password-2026"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(customer_login["id"], customer["id"])
        customer_login_cookie = self.cookie_value(headers)

        status, admin_login, headers = self.request(
            "/api/admin/login",
            "POST",
            {"username": "admin", "password": os.environ["ADMIN_PASSWORD"]},
        )
        self.assertEqual(status, 200)
        self.admin_cookie = self.cookie_value(headers)
        self.assertTrue(admin_login["authenticated"])
        self.assertIn("HttpOnly", next(v for k, v in headers.items() if k.lower() == "set-cookie"))

        status, customers, _ = self.request(
            "/api/admin/customers?q=python-test", authenticated=True
        )
        self.assertEqual(status, 200)
        self.assertEqual(len(customers), 1)
        csv_status, csv_content, _ = self.request(
            "/api/admin/customers.csv?q=python-test", authenticated=True
        )
        self.assertEqual(csv_status, 200)
        rows = list(csv.reader(io.StringIO(csv_content)))
        self.assertEqual(rows[1][1], "'=2+3")

        status, promos, _ = self.request("/api/admin/promos", authenticated=True)
        self.assertEqual(status, 200)
        self.assertEqual(len(promos), 6)
        today = date.today().isoformat()
        tomorrow = (date.today() + timedelta(days=1)).isoformat()
        status, promo, _ = self.request(
            "/api/admin/promos",
            "POST",
            {
                "category": "diskon",
                "label": "TEST 10%",
                "title": "Python Test Promo",
                "description": "Promo untuk pengujian.",
                "starts_on": today,
                "ends_on": tomorrow,
            },
            authenticated=True,
        )
        self.assertEqual(status, 201)
        promo_id = promo["id"]
        status, public_promos, _ = self.request("/api/promos")
        self.assertTrue(any(item["id"] == promo_id for item in public_promos))

        status, claim, _ = self.request(
            "/api/admin/claims",
            "POST",
            {"member_id": customer["id"], "promo_id": promo_id},
            authenticated=True,
        )
        self.assertEqual(status, 201)
        self.assertEqual(claim["customer_name"], "=2+3")
        status, analytics, _ = self.request("/api/admin/analytics", authenticated=True)
        self.assertEqual(status, 200)
        self.assertEqual(analytics["total_claims"], 1)
        self.assertEqual(len(analytics["daily"]), 7)
        self.assertEqual(analytics["top_promos"][0]["title"], "Python Test Promo")

        captured_tokens: list[str] = []
        with patch.object(
            app, "send_password_reset_email", side_effect=lambda email, token: captured_tokens.append(token)
        ):
            status, _, _ = self.request(
                "/api/customer/forgot-password",
                "POST",
                {"email": "python-test@example.invalid"},
            )
        self.assertEqual(status, 202)
        self.assertEqual(len(captured_tokens), 1)
        status, reset_result, _ = self.request(
            "/api/customer/reset-password",
            "POST",
            {"token": captured_tokens[0], "password": "New-customer-password-2026"},
        )
        self.assertEqual(status, 200)
        self.assertIn("berhasil", reset_result["message"])
        status, replay, _ = self.request(
            "/api/customer/reset-password",
            "POST",
            {"token": captured_tokens[0], "password": "Another-customer-password-2026"},
        )
        self.assertEqual(status, 400)
        status, revoked, _ = self.request(
            "/api/customer/session", cookie=customer_login_cookie
        )
        self.assertFalse(revoked["authenticated"])
        status, _, _ = self.request(
            "/api/customer/login",
            "POST",
            {"email": "python-test@example.invalid", "password": "Customer-password-2026"},
        )
        self.assertEqual(status, 401)
        status, _, headers = self.request(
            "/api/customer/login",
            "POST",
            {"email": "python-test@example.invalid", "password": "New-customer-password-2026"},
        )
        self.assertEqual(status, 200)
        new_customer_cookie = self.cookie_value(headers)
        status, _, _ = self.request(
            "/api/customer/logout",
            "POST",
            {},
            cookie=new_customer_cookie,
        )
        self.assertEqual(status, 200)
        status, logged_out, _ = self.request(
            "/api/customer/session", cookie=new_customer_cookie
        )
        self.assertFalse(logged_out["authenticated"])

        status, _, _ = self.request(
            f"/api/admin/promos/{promo_id}/active",
            "PATCH",
            {"active": False},
            authenticated=True,
        )
        self.assertEqual(status, 200)
        status, public_promos, _ = self.request("/api/promos")
        self.assertFalse(any(item["id"] == promo_id for item in public_promos))
        status, _, _ = self.request(
            f"/api/admin/promos/{promo_id}",
            "PUT",
            {
                "category": "bundling",
                "label": "TEST UPDATE",
                "title": "Updated Python Test Promo",
                "description": "Promo diperbarui.",
                "price_old": "Rp 20.000",
                "price_new": "Rp 18.000",
            },
            authenticated=True,
        )
        self.assertEqual(status, 200)
        status, _, _ = self.request(
            f"/api/admin/promos/{promo_id}", "DELETE", authenticated=True
        )
        self.assertEqual(status, 200)
        self.request("/api/admin/logout", "POST", {}, authenticated=True)
        self.admin_cookie = None
        status, _, _ = self.request("/api/admin/customers")
        self.assertEqual(status, 401)


if __name__ == "__main__":
    unittest.main()
