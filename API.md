# WhatsApp Bridge — API Dokümantasyonu

**Sunucu:** `http://<SUNUCU_IP>:3000`
**Versiyon:** Baileys 6.7.23 · Node.js 20
**Son Güncelleme:** 2026-06-26

---

## Kimlik Doğrulama

`GET /status` hariç tüm endpoint'ler API key gerektirir.
İki yöntemden biri kullanılabilir:

```http
Authorization: Bearer <WA_API_KEY>
```
```http
X-Api-Key: <WA_API_KEY>
```

Hatalı veya eksik key → `401 Unauthorized`
```json
{ "error": "Yetkisiz erişim" }
```

---

## Endpoint'ler

### 1. Sistem Durumu

```http
GET /status
```
Auth gerektirmez.

**Yanıt:**
```json
{
  "ok": true,
  "connected": true,
  "channels": 1
}
```

| Alan | Açıklama |
|------|----------|
| `connected` | WhatsApp bağlantısı açık mı |
| `channels` | Takip edilen kanal sayısı |

---

### 2. Kanal Listesi

```http
GET /channels
Authorization: Bearer <WA_API_KEY>
```

**Yanıt:**
```json
{
  "ok": true,
  "channels": [
    {
      "jid": "120363430826890742@newsletter",
      "name": "Kanal Adı",
      "description": "Kanal açıklaması...",
      "subscriberCount": 100,
      "role": "admin",
      "picture": "/m1/v/t24/...",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "lastUpdated": "2026-06-26T10:00:00.000Z"
    }
  ]
}
```

| Alan | Açıklama |
|------|----------|
| `jid` | Kanalın WhatsApp ID'si (`@newsletter` ile biter) |
| `role` | Hesabın kanaldaki rolü: `owner` / `admin` / `subscriber` |
| `subscriberCount` | Güncel takipçi sayısı |
| `picture` | Profil resmi CDN path'i |

---

### 3. Kanala Katıl

```http
POST /channels/follow
Authorization: Bearer <WA_API_KEY>
Content-Type: application/json
```

**Seçenek A — Public invite URL ile:**
```json
{
  "invite": "https://whatsapp.com/channel/0029VbCDO4pEKyZQKQqzl13B"
}
```

**Seçenek B — JID ile (zaten bilinen kanal):**
```json
{
  "jid": "120363430826890742@newsletter"
}
```

**Yanıt:**
```json
{
  "ok": true,
  "channel": {
    "jid": "120363430826890742@newsletter",
    "name": "Kanal Adı",
    "description": "...",
    "subscriberCount": 100,
    "role": "admin",
    "picture": "...",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "lastUpdated": "2026-06-26T10:00:00.000Z"
  }
}
```

> **Not:** Zaten takip edilen bir kanal gönderilirse hata vermez, güncel bilgilerini döner.

---

### 4. Kanalı Bırak

```http
POST /channels/unfollow
Authorization: Bearer <WA_API_KEY>
Content-Type: application/json
```

```json
{
  "jid": "120363430826890742@newsletter"
}
```

**Yanıt:**
```json
{ "ok": true }
```

---

### 5. Kanal İstatistikleri

Tek bir kanalın güncel bilgilerini WhatsApp'tan çeker.

```http
GET /channels/stats?jid=120363430826890742%40newsletter
Authorization: Bearer <WA_API_KEY>
```

> `@` işaretini URL encode edin: `@` → `%40`

**Yanıt:**
```json
{
  "ok": true,
  "channel": {
    "jid": "120363430826890742@newsletter",
    "name": "Kanal Adı",
    "subscriberCount": 100,
    "role": "admin",
    "lastUpdated": "2026-06-26T10:00:00.000Z"
  }
}
```

---

### 6. Tüm Kanalları Yenile

Takip edilen tüm kanalların istatistiklerini WhatsApp'tan günceller.
(Otomatik olarak her `WA_CHANNEL_REFRESH_MIN` dakikada da çalışır, varsayılan: 30 dk.)

```http
POST /channels/refresh
Authorization: Bearer <WA_API_KEY>
```

**Yanıt:**
```json
{
  "ok": true,
  "channels": [ { "..." }, { "..." } ]
}
```

---

### 7. Kanala Post Yap

> ⚠️ Yalnızca `role: "admin"` veya `role: "owner"` olan kanallarda çalışır.

