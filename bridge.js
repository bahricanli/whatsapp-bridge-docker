'use strict'

const {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys')
const axios   = require('axios')
const qrcode  = require('qrcode-terminal')
const fs      = require('fs')
const path    = require('path')

const WA_API_KEY          = process.env.WA_API_KEY             || ''
const PORT                = process.env.WA_PORT                || 3000
const CHANNEL_REFRESH_MIN = parseInt(process.env.WA_CHANNEL_REFRESH_MIN || '30')

// Sesli arama geldiğinde gönderilecek mesaj
const CALL_REJECT_MSG = process.env.WA_CALL_REJECT_MSG ||
    'Sesli aramalarımızı şu an yanıtlayamıyoruz. ' +
    'Sorunuzu yazılı olarak yazabilir veya 🎤 ses notu bırakabilirsiniz, size yardımcı olalım.'

const express = require('express')
const app     = express()
app.use(require('express').json({ limit: '20mb' }))

// ── API Key doğrulama middleware ──────────────────────────────────────────────
function requireApiKey(req, res, next) {
    if (!WA_API_KEY) return next()
    const auth  = req.headers['authorization'] || ''
    const key   = req.headers['x-api-key'] || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : key
    if (token !== WA_API_KEY) {
        return res.status(401).json({ error: 'Yetkisiz erişim' })
    }
    next()
}

let sock = null

// ═══════════════════════════════════════════════════════════════════════════════
// ── Kanal (Newsletter/Channel) yönetimi ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const CHANNELS_FILE = '/data/auth/channels.json'

function loadChannels() {
    try {
        if (fs.existsSync(CHANNELS_FILE)) {
            return JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'))
        }
    } catch (e) {
        console.error('[CHANNEL] Veri okunamadı:', e.message)
    }
    return {}
}

function saveChannels(data) {
    try {
        fs.mkdirSync(path.dirname(CHANNELS_FILE), { recursive: true })
        fs.writeFileSync(CHANNELS_FILE, JSON.stringify(data, null, 2))
    } catch (e) {
        console.error('[CHANNEL] Veri yazılamadı:', e.message)
    }
}

// Invite URL'den invite kodunu çıkar
// https://whatsapp.com/channel/XXXXX veya sadece XXXXX
function extractInviteCode(input) {
    if (!input) return null
    const m = input.match(/channel\/([A-Za-z0-9]+)/)
    if (m) return m[1]
    if (/^[A-Za-z0-9]{20,}$/.test(input)) return input
    return null
}

// WA ham bildirim verisinden kanal bilgisini çıkar
function parseNewsletterNotification(raw) {
    try {
        const buf  = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
        const obj  = JSON.parse(buf.toString('utf8'))
        const data = obj?.data?.xwa2_notify_newsletter_on_join
                  || obj?.data?.xwa2_notify_newsletter_on_update
                  || null
        if (!data) return null
        const tm = data.thread_metadata || {}
        return {
            jid:             data.id,
            name:            tm.name?.text        || '',
            description:     tm.description?.text || '',
            subscriberCount: parseInt(tm.subscribers_count || tm.followers_count || '0', 10),
            role:            data.viewer_metadata?.role?.toLowerCase() || 'subscriber',
            picture:         null,
            lastUpdated:     new Date().toISOString(),
        }
    } catch (_) { return null }
}

// Kanal meta verisini Baileys'ten çek ve kaydet
async function refreshChannelInfo(jid) {
    if (!sock) throw new Error('WhatsApp bağlantısı yok')
    try {
        const meta = await sock.newsletterMetadata('jid', jid)
        const channels = loadChannels()
        const prev = channels[jid] || {}

        // Baileys 6.7.23: ham WA formatı döner — thread_metadata / viewer_metadata altında
        const tm = meta.thread_metadata || {}
        const vm = meta.viewer_metadata || {}

        channels[jid] = {
            jid:             meta.id || jid,
            name:            tm.name?.text           || prev.name            || '',
            description:     tm.description?.text    || prev.description     || '',
            subscriberCount: parseInt(tm.subscribers_count || tm.followers_count || prev.subscriberCount || 0, 10),
            role:            (vm.role                || prev.role            || 'subscriber').toLowerCase(),
            picture:         tm.picture?.direct_path || prev.picture         || null,
            createdAt:       tm.creation_time
                             ? new Date(parseInt(tm.creation_time, 10) * 1000).toISOString()
                             : prev.createdAt || null,
            lastUpdated:     new Date().toISOString(),
        }
        saveChannels(channels)
        console.log(`[CHANNEL] Güncellendi: ${channels[jid].name} (${jid}) — ${channels[jid].subscriberCount} takipçi`)
        return channels[jid]
    } catch (e) {
        console.error(`[CHANNEL] Meta alınamadı ${jid}:`, e.message)
        const channels = loadChannels()
        if (channels[jid]) return channels[jid]
        throw e
    }
}

// Tüm takip edilen kanalların istatistiklerini yenile
async function refreshAllChannels() {
    if (!sock) return
    const channels = loadChannels()
    const jids = Object.keys(channels)
    if (jids.length === 0) return
    console.log(`[CHANNEL] ${jids.length} kanal yenileniyor...`)
    for (const jid of jids) {
        try { await refreshChannelInfo(jid) } catch (_) {}
    }
}

// ── Kanal REST API ────────────────────────────────────────────────────────────

// GET /channels — Takip edilen kanalları listele
app.get('/channels', requireApiKey, (req, res) => {
    const channels = loadChannels()
    res.json({ ok: true, channels: Object.values(channels) })
})

// POST /channels/follow — Bir kanala katıl
// Body: { jid: "xxx@newsletter" }  veya  { invite: "https://whatsapp.com/channel/XXX" }
app.post('/channels/follow', requireApiKey, async (req, res) => {
    if (!sock) return res.status(503).json({ error: 'WhatsApp bağlantısı yok' })

    const { jid, invite } = req.body

    try {
        let channelJid = jid

        if (!channelJid && invite) {
            const code = extractInviteCode(invite)
            if (!code) return res.status(400).json({ error: 'Geçersiz invite linki' })

            const meta = await sock.newsletterMetadata('invite', code)
            const tm   = meta.thread_metadata || {}
            const vm   = meta.viewer_metadata || {}
            channelJid = meta.id

            const channels = loadChannels()
            channels[channelJid] = {
                jid:             channelJid,
                name:            tm.name?.text          || '',
                description:     tm.description?.text   || '',
                subscriberCount: parseInt(tm.subscribers_count || tm.followers_count || 0, 10),
                role:            (vm.role || 'subscriber').toLowerCase(),
                picture:         tm.picture?.direct_path || null,
                lastUpdated:     new Date().toISOString(),
            }
            saveChannels(channels)
        }

        if (!channelJid) return res.status(400).json({ error: 'jid veya invite gerekli' })
        if (!channelJid.endsWith('@newsletter')) {
            return res.status(400).json({ error: 'JID @newsletter ile bitmeli' })
        }

        try {
            await sock.newsletterFollow(channelJid)
            console.log(`[CHANNEL] Takip edildi: ${channelJid}`)
        } catch (e) {
            // Baileys 6.7.23: WA sunucusu yeni format döndürdüğünde parse edemez ama
            // takip işlemi yine de gerçekleşir. Hatayı yutup metadata ile doğruluyoruz.
            if (e.message?.includes('unexpected response')) {
                console.warn(`[CHANNEL] newsletterFollow parse uyarısı (follow gerçekleşti): ${channelJid}`)
            } else {
                throw e
            }
        }

        const info = await refreshChannelInfo(channelJid)
        res.json({ ok: true, channel: info })

    } catch (e) {
        console.error('[CHANNEL] Takip hatası:', e.message)
        res.status(500).json({ error: e.message })
    }
})

// POST /channels/unfollow — Kanalı bırak
// Body: { jid: "xxx@newsletter" }
app.post('/channels/unfollow', requireApiKey, async (req, res) => {
    if (!sock) return res.status(503).json({ error: 'WhatsApp bağlantısı yok' })

    const { jid } = req.body
    if (!jid) return res.status(400).json({ error: 'jid gerekli' })

    try {
        await sock.newsletterUnfollow(jid)

        const channels = loadChannels()
        delete channels[jid]
        saveChannels(channels)

        console.log(`[CHANNEL] Takipten çıkıldı: ${jid}`)
        res.json({ ok: true })
    } catch (e) {
        console.error('[CHANNEL] Takipten çıkma hatası:', e.message)
        res.status(500).json({ error: e.message })
    }
})

// GET /channels/stats?jid=... — Tek kanalın güncel istatistikleri
app.get('/channels/stats', requireApiKey, async (req, res) => {
    if (!sock) return res.status(503).json({ error: 'WhatsApp bağlantısı yok' })

    const { jid } = req.query
    if (!jid) return res.status(400).json({ error: 'jid query param gerekli' })

    try {
        const info = await refreshChannelInfo(jid)
        res.json({ ok: true, channel: info })
    } catch (e) {
        res.status(500).json({ error: e.message })
    }
})

// POST /channels/refresh — Tüm kanalları yenile
app.post('/channels/refresh', requireApiKey, async (req, res) => {
    if (!sock) return res.status(503).json({ error: 'WhatsApp bağlantısı yok' })
    try {
        await refreshAllChannels()
        const channels = loadChannels()
        res.json({ ok: true, channels: Object.values(channels) })
    } catch (e) {
        res.status(500).json({ error: e.message })
    }
})

// POST /channels/post — Kanala post yap (sadece admin/owner)
// Body:
//   { jid: "xxx@newsletter", text: "Mesaj" }
//   { jid: "xxx@newsletter", text: "Caption", imageUrl: "https://..." }
//   { jid: "xxx@newsletter", text: "Caption", imageBase64: "data:image/jpeg;base64,..." }
app.post('/channels/post', requireApiKey, async (req, res) => {
    if (!sock) return res.status(503).json({ error: 'WhatsApp bağlantısı yok' })

    const { jid, text, imageUrl, imageBase64 } = req.body
    if (!jid) return res.status(400).json({ error: 'jid gerekli' })
    if (!text && !imageUrl && !imageBase64) {
        return res.status(400).json({ error: 'text veya resim gerekli' })
    }

    const channels = loadChannels()
    const channel  = channels[jid]
    if (channel && channel.role !== 'owner' && channel.role !== 'admin') {
        return res.status(403).json({
            error: 'Bu kanalda post yapma yetkiniz yok. Rol: ' + (channel.role || 'bilinmiyor')
        })
    }

    try {
        let msgContent

        if (imageBase64 || imageUrl) {
            let imageBuffer

            if (imageBase64) {
                const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '')
                imageBuffer = Buffer.from(base64Data, 'base64')
            } else {
                const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 })
                imageBuffer = Buffer.from(response.data)
            }

            msgContent = { image: imageBuffer, caption: text || '' }
        } else {
            msgContent = { text }
        }

        const result = await sock.sendMessage(jid, msgContent)
        console.log(`[CHANNEL] Post gönderildi → ${jid} | ${text?.substring(0, 60) || '[resim]'}`)
        res.json({ ok: true, messageId: result?.key?.id })

    } catch (e) {
        console.error('[CHANNEL] Post hatası:', e.message)
        res.status(500).json({ error: e.message })
    }
})

