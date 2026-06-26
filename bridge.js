const {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadMediaMessage,
} = require('@whiskeysockets/baileys')
const axios   = require('axios')
const qrcode  = require('qrcode-terminal')
const fs      = require('fs')
const path    = require('path')
const { execSync } = require('child_process')
const os      = require('os')

const TBOT_URL         = process.env.TBOT_URL          || 'http://sip-ai:8080'
const WHISPER_URL      = process.env.WHISPER_URL        || 'http://172.30.0.20:9000'
const TBOT_KEY         = process.env.TBOT_KEY           || ''
const WA_API_KEY       = process.env.WA_API_KEY         || ''
const PORT             = process.env.WA_PORT            || 3000
const SESSION_TTL_MS   = parseInt(process.env.WA_SESSION_TTL_MIN || '30') * 60 * 1000
const CHANNEL_REFRESH_MIN = parseInt(process.env.WA_CHANNEL_REFRESH_MIN || '30')

// Sesli arama geldiğinde gönderilecek mesaj
const CALL_REJECT_MSG  = process.env.WA_CALL_REJECT_MSG ||
    'Sesli aramalarımızı şu an yanıtlayamıyoruz. ' +
    'Sorunuzu yazılı olarak yazabilir veya 🎤 ses notu bırakabilirsiniz, size yardımcı olalım.'

const express = require('express')
const app     = express()
app.use(require('express').json({ limit: '20mb' }))

// ── API Key doğrulama middleware ──────────────────────────────────────────────
function requireApiKey(req, res, next) {
    if (!WA_API_KEY) return next()  // Key tanımlı değilse serbest
    const auth = req.headers['authorization'] || ''
    const key  = req.headers['x-api-key'] || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : key
    if (token !== WA_API_KEY) {
        return res.status(401).json({ error: 'Yetkisiz erişim' })
    }
    next()
}

let sock = null

const HEADERS = { 'Authorization': `Bearer ${TBOT_KEY}` }

// ── Oturum yönetimi: jid → { thread_id, lastActivity } ───────────────────────
const sessions = new Map()

async function createThread() {
    const t = await axios.post(`${TBOT_URL}/v1/threads`, {}, { headers: HEADERS })
    return t.data.id
}

async function getOrCreateSession(jid) {
    const now = Date.now()
    const existing = sessions.get(jid)
    if (existing && (now - existing.lastActivity) < SESSION_TTL_MS) {
        existing.lastActivity = now
        return existing
    }
    const thread_id = await createThread()
    const session = { thread_id, lastActivity: now }
    sessions.set(jid, session)
    console.log(`[SESSION] Yeni oturum: ${jid} → ${thread_id}`)
    return session
}

// ── Metin → TBot ──────────────────────────────────────────────────────────────
async function askTBot(text, jid) {
    const session = await getOrCreateSession(jid)
    const { thread_id } = session

    await axios.post(`${TBOT_URL}/v1/threads/${thread_id}/messages`,
        { role: 'user', content: text }, { headers: HEADERS })

    await axios.post(`${TBOT_URL}/v1/threads/${thread_id}/runs`,
        { assistant_id: 'default' }, { headers: HEADERS })

    const msgs = await axios.get(
        `${TBOT_URL}/v1/threads/${thread_id}/messages`, { headers: HEADERS })
    const data = msgs.data.data || []
    const assistantMsgs = data.filter(m => m.role === 'assistant')
    if (assistantMsgs.length > 0) {
        return assistantMsgs[0].content[0].text.value
    }
    return 'Cevap alınamadı.'
}

