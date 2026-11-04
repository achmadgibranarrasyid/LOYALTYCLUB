# BrewClub

Website loyalty BrewClub dengan backend Node.js, database SQLite/Turso, autentikasi pelanggan, QR member, poin/reward, promo, dan panel admin.

## Menjalankan secara lokal

Dibutuhkan Node.js 22.x.

PowerShell:

```powershell
npm.cmd ci
$env:ADMIN_USERNAME = "admin"
$env:ADMIN_PASSWORD = "CHANGE_ME"
npm.cmd start
```

Ganti `CHANGE_ME` dengan kata sandi acak minimal 16 karakter sebelum menjalankan server; nilai contoh akan ditolak oleh backend.

Buka [http://127.0.0.1:8000](http://127.0.0.1:8000). Jangan membuka file HTML secara langsung; halaman membutuhkan backend. SQLite lokal tersimpan di `%USERPROFILE%\.brewclub\customers.sqlite3`, atau gunakan `BREWCLUB_DATABASE` untuk menentukan lokasi lain.

Jalankan pengujian dengan:

```powershell
npm.cmd test
```

## Login pelanggan dan admin

Pelanggan mendaftar dengan email, kata sandi minimal 12 karakter, dan persetujuan Kebijakan Privasi. Sesi login tersimpan di database dan berlaku selama 8 jam. Setiap pelanggan mendapat QR Code PNG yang tersimpan di database. Halaman kartu member menampilkan saldo serta riwayat poin, reward aktif, dan promo yang berlaku. Akun pelanggan dari database SQLite lama tetap dapat masuk; aplikasi menambahkan kolom skema yang diperlukan secara otomatis.

Reset kata sandi melalui email membutuhkan `RESEND_API_KEY`, `EMAIL_FROM`, dan `BASE_URL`. Token reset dikirim sebagai fragmen URL agar tidak dikirim ke server melalui access log. Tanpa konfigurasi email, pemulihan kata sandi tidak tersedia. Pastikan identitas pengelola dan kontak pada [privacy.html](./public/privacy.html) benar sebelum situs dibuka ke publik.

Panel admin tersedia di `/admin.html`. Atur `ADMIN_USERNAME` dan `ADMIN_PASSWORD` sebagai environment variable. Gunakan kata sandi unik, minimal 16 karakter untuk akun admin, dan jangan menyimpan file `.env` ke Git.

Fitur admin mencakup pengelolaan promo dan masa berlakunya, pencatatan klaim kasir, pencarian member berdasarkan nama/nomor telepon saat QR bermasalah, analitik klaim, pencarian pelanggan, serta ekspor CSV. Admin dapat mengatur rasio poin transaksi, poin per klaim, dan batas poin per transaksi; poin klaim diberikan otomatis. Transaksi belanja dan koreksi saldo dicatat manual melalui panel. Reward minuman gratis, diskon nominal, dan reward khusus dapat diatur beserta biaya poinnya, lalu ditukarkan oleh admin/kasir dengan saldo pelanggan.

Nilai awal program adalah 1 poin per Rp10.000 transaksi, 1 poin per klaim promo, dan tanpa batas poin per transaksi. Semua nilai tersebut serta biaya dan manfaat reward dapat diubah dari panel admin. Nilai transaksi di bawah ambang tidak menghasilkan poin; akumulasi dihitung per transaksi.

## Deploy ke Vercel

1. Push repository ke GitHub, lalu impor repository tersebut dari Vercel. Root proyek sudah berisi `vercel.json`, satu function API bersama dengan rewrite untuk seluruh rute `/api/*`, dan aset website pada `public/`.
2. Buat database Turso/libSQL yang persisten, lalu tambahkan environment variable berikut di **Project Settings → Environment Variables**:
   - `TURSO_DATABASE_URL` — URL database Turso.
   - `TURSO_AUTH_TOKEN` — token akses database.
   - `ADMIN_USERNAME` dan `ADMIN_PASSWORD` — kredensial admin unik; gunakan kata sandi acak minimal 16 karakter.
   - `BASE_URL` — URL HTTPS website Vercel.
   - `RESEND_API_KEY` dan `EMAIL_FROM` — opsional, diperlukan untuk reset password lewat email.
3. Deploy dan verifikasi `/api/health`, pendaftaran/login, QR, dan `/admin.html`.

Vercel mewajibkan Turso karena filesystem function tidak persisten. Jangan memakai SQLite lokal untuk menyimpan data produksi di Vercel. Migrasi database SQLite lokal ke Turso harus dilakukan sebagai proses impor terpisah; buat backup dan verifikasi jumlah data sebelum mengalihkan aplikasi. Simpan token Turso dan kredensial admin hanya di environment variables, jangan di repository.

## Deploy menggunakan Docker Compose

Deploy ini menjalankan backend Node.js pada jaringan internal Compose dan Caddy sebagai reverse proxy HTTPS. Dibutuhkan server dengan Docker Engine/Compose, domain yang DNS-nya mengarah ke server, serta port TCP 80/443 yang dapat dijangkau dari internet.

1. Salin `.env.example` menjadi `.env`, lalu isi `BREWCLUB_DOMAIN`, `BASE_URL`, kredensial admin acak, serta konfigurasi Resend jika diperlukan.
2. Pastikan DNS dan firewall siap, kemudian jalankan:

   ```sh
   docker compose up -d --build
   docker compose ps
   docker compose logs -f app caddy
   ```

3. Buka `https://<domain>` dan periksa `/api/health`. Jangan mengekspos port 8000 langsung ke internet.

Caddy mengurus sertifikat TLS otomatis setelah DNS dan port tersedia. Data SQLite disimpan di volume Docker `brewclub-data`; sertifikat dan konfigurasi Caddy juga disimpan di volume persisten. Menghapus volume Docker dapat menghapus data pelanggan.

Untuk memakai database SQLite lama di Docker, hentikan app sebelum menyalin database ke volume yang benar. Jangan menimpa database yang sudah berisi pendaftaran produksi. Buat dan verifikasi backup sebelum migrasi.

## Backup database SQLite lokal

Atur `BREWCLUB_DATABASE` ke database lokal, lalu jalankan:

```powershell
$env:BREWCLUB_DATABASE = "$HOME\.brewclub\customers.sqlite3"
npm.cmd run backup -- .\backups
```

Di Docker:

```sh
docker compose exec app npm run backup -- /backups
```

Backup menggunakan SQLite `VACUUM INTO` dan memeriksa integritas berkas hasil. Perintah ini hanya untuk database SQLite lokal, bukan database Turso. Simpan backup secara berkala ke media terpisah yang aksesnya dibatasi; backup di server yang sama bukan pengganti backup off-site.

## Catatan operasional

- Server hanya menyajikan file web yang diizinkan dari folder `public/`; file database, backup, konfigurasi, dan source backend tidak tersedia sebagai aset publik.
- Batasi akses panel admin dan akun hosting; buat backup berkala dan uji pemulihannya.
- Kebijakan privasi yang disertakan perlu dilengkapi dengan identitas badan usaha, kontak, masa retensi, dan praktik yang benar-benar dijalankan.
- Deploy publik tetap memerlukan domain, akun hosting, DNS, dan kredensial email yang dikelola pemilik.
