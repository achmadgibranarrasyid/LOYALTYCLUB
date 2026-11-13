# Catatan Progres — MONT Loyalty (sebelumnya BrewClub)

> Catatan kerja bersama asisten, terakhir diperbarui: 12 November 2026

## Status project
- Project: website loyalty program MONT (Node.js murni + SQLite/libSQL Turso), Node 22, hanya dependensi `@libsql/client`.
- Struktur: `backend/server.js` (server + API), `api/index.js` (adapter Vercel), `public/` (frontend), `scripts/backup.js`.
- **Rebranding selesai**: semua kata BrewClub/BREWCLUB/brewclub diganti MONT/MONT_/mont di 17 file (cookie `mont_admin`/`mont_customer`, localStorage `mont_v3`/`mont_v2`, env var `MONT_DATABASE`/`MONT_DOMAIN`, volume Docker `mont-data`, folder DB `~/.mont`).
- Test: `node --test` → 6/6 lulus setelah rebranding.
- Footer index.html diperbarui © 2026.

## Git & GitHub
- Remote: `https://github.com/achmadgibranarrasyid/LOYALTYCLUB.git` (branch `main`).
- Selesai: rebase di atas 8 commit lama remote (`git pull --rebase -X theirs origin main`) lalu push sukses → commit `7ba4bf9` "Restrukturisasi project dan rebranding MONT".
- `.github/workflows/deploy.yml` sempat dibuat lalu dihapus di GitHub → tidak dipakai (deploy via Vercel).
- `.gitignore` sudah mengecualikan `.env`, database, backup, node_modules. ✔ aman.

## Deployment (sedang berjalan)
Target: **Vercel + Turso** (SQLite lokal tidak bisa dipakai di Vercel — filesystem tidak persisten).

### Tahap yang sudah selesai
1. ✅ Push ke GitHub.
2. ✅ Database Turso dibuat (via dashboard web, tanpa CLI): nama `mont-loyalty`, dapat `TURSO_DATABASE_URL` (libsql://...) dan `TURSO_AUTH_TOKEN`.

### Tahap berikutnya
3. ⏳ **Vercel**: login via GitHub → Add New Project → import `LOYALTYCLUB`.
   - Framework Preset: Other/kosong, **Root Directory kosong** (jangan pilih subfolder).
   - Environment Variables (Production):
     - `TURSO_DATABASE_URL` = libsql://mont-loyalty-xxxx.turso.io
     - `TURSO_AUTH_TOKEN` = token Turso
     - `ADMIN_USERNAME` = pilihan sendiri (mis. montadmin)
     - `ADMIN_PASSWORD` = acak ≥16 karakter
       (generate: `-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 20 | % {[char]$_})`)
   - Klik Deploy.
4. ⏳ Set `BASE_URL` = URL Vercel (tanpa `/` akhir) di Settings → Environment Variables → **Redeploy**.
5. ⏳ Verifikasi:
   - `/` → landing page MONT + promo
   - `/api/health` → JSON ok
   - `/admin.html` → login admin (kredensial env)
   - Alur: kelola promo → daftar pelanggan → catat transaksi/poin → cek akun pelanggan.

## Catatan penting
- Skema DB + promo awal diisi otomatis saat akses pertama.
- Reset password via email butuh `RESEND_API_KEY`, `EMAIL_FROM`, `BASE_URL` — tanpa itu fitur nonaktif (by design).
- Kredensial hanya di env variables, jangan di repo/chat.
- Data lama tidak hilang saat rebranding (DB tak disentuh); sesi login lama tidak berlaku karena nama cookie berubah.
- Masih tersisa dari review deploy (opsional): privacy.html identitas badan usaha & masa retensi; CSP masih `'unsafe-inline'`.

## Fitur foto promo (baru, 12 Nov 2026)
- Kolom `image_url` di tabel `promos` (migrasi otomatis via daftar kolom).
- Admin: form promo dapat upload foto (≤500 KB, JPG/PNG/WebP/GIF) dengan pratinjau + tombol hapus; tersimpan sebagai data-URI di DB — aman di Vercel tanpa storage file.
- Alternatif: URL https untuk foto.
- Landing page & list admin menampilkan foto (CSS `promo-card-image`, `admin-promo-thumb`, `admin-image-preview`).
- CSP `img-src` ditambah `https:` di server.js dan vercel.json.
- Batas body endpoint promo dinaikkan khusus (`PROMO_BODY_MAX_SIZE` 750 KB) via parameter `readJson(req, maxSize)`.
- Test 6/6 lulus + uji manual end-to-end (simpan, tampil di API publik, tolak non-gambar 400, tolak oversize 413, hapus foto).

## Sistem kode klaim promo + kuota (baru, 12 Nov 2026)
- Pelanggan klik "Klaim/Ambil Kode" → backend buat kode unik `MONT-XXXXXXXX` (alfabet tanpa karakter rancu), tersimpan `promo_claims.status='pending'`.
- Admin: seksi "Verifikasi kode promo" di panel admin → masukkan kode → klaim terverifikasi (`status='verified'`, `verified_at`). Kode bekas pakai ditolak 404.
- Kuota promo terbatas: field `max_claims` di form promo (0 = tanpa batas). Kuota dihitung dari klaim pending+verified; saat habis: klaim baru 409, verifikasi melebihi kuota membatalkan kode (`status='rejected'`).
- Duplikat: 1 pelanggan max 1 kode pending per promo (dapat existing_code dari API).
- Endpoint baru: `POST /api/customer/promos/claim` (rate limit 15/jam), `GET /api/customer/promo-claims`, `POST /api/admin/claims/verify`. Kuota juga dicek pada pencatatan klaim manual admin.
- UI: modal kode di index.html & akun.html (+tombol salin), daftar "Kode Klaim Saya", tabel klaim admin tambah kolom Kode & Status, analytics hanya menghitung klaim non-rejected.
- Uji end-to-end: klaim ✓, duplikat 409 ✓, kuota habis 409 ✓, verifikasi 200 ✓, verifikasi ulang 404 ✓, test suite 6/6 ✓.

## Menjalankan lokal
```powershell
cd D:\LOYALTYCLUB
npm ci
$env:ADMIN_USERNAME = "admin"
$env:ADMIN_PASSWORD = "<acak ≥16 karakter>"
npm start           # http://127.0.0.1:8000
npm test
```
DB lokal: `~\.mont\customers.sqlite3` (atau `MONT_DATABASE`). Backup: `npm run backup -- .\backups`.
