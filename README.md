# BrewClub

Website loyalty BrewClub dengan backend Python, database SQLite, autentikasi pelanggan, dan panel admin untuk mengelola promo serta pelanggan.

## Menjalankan secara lokal

Gunakan Python 3.11 atau lebih baru.

PowerShell:

```powershell
$env:PYTHONDONTWRITEBYTECODE = "1"
python -m pip install -r requirements.txt
$env:ADMIN_USERNAME = "admin"
$env:ADMIN_PASSWORD = "gunakan-kata-sandi-kuat-minimal-12-karakter"
python backend\server.py
```

Buka [http://127.0.0.1:8000](http://127.0.0.1:8000). Jangan membuka file HTML secara langsung; halaman membutuhkan backend. Database SQLite lokal berada di `~\.brewclub\customers.sqlite3`.

Jalankan pengujian dengan:

```powershell
$env:PYTHONDONTWRITEBYTECODE = "1"
python -m unittest backend.test_server -v
```

## Login pelanggan dan admin

Pelanggan baru mendaftar dengan email, kata sandi minimal 12 karakter, dan persetujuan Kebijakan Privasi. Sesi login tersimpan di SQLite dan berlaku selama 8 jam, termasuk setelah server dimulai ulang. Akun pelanggan lama dapat menggunakan **Lupa kata sandi** untuk membuat kata sandi.

Reset kata sandi lewat email memerlukan akun Resend dan konfigurasi `RESEND_API_KEY`, `EMAIL_FROM`, serta `BASE_URL`. Tanpa konfigurasi tersebut, pemulihan email tidak tersedia. Pastikan identitas pengelola dan kontak pada [privacy.html](./privacy.html) benar sebelum situs dibuka ke publik.

Panel admin tersedia di `/admin.html`. Atur `ADMIN_USERNAME` dan `ADMIN_PASSWORD` sebelum server dijalankan. Gunakan kata sandi unik dan jangan menyimpan file `.env` ke Git.

Setiap pelanggan mendapat QR Code standar yang memuat ID Member. Gambar PNG QR disimpan pada tabel pelanggan di SQLite; kartu member menampilkan gambar dari sesi pelanggan yang sedang masuk. QR pelanggan lama dibuat otomatis saat database dimigrasikan. Kasir dapat memindai QR untuk membaca ID Member, lalu mencari pelanggan di panel admin.

Fitur admin meliputi pengelolaan promo dan masa berlakunya, status promo, pencatatan klaim kasir, analitik klaim, pencarian pelanggan, serta ekspor CSV.

## Deploy ke Render

1. Unggah hanya file proyek BrewClub ke repository GitHub; jangan ikutkan `.env`, database SQLite, atau folder backup.
2. Pada Render, pilih **New → Web Service**, lalu hubungkan repository.
3. Pilih runtime **Python** dan isi:
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `python backend/server.py`
   - **Health Check Path:** `/api/health`
   - **Instance Type:** Free untuk demo.
4. Tambahkan environment variables:
   - `NODE_ENV` = `production`
   - `ADMIN_USERNAME` = username admin pilihan Anda
   - `ADMIN_PASSWORD` = kata sandi unik minimal 12 karakter
   - `BASE_URL` = alamat HTTPS Render setelah deploy, misalnya `https://nama-app.onrender.com`
   - `TRUST_PROXY` = `1`
   - Untuk reset kata sandi email: `RESEND_API_KEY` dan `EMAIL_FROM`.
5. Setelah deploy, periksa `https://nama-app.onrender.com/api/health`, lalu buka `/admin.html`.

**Paket gratis Render hanya untuk demo.** Aplikasi akan tidur setelah periode tanpa trafik dan filesystem bersifat sementara; database SQLite dapat hilang saat restart, deploy, atau server tidur. Jangan masukkan data pelanggan sungguhan pada layanan gratis ini.

## Deploy dengan Docker Compose

Deploy ini menjalankan Python di jaringan internal Compose dan Caddy sebagai reverse proxy HTTPS. Dibutuhkan server dengan Docker Engine/Compose, domain dengan DNS yang mengarah ke server, serta port TCP 80/443 yang dapat dijangkau dari internet.

1. Salin `.env.example` menjadi `.env`, lalu isi `BREWCLUB_DOMAIN`, `BASE_URL`, kredensial admin acak, serta konfigurasi Resend jika diperlukan.
2. Pastikan DNS dan firewall domain/server siap.
3. Jalankan:

   ```sh
   docker compose up -d --build
   docker compose ps
   docker compose logs -f app caddy
   ```

4. Buka `https://<domain>` dan periksa `/api/health`. Jangan mengekspos port 8000 langsung ke internet.

Caddy mengurus sertifikat TLS otomatis setelah DNS dan port tersedia. Data SQLite disimpan di volume Docker `brewclub-data`; sertifikat dan konfigurasi Caddy juga disimpan di volume persisten. Menghapus volume Docker dapat menghapus data pelanggan.

### Memindahkan database lokal ke deploy Docker

Cadangkan database lokal terlebih dahulu. Setelah layanan dimulai pertama kali, hentikan app, salin database lama ke container, lalu jalankan kembali:

```sh
docker compose stop app
docker compose cp /path/ke/customers.sqlite3 app:/app/data/customers.sqlite3
docker compose start app
```

Ganti path dengan lokasi absolut file database lokal. Jangan menimpa database yang sudah berisi pendaftaran produksi.

## Backup dan pemulihan

Backup manual lokal:

```powershell
$env:BREWCLUB_DATABASE = "$HOME\.brewclub\customers.sqlite3"
python scripts\backup.py .\backups
```

Di Docker:

```sh
docker compose exec app python scripts/backup.py /backups
```

Direktori `backups` pada host dipasang ke `/backups` di container. Salin backup secara berkala ke penyimpanan lain yang aksesnya dibatasi; backup di server yang sama bukan pengganti backup off-site. Skrip menggunakan SQLite backup API dan memeriksa integritas berkas hasil.

## Catatan operasional

- Database produksi sebaiknya hanya dapat diakses melalui aplikasi, bukan file web.
- Server web hanya menyajikan daftar file HTML, CSS, JavaScript, dan logo yang diizinkan. File database, backup, konfigurasi, dan source backend tidak tersedia sebagai aset publik.
- Lindungi akses panel admin dan akun hosting; buat backup berkala dan uji pemulihannya.
- Kebijakan privasi yang disertakan masih perlu dilengkapi dengan identitas badan usaha, kontak, masa retensi, dan praktik yang benar-benar dijalankan.
- Deploy publik tetap memerlukan domain, akun hosting, DNS, dan kredensial email yang dikelola pemilik.
