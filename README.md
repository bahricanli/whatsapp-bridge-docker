# WhatsApp Bridge

Baileys tabanlı, Docker üzerinde çalışan standalone WhatsApp REST API servisi.

📖 **Tam API referansı için → [API.md](./API.md)**

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

## Endpoint'ler

| Method | Path | Açıklama | Auth |
|--------|------|----------|------|
| `GET` | `/status` | Bağlantı durumu | ✗ |
| `GET` | `/channels` | Takip edilen kanalları listele | ✓ |
| `POST` | `/channels/follow` | Kanala katıl | ✓ |
| `POST` | `/channels/unfollow` | Kanalı bırak | ✓ |
| `GET` | `/channels/stats` | Tek kanal istatistiği | ✓ |
| `POST` | `/channels/refresh` | Tüm kanalları yenile | ✓ |
| `POST` | `/channels/post` | Kanala post yap (admin/owner) | ✓ |
| `POST` | `/send` | Kullanıcıya direkt mesaj gönder | ✓ |

Tüm isteklerde `Authorization: Bearer <WA_API_KEY>` veya `X-Api-Key: <WA_API_KEY>` header'ı gerekir.

Detaylı açıklamalar, istek/yanıt örnekleri ve hata kodları için → **[API.md](./API.md)**

---

## Temel ortam değişkenleri

| Değişken | Varsayılan | Açıklama |
|----------|------------|----------|
| `WA_API_KEY` | _(boş)_ | Bearer token; boşsa auth devre dışı |
| `WA_HOST_PORT` | `3000` | Host'a bağlanan port |
| `WA_CHANNEL_REFRESH_MIN` | `30` | Kanal yenileme aralığı (dakika) |
| `WA_CALL_REJECT_MSG` | _(varsayılan Türkçe mesaj)_ | Gelen aramalarda otomatik yanıt |

Tüm değişkenler için → **[API.md — Ortam Değişkenleri](./API.md#ortam-değişkenleri-env)**

---

## Nginx reverse proxy (önerilen)

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
