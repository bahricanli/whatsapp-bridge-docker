# WhatsApp Bridge — API Dokümantasyonu

**Sunucu:** `http://192.168.0.125:3000`
**Versiyon:** Baileys 6.7.23 · Node.js 20
**Son Güncelleme:** 2026-06-19

---

## Kimlik Doğrulama

Tüm endpoint'ler (`/status` hariç) API key gerektirir.
İki yöntemden biri kullanılabilir:

```http
Authorization: Bearer Yy+JywTPJ3uM0htkbGD8uLkSPUm4+fzqj/pDLVqv8Rs=
```
```http
X-Api-Key: Yy+JywTPJ3uM0htkbGD8uLkSPUm4+fzqj/pDLVqv8Rs=
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
  "sessions": 2,
  "channels": 1
}
```

| Alan | Açıklama |
|------|----------|
| `connected` | WhatsApp bağlantısı açık mı |
| `sessions` | Aktif kullanıcı oturumu sayısı |
| `channels` | Takip edilen kanal sayısı |

---

### 2. Kanal Listesi

```http
GET /channels
Authorization: Bearer <key>
```

**Yanıt:**
```json
{
  "ok": true,
  "channels": [
    {
      "jid": "120363430826890742@newsletter",
      "name": "Radyo C",
      "description": "🎵 Radyo C Resmî WhatsApp Kanalı...",
      "subscriberCount": 3,
      "role": "admin",
      "picture": "/m1/v/t24/...",
      "createdAt": "2026-06-18T19:51:29.000Z",
      "lastUpdated": "2026-06-19T07:07:18.682Z"
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
Authorization: Bearer <key>
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
    "name": "Radyo C",
    "description": "...",
    "subscriberCount": 3,
    "role": "admin",
    "picture": "...",
    "createdAt": "2026-06-18T19:51:29.000Z",
    "lastUpdated": "2026-06-19T07:07:18.682Z"
  }
}
```

> **Not:** Zaten takip edilen bir kanal gönderilirse hata vermez, güncel bilgilerini döner.

---

### 4. Kanalı Bırak

```http
POST /channels/unfollow
Authorization: Bearer <key>
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
Authorization: Bearer <key>
```

> `@` işaretini URL encode edin: `@` → `%40`

**Yanıt:**
```json
{
  "ok": true,
  "channel": {
    "jid": "120363430826890742@newsletter",
    "name": "Radyo C",
    "subscriberCount": 3,
    "role": "admin",
    "lastUpdated": "2026-06-19T07:07:18.682Z"
  }
}
```

---

### 6. Tüm Kanalları Yenile

Takip edilen tüm kanalların istatistiklerini WhatsApp'tan günceller.
(Otomatik olarak her 30 dakikada da çalışır.)

```http
POST /channels/refresh
Authorization: Bearer <key>
```

**Yanıt:**
```json
{
  "ok": true,
  "channels": [ { ... }, { ... } ]
}
```

---

### 7. Kanala Post Yap

> ⚠️ Yalnızca `role: "admin"` veya `role: "owner"` olan kanallarda çalışır.

```http
POST /channels/post
Authorization: Bearer <key>
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
Authorization: Bearer <key>
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

| Değişken | Değer | Açıklama |
|----------|-------|----------|
| `WA_API_KEY` | `Yy+JywTPJ3uM0htkbGD8uLkSPUm4+fzqj/pDLVqv8Rs=` | Bridge REST API anahtarı |
| `API_KEY` | `762951d48834274c2327de20325af37f` | Genel servis anahtarı (TBot vb.) |
| `WA_PORT` | `3000` | Bridge dinleme portu |
| `WA_CHANNEL_REFRESH_MIN` | `30` | Kanal istatistik yenileme aralığı (dakika) |
| `WA_SESSION_TTL_MIN` | `30` | Kullanıcı oturum süresi (dakika) |
| `TBOT_URL` | `http://192.168.0.125:8080` | SIP-AI TBot adresi |
| `WHISPER_URL` | `http://172.30.0.20:9000` | Whisper STT adresi |
| `OLLAMA_MODEL` | `llama3.1:8b` | Kullanılan LLM modeli |
| `WHISPER_MODEL` | `turbo` | Whisper model boyutu |
| `WHISPER_DEVICE` | `cuda` | GPU/CPU modu |
| `TTS_VOICE` | `tr-TR-EmelNeural` | Türkçe ses sentezi sesi |
| `SIP_DOMAIN` | `192.168.0.35` | FreePBX IP adresi |
| `EXTERNAL_IP` | `192.168.0.125` | Bu sunucunun IP adresi |
| `API_PORT` | `8080` | SIP-AI REST API portu |
| `CALLER_API_URL` | `https://api.tarti.com/get-user-from-phone` | Arayan müşteri bilgisi API |
| `SUPPORT_API_URL` | `https://api.tarti.com/create-support-from-phone` | Destek kaydı oluşturma API |
| `RAG_ENABLED` | `true` | Bilgi tabanı arama aktif |
| `TRANSFER_EXT` | `100` | Temsilciye transfer dahili numarası |

---

## Örnek: cURL ile Hızlı Test

```bash
BASE="http://192.168.0.125:3000"
KEY="Yy+JywTPJ3uM0htkbGD8uLkSPUm4+fzqj/pDLVqv8Rs="

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

# Takipçi sayısını güncelle
curl -H "Authorization: Bearer $KEY" \
  "$BASE/channels/stats?jid=120363430826890742%40newsletter"
```

---

## Notlar

- **Kanal takibi:** Telefon uygulamasından yapılan takipler de otomatik olarak algılanır ve kaydedilir.
- **Kanal verisi:** `/data/auth/channels.json` dosyasında kalıcı olarak saklanır, container yeniden başlasa bile kaybolmaz.
- **Resim boyutu:** `imageBase64` ile gönderimde maksimum `20MB` desteklenir.
- **Post yetkisi:** Yalnızca `admin` veya `owner` rolüne sahip olunan kanallara post atılabilir.