// ── WhatsApp bağlantısı ───────────────────────────────────────────────────────
async function startBridge() {
    const { state, saveCreds } = await useMultiFileAuthState('/data/auth')
    const { version } = await fetchLatestBaileysVersion()

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('\n[QR] WhatsApp > Bağlı Cihazlar > Cihaz Ekle:\n')
            qrcode.generate(qr, { small: true })
        }
        if (connection === 'close') {
            const code  = lastDisconnect?.error?.output?.statusCode
            const retry = code !== DisconnectReason.loggedOut
            console.log('[!] Bağlantı koptu, retry:', retry)
            if (retry) startBridge()
        } else if (connection === 'open') {
            console.log('[✓] WhatsApp bağlandı!')
            setTimeout(refreshAllChannels, 5000)
        }
    })

    // ── Newsletter (Kanal) ham bildirimleri — telefon uygulamasından join/update ──
    sock.ws.on('CB:notification,,mex', async (node) => {
        try {
            const content = node?.content?.[0]?.content
            if (!content) return
            const parsed = parseNewsletterNotification(content)
            if (!parsed?.jid) return

            const channels = loadChannels()
            const prev = channels[parsed.jid] || {}
            channels[parsed.jid] = { ...prev, ...parsed }
            saveChannels(channels)
            console.log(`[CHANNEL] Bildirim ile güncellendi: ${parsed.name} (${parsed.jid}) — rol: ${parsed.role}`)
        } catch (_) {}
    })

    // ── Sesli arama: otomatik reddet + mesaj gönder ──────────────────────────
    sock.ev.on('call', async (calls) => {
        for (const call of calls) {
            if (call.status === 'offer') {
                console.log(`[CALL] Gelen sesli arama reddedildi: ${call.from}`)
                try {
                    await sock.rejectCall(call.id, call.from)
                    setTimeout(async () => {
                        try {
                            await sock.sendMessage(call.from, { text: CALL_REJECT_MSG })
                        } catch (e) {
                            console.error('[CALL] Reddet mesajı gönderilemedi:', e.message)
                        }
                    }, 1000)
                } catch (e) {
                    console.error('[CALL] Reddetme hatası:', e.message)
                }
            }
        }
    })

    // ── REST: Manuel mesaj gönderme ──────────────────────────────────────────
    app.post('/send', requireApiKey, async (req, res) => {
        const { jid, text } = req.body
        if (!jid || !text) return res.status(400).json({ error: 'jid ve text gerekli' })
        try {
            await sock.sendMessage(jid, { text })
            res.json({ ok: true })
        } catch (e) {
            res.status(500).json({ error: e.message })
        }
    })

    app.get('/status', (req, res) => {
        const channels = loadChannels()
        res.json({
            ok: true,
            connected: !!sock,
            channels:  Object.keys(channels).length,
        })
    })
}

// ── Periyodik kanal istatistik yenileme ──────────────────────────────────────
setInterval(refreshAllChannels, CHANNEL_REFRESH_MIN * 60 * 1000)

startBridge()
app.listen(PORT, () => console.log(
    `[✓] Bridge ${PORT} portunda başladı | kanal_yenileme=${CHANNEL_REFRESH_MIN}dk`
))
