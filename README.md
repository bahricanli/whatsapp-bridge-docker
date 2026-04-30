# WhatsApp Bridge

Baileys tabanlı, Docker üzerinde çalışan standalone WhatsApp REST API servisi.

---

## Kurulum

```bash
cp .env.example .env
# .env içinde WA_API_KEY'i doldur
docker compose up -d --build
```

---

## İlk bağlantı (QR tarama)

Container ayağa kalktıktan sonra QR kodu tara:

**Tarayıcıdan:**
```
http://SUNUCU_IP:3000/qr.png
```

**Terminalde:**
```bash
docker compose logs -f
```

WhatsApp uygulamasında → **Bağlı Cihazlar** → **Cihaz Ekle** → QR'ı tara.

Tarama tamamlandığında oturum `/data/auth` volume'una kaydedilir. Container yeniden başlatılsa bile QR tekrar istenmez.

---

## API

Tüm isteklerde `Authorization: Bearer <WA_API_KEY>` header'ı gerekir.

### `GET /status`
```json
{
  "ok": true,
  "connected": true,
  "qr_pending": false,
  "uptime_s": 3600,
  "retry_count": 0
}
```

### `GET /qr` — Base64 PNG
```json
{ "qr": "data:image/png;base64,..." }
```

### `GET /qr.png` — Direkt PNG resim

### `POST /send`
```json
// Request
{ "to": "905551234567", "text": "Doğrulama kodunuz: 1234" }

// Response
{ "ok": true, "jid": "905551234567@s.whatsapp.net" }
```

### `POST /send-bulk`
```json
// Request
[
  { "to": "905551234567", "text": "Mesaj 1" },
  { "to": "905559876543", "text": "Mesaj 2" }
]

// Response
{
  "results": [
    { "to": "905551234567", "ok": true, "jid": "905551234567@s.whatsapp.net" },
    { "to": "905559876543", "ok": true, "jid": "905559876543@s.whatsapp.net" }
  ]
}
```

---

## Kabul edilen telefon numarası formatları

| Giriş          | Normalize edilmiş |
|----------------|-------------------|
| `905551234567` | `905551234567`    |
| `+905551234567`| `905551234567`    |
| `0905551234567`| `905551234567`    |
| `05551234567`  | `905551234567`    |
| `5551234567`   | `905551234567`    |

---

## Ortam değişkenleri

| Değişken         | Varsayılan   | Açıklama                                   |
|------------------|--------------|--------------------------------------------|
| `WA_API_KEY`     | _(boş)_      | Bearer token; boşsa auth devre dışı        |
| `WA_HOST_PORT`   | `3000`       | Host'a bağlanan port                        |
| `WA_MAX_RETRIES` | `10`         | Yeniden bağlanma denemesi                  |
| `LOG_LEVEL`      | `info`       | `trace / debug / info / warn / error`      |

---

## Nginx reverse proxy (önerilen)

Servisi doğrudan 3000 portuyla açmak yerine Nginx arkasına alıp HTTPS ekleyin:

```nginx
server {
    listen 443 ssl;
    server_name wa.example.com;

    ssl_certificate     /etc/letsencrypt/live/wa.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/wa.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
    }
}
```

---

## Laravel entegrasyonu

`bahricanli/whatsapp-bridge` paketi ile:

```env
WHATSAPP_BRIDGE_URL=https://wa.example.com
WHATSAPP_BRIDGE_API_KEY=gizli-anahtar-buraya
```