```http
POST /channels/post
Authorization: Bearer <WA_API_KEY>
Content-Type: application/json
```

**Sadece metin:**
```json
{
  "jid": "120363430826890742@newsletter",
  "text": "📻 Yeni yayın başladı!"
}
```

**Resim URL ile:**
```json
{
  "jid": "120363430826890742@newsletter",
  "text": "Yeni albüm çıktı!",
  "imageUrl": "https://example.com/kapak.jpg"
}
```

**Base64 resim ile:**
```json
{
  "jid": "120363430826890742@newsletter",
  "text": "Açıklama metni",
  "imageBase64": "data:image/jpeg;base64,/9j/4AAQ..."
}
```

**Başarılı yanıt:**
```json
{
  "ok": true,
  "messageId": "3EB0A1B2C3D4E5F6"
}
```

**Yetki yoksa:**
```json
{
  "error": "Bu kanalda post yapma yetkiniz yok. Rol: subscriber"
}
```

---

### 8. Kullanıcıya Direkt Mesaj Gönder

```http
POST /send
Authorization: Bearer <WA_API_KEY>
Content-Type: application/json
```

```json
{
  "jid": "905551234567@s.whatsapp.net",
  "text": "Merhaba, size yardımcı olabiliriz."
}
```

**Yanıt:**
```json
{ "ok": true }
```

> **JID formatı:** `<ülke kodu + numara>@s.whatsapp.net`
> Örnek: `905551234567@s.whatsapp.net` (başında `0` olmadan)

---

## Hata Kodları

| HTTP | Açıklama |
|------|----------|
| `400` | Eksik veya hatalı parametre |
| `401` | API key hatalı veya eksik |
| `403` | İşlem için yetkiniz yok (admin gerektiren post vb.) |
| `500` | WhatsApp veya Baileys hatası |
| `503` | WhatsApp bağlantısı yok |

---

## Ortam Değişkenleri (.env)

| Değişken | Varsayılan | Açıklama |
|----------|------------|----------|
| `WA_API_KEY` | _(boş)_ | Bridge REST API anahtarı; boşsa auth devre dışı |
| `WA_HOST_PORT` | `3000` | Host'a bağlanan port |
| `WA_MAX_RETRIES` | `10` | Yeniden bağlanma denemesi |
| `WA_CHANNEL_REFRESH_MIN` | `30` | Kanal istatistik yenileme aralığı (dakika) |
| `WA_CALL_REJECT_MSG` | _(varsayılan Türkçe mesaj)_ | Gelen aramalarda gönderilecek otomatik yanıt |
| `LOG_LEVEL` | `info` | `trace / debug / info / warn / error` |

---

## Örnek: cURL ile Hızlı Test

```bash
BASE="http://<SUNUCU_IP>:3000"
KEY="<WA_API_KEY>"

# Durum
curl "$BASE/status"

# Kanal listesi
curl -H "Authorization: Bearer $KEY" "$BASE/channels"

# Kanal takip et
curl -X POST "$BASE/channels/follow" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"invite": "https://whatsapp.com/channel/XXX"}'

# Kanala post yap
curl -X POST "$BASE/channels/post" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"jid":"120363430826890742@newsletter","text":"Merhaba dünya!"}'

# Kanal istatistiklerini güncelle
curl -H "Authorization: Bearer $KEY" \
  "$BASE/channels/stats?jid=120363430826890742%40newsletter"

# Direkt mesaj gönder
curl -X POST "$BASE/send" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"jid":"905551234567@s.whatsapp.net","text":"Test mesajı"}'
```

---

## Notlar

- **Kanal takibi:** Telefon uygulamasından yapılan takipler de otomatik olarak algılanır ve kaydedilir.
- **Kanal verisi:** `/data/auth/channels.json` dosyasında kalıcı olarak saklanır, container yeniden başlasa bile kaybolmaz.
- **Resim boyutu:** `imageBase64` ile gönderimde maksimum `20MB` desteklenir.
- **Post yetkisi:** Yalnızca `admin` veya `owner` rolüne sahip olunan kanallara post atılabilir.
- **Sesli aramalar:** Gelen tüm sesli aramalar otomatik reddedilir ve arayana `WA_CALL_REJECT_MSG` gönderilir.
