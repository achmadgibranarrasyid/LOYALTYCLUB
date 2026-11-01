# BrewClub

Website loyalty BrewClub dengan backend Node.js, database SQLite, autentikasi pelanggan, dan panel admin untuk mengelola promo serta pelanggan.

## Menjalankan secara lokal

Gunakan Node.js 24 atau lebih baru. Dari folder proyek, atur kredensial admin lalu jalankan:

```powershell
$env:ADMIN_USERNAME = "admin"
$env:ADMIN_PASSWORD = "gunakan-kata-sandi-kuat-minimal-12-karakter"
npm.cmd start
```

Buka [http://127.0.0.1:8000](http://127.0.0.1:8000). Jangan membuka file HTML langsung; halaman memerlukan backend. Database SQLite lokal berada di `~\.brewclub\customers.sqlite3`. Backend menggunakan `node:sqlite` dan tidak membutuhkan paket npm tambahan.

Jalankan pengujian dengan `npm.cmd test`.

## Login pelanggan dan admin

Pelanggan baru mendaftar dengan email, kata sandi minimal 12 karakter, dan persetujuan Kebijakan Privasi. Sesi login tersimpan di SQLite dan berlaku selama 8 jam, termasuk setelah server dimulai ulang. Akun pelanggan lama dapat menggunakan **Lupa kata sandi** untuk membuat kata sandi.

Reset kata sandi lewat email memerlukan akun Resend dan konfigurasi `RESEND_API_KEY`, `EMAIL_FROM`, serta `BASE_URL`. Tanpa konfigurasi tersebut, pemulihan email tidak tersedia. Perbarui identitas pengelola dan alamat kontak pada [privacy.html](./privacy.html) sebelum situs dibuka ke publik.

Panel admin tersedia di `/admin.html`. Atur `ADMIN_USERNAME` dan `ADMIN_PASSWORD` sebelum server dijalankan. Gunakan kata sandi unik dan jangan menyimpan file `.env` ke Git.

Fitur admin meliputi pengelolaan promo dan masa berlakunya, status promo, pencatatan klaim kasir, analitik klaim, pencarian pelanggan, serta ekspor CSV.

## Deploy publik menggunakan Docker Compose

Deploy ini menyediakan Node.js di jaringan internal Compose dan Caddy sebagai reverse proxy HTTPS. Dibutuhkan:

- Server Linux/VPS dengan Docker Engine dan Docker Compose.
- Domain yang DNS `A`/`AAAA`-nya mengarah ke server.
- Port TCP 80 dan 443 (dan UDP 443 untuk HTTP/3) dapat dijangkau dari internet.
- API key Resend dan alamat pengirim yang telah diverifikasi jika reset password email akan digunakan.

1. Salin `.env.example` menjadi `.env`, lalu isi domain, URL HTTPS, kredensial admin acak, dan konfigurasi Resend. Jangan gunakan nilai contoh.
2. Pastikan DNS domain sudah mengarah ke server dan firewall mengizinkan port 80/443.
3. Jalankan:

   ```sh
   docker compose up -d --build
   docker compose ps
   docker compose logs -f app caddy
   ```

4. Buka `https://<domain>` dan periksa `/api/health`. Jangan mengekspos port 8000 langsung ke internet; Compose hanya mengeksposnya ke Caddy.

Caddy akan meminta dan memperbarui sertifikat TLS otomatis setelah DNS dan port tersedia. Data SQLite disimpan di volume Docker `brewclub-data`; data sertifikat dan konfigurasi Caddy juga disimpan di volume persisten. Simpan `.env` dan backup secara aman. Menghapus volume Docker dapat menghapus data pelanggan.

### Memindahkan database lokal ke deploy Docker

Cadangkan database lokal terlebih dahulu. Setelah layanan dimulai pertama kali, hentikan container app, salin database lama ke container app, lalu jalankan kembali:

```sh
docker compose stop app
docker compose cp /path/ke/customers.sqlite3 app:/app/data/customers.sqlite3
docker compose start app
```

Jalankan `docker compose ps` dan periksa log app untuk memastikan migrasi selesai. Ganti `/path/ke/customers.sqlite3` dengan path absolut file database lokal yang ingin dipindahkan. Jangan menimpa database yang sudah berisi pendaftaran produksi.

## Backup dan pemulihan

Backup manual lokal:

```powershell
$env:BREWCLUB_DATABASE = "$HOME\.brewclub\customers.sqlite3"
node scripts\backup.js .\backups
```

Di Docker, skrip backup dapat dijalankan dari container app:

```sh
docker compose exec app node scripts/backup.js /backups
```

Direktori `backups` pada host dipasang ke `/backups` di container. Salin backup secara berkala ke penyimpanan lain yang aksesnya dibatasi; backup di server yang sama bukan pengganti backup off-site.

Untuk pemulihan Docker, hentikan app, salin backup yang sudah dipilih ke `/app/data/customers.sqlite3` dengan `docker compose cp`, lalu mulai app kembali. Pastikan file backup berasal dari sumber tepercaya dan cek log setelah startup.

## Catatan operasional

- Database produksi sebaiknya hanya dapat diakses melalui aplikasi, bukan file web.
- Lindungi akses panel admin dan akun hosting; buat backup berkala dan uji pemulihannya.
- Kebijakan privasi yang disertakan masih perlu dilengkapi dengan identitas badan usaha, kontak, masa retensi, dan praktik yang benar-benar dijalankan.
- Deploy publik belum dapat dilakukan otomatis dari repository ini: domain, server/akun hosting, DNS, dan kredensial email harus disediakan serta dikonfigurasi oleh pemilik.
