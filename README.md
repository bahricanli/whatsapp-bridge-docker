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

Container ayağa kalktıktan sonra QR kodu terminalde görüntüle:

```bash
docker compose logs -f
```

WhatsApp uygulamasında → **Bağlı Cihazlar** → **Cihaz Ekle** → QR'ı tara.

Tarama tamamlandığında oturum `/data/auth` volume'una kaydedilir. Container yeniden başlatılsa bile QR tekrar istenmez.

---

## API

Tüm isteklerde (GET /status hariç) `Authorization: Bearer <WA_API_KEY>` veya `X-Api-Key: <WA_API_KEY>` header'ı gerekir.

### `GET /status` — Auth gerektirmez
```json
{
  "ok": true,
  "connected": true,
  "channels": 1
}
```

### `GET /channels` — Takip edilen kanalları listele
```json
{
  "ok": true,
  "channels": [
    {
      "jid": "120363430826890742@newsletter",
      "name": "Kanal Adı",
      "description": "...",
      "subscriberCount": 100,
      "role": "admin",
      "picture": "/m1/v/t24/...",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "lastUpdated": "2026-06-26T10:00:00.000Z"
    }
  ]
}
```

### `POST /channels/follow` — Kanala katıl

**Invite URL ile:**
```json
{ "invite": "https://whatsapp.com/channel/0029VbCDO4pEKyZQKQqzl13B" }
```

**JID ile:**
```json
{ "jid": "120363430826890742@newsletter" }
```

### `POST /channels/unfollow` — Kanalı bırak
```json
{ "jid": "120363430826890742@newsletter" }
```

### `GET /channels/stats?jid=...` — Tek kanal istatistiği
```
GET /channels/stats?jid=120363430826890742%40newsletter
```
> `@` işaretini URL encode edin: `@` → `%40`

### `POST /channels/refresh` — Tüm kanalları yenile

Otomatik olarak her `WA_CHANNEL_REFRESH_MIN` dakikada da çalışır.

### `POST /channels/post` — Kanala post yap

> Yalnızca `role: "admin"` veya `role: "owner"` olan kanallarda çalışır.

```json
{ "jid": "120363430826890742@newsletter", "text": "Yeni yayın başladı!" }
```

Resim ile:
```json
{
  "jid": "120363430826890742@newsletter",
  "text": "Açıklama",
  "imageUrl": "https://example.com/kapak.jpg"
}
```

### `POST /send` — Kullanıcıya direkt mesaj gönder
```json
// Request
{ "jid": "905551234567@s.whatsapp.net", "text": "Doğrulama kodunuz: 1234" }

// Response
{ "ok": true }
```

---

## Gelen aramaları reddetme

Gelen sesli aramalar otomatik olarak reddedilir ve arayana `WA_CALL_REJECT_MSG` içeriği gönderilir.

---

## Ortam değişkenleri

| Değişken                | Varsayılan                                    | Açıklama                                           |
|-------------------------|-----------------------------------------------|----------------------------------------------------|
| `WA_API_KEY`            | _(boş)_                                       | Bearer token; boşsa auth devre dışı                |
| `WA_HOST_PORT`          | `3000`                                        | Host'a bağlanan port                               |
| `WA_MAX_RETRIES`        | `10`                                          | Yeniden bağlanma denemesi                          |
| `WA_CHANNEL_REFRESH_MIN`| `30`                                          | Kanal istatistik yenileme aralığı (dakika)         |
| `WA_CALL_REJECT_MSG`    | _(varsayılan Türkçe mesaj)_                   | Gelen aramalarda gönderilecek otomatik yanıt       |
| `LOG_LEVEL`             | `info`                                        | `trace / debug / info / warn / error`              |

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