// ── Ses notu: OGG/OPUS → WAV → Whisper → metin ───────────────────────────────
async function audioToText(audioBuffer, mimetype) {
    const tmpDir  = os.tmpdir()
    const ext     = mimetype?.includes('ogg') ? '.ogg' : '.opus'
    const inFile  = path.join(tmpDir, `wa_audio_${Date.now()}${ext}`)
    const wavFile = path.join(tmpDir, `wa_audio_${Date.now()}.wav`)

    try {
        fs.writeFileSync(inFile, audioBuffer)

        execSync(
            `ffmpeg -y -i "${inFile}" -ar 16000 -ac 1 -acodec pcm_s16le "${wavFile}"`,
            { stdio: 'pipe', timeout: 30000 }
        )

        const FormData = require('form-data')
        const form = new FormData()
        form.append('audio_file', fs.createReadStream(wavFile), {
            filename: 'audio.wav',
            contentType: 'audio/wav',
        })
        form.append('task', 'transcribe')
        form.append('language', 'tr')

        const r = await axios.post(`${WHISPER_URL}/asr`, form, {
            headers: form.getHeaders(),
            timeout: 60000,
        })

        const text = r.data?.text?.trim() || ''
        console.log(`[STT] Ses notu → "${text.substring(0, 80)}"`)
        return text

    } catch (e) {
        console.error('[STT] Ses notu transkripsiyon hatası:', e.message)
        return ''
    } finally {
        try { fs.unlinkSync(inFile)  } catch (_) {}
        try { fs.unlinkSync(wavFile) } catch (_) {}
    }
}

// ── Ana mesaj işleyici ────────────────────────────────────────────────────────
async function handleMessage(msg) {
    const jid = msg.key.remoteJid
    const content = msg.message

    // ── 1. Metin mesajı ──────────────────────────────────────────────────────
    const text = content?.conversation || content?.extendedTextMessage?.text || ''
    if (text) {
        console.log(`[MSG] ${jid}: ${text}`)
        const cevap = await askTBot(text, jid)
        await sock.sendMessage(jid, { text: cevap })
        console.log(`[BOT] → ${cevap.substring(0, 80)}`)
        return
    }

    // ── 2. Ses notu (PTT) veya ses mesajı ───────────────────────────────────
    const audioMsg = content?.audioMessage
    if (audioMsg) {
        const isPtt = audioMsg.ptt === true
        const label = isPtt ? 'Ses notu' : 'Ses dosyası'
        console.log(`[AUDIO] ${jid}: ${label} alındı (${audioMsg.seconds || '?'}s)`)

        await sock.sendPresenceUpdate('recording', jid)

        try {
            const buffer = await downloadMediaMessage(
                msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage }
            )

            const transcription = await audioToText(buffer, audioMsg.mimetype || 'audio/ogg')

            if (!transcription) {
                await sock.sendMessage(jid, {
                    text: 'Ses notunuzu anlayamadım, lütfen tekrar deneyin veya yazılı olarak sorunuzu iletebilirsiniz.'
                })
                return
            }

            await sock.sendMessage(jid, {
                text: `🎤 _"${transcription}"_\n\nYanıtlanıyor...`
            })

            const cevap = await askTBot(transcription, jid)
            await sock.sendMessage(jid, { text: cevap })
            console.log(`[BOT] Ses notu yanıtı → ${cevap.substring(0, 80)}`)

        } catch (e) {
            console.error('[AUDIO] İşleme hatası:', e.message)
            await sock.sendMessage(jid, {
                text: 'Ses notunu işlerken bir sorun oluştu. Lütfen tekrar deneyin.'
            })
        } finally {
            await sock.sendPresenceUpdate('available', jid)
        }
        return
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Kanal (Newsletter/Channel) yönetimi ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const CHANNELS_FILE = '/data/auth/channels.json'  // auth dizini zaten mount'lu, kalıcı

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
    // Doğrudan kod girilmişse
    if (/^[A-Za-z0-9]{20,}$/.test(input)) return input
    return null
}

// WA ham bildirim verisinden kanal bilgisini çıkar (newsletterMetadata yetersiz kalınca)
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
            jid:            data.id,
            name:           tm.name?.text        || '',
            description:    tm.description?.text || '',
            subscriberCount: parseInt(tm.subscribers_count || tm.followers_count || '0', 10),
            role:           data.viewer_metadata?.role?.toLowerCase() || 'subscriber',
            picture:        tm.preview?.direct_path ? null : null, // direct_path CDN, şimdilik null
            lastUpdated:    new Date().toISOString(),
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
            picture:         tm.picture?.direct_path || prev.picture        || null,
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
        // Mevcut kaydı varsa onu döndür, yoksa hata fırlat
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
        try {
            await refreshChannelInfo(jid)
        } catch (_) {}
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
            // Invite URL/kod ile takip et
            const code = extractInviteCode(invite)
            if (!code) return res.status(400).json({ error: 'Geçersiz invite linki' })

            // Invite kodu ile meta veri al → JID öğren
            const meta = await sock.newsletterMetadata('invite', code)
            const tm   = meta.thread_metadata || {}
            const vm   = meta.viewer_metadata || {}
            channelJid = meta.id

            // Önce JID'i kaydet, sonra follow et
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
            // takip işlemi yine de gerçekleşir. "unexpected response structure" hatasını
            // yutup metadata ile doğruluyoruz.
            if (e.message?.includes('unexpected response')) {
                console.warn(`[CHANNEL] newsletterFollow parse uyarısı (follow gerçekleşti): ${channelJid}`)
            } else {
                throw e
            }
        }

        // Meta veriyi çek ve kaydet (takip başarılıysa role güncellenir)
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
    if (!jid)  return res.status(400).json({ error: 'jid gerekli' })
    if (!text && !imageUrl && !imageBase64) {
        return res.status(400).json({ error: 'text veya resim gerekli' })
    }

    // Yetki kontrolü: sadece admin veya owner post yapabilir
    const channels = loadChannels()
    const channel = channels[jid]
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
                // data:image/jpeg;base64,... formatını destekle
                const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '')
                imageBuffer = Buffer.from(base64Data, 'base64')
            } else {
                // URL'den resmi indir
                const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 })
                imageBuffer = Buffer.from(response.data)
            }

            msgContent = {
                image: imageBuffer,
                caption: text || '',
            }
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
            const code = lastDisconnect?.error?.output?.statusCode
            const retry = code !== DisconnectReason.loggedOut
            console.log('[!] Bağlantı koptu, retry:', retry)
            if (retry) startBridge()
        } else if (connection === 'open') {
            console.log('[✓] WhatsApp bağlandı!')

            // Bağlantı açıldıktan 5 sn sonra kanalları yenile
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
        } catch (e) {
            // Ayrıştırılamayan bildirimleri sessizce geç
        }
    })

    // ── Gelen mesajlar ───────────────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return
        for (const msg of messages) {
            if (msg.key.fromMe) continue
            if (msg.key.remoteJid?.endsWith('@g.us')) continue // Grupları yoksay
            if (msg.key.remoteJid?.endsWith('@newsletter')) continue // Kanalları yoksay
            if (!msg.message) continue

            try {
                await handleMessage(msg)
            } catch (e) {
                console.error('[ERR] Mesaj işleme hatası:', e.message)
                try {
                    await sock.sendMessage(msg.key.remoteJid, {
                        text: 'Şu an cevap veremiyorum, lütfen tekrar deneyin.'
                    })
                } catch (_) {}
            }
        }
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
            sessions: sessions.size,
            channels: Object.keys(channels).length,
        })
    })
}

// ── Periyodik kanal istatistik yenileme ──────────────────────────────────────
setInterval(refreshAllChannels, CHANNEL_REFRESH_MIN * 60 * 1000)

startBridge()
app.listen(PORT, () => console.log(
    `[✓] Bridge ${PORT} portunda başladı | ` +
    `session_ttl=${SESSION_TTL_MS / 60000}dk | ` +
    `whisper=${WHISPER_URL} | ` +
    `kanal_yenileme=${CHANNEL_REFRESH_MIN}dk`
))
