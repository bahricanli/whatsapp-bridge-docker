/**
 * WhatsApp Bridge — standalone REST API
 *
 * Endpoints:
 *   POST /send          → { to: "905XXXXXXXXX", text: "..." }
 *   POST /send-bulk     → [{ to, text }, ...]
 *   GET  /status        → { connected, qr_pending, uptime_s }
 *   GET  /qr            → { qr: "data:image/png;base64,..." }   (only while not connected)
 *
 * Auth: Bearer token via Authorization header (set WA_API_KEY env var).
 *       If WA_API_KEY is empty, auth is disabled (not recommended for public exposure).
 */

'use strict'

const {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys')
const qrcode         = require('qrcode')
const qrcodeTerminal = require('qrcode-terminal')
const express        = require('express')
const pino           = require('pino')

// ── Config ────────────────────────────────────────────────────────────────────
const PORT        = parseInt(process.env.WA_PORT    || '3000')
const API_KEY     = process.env.WA_API_KEY          || ''
const AUTH_DIR    = process.env.WA_AUTH_DIR         || '/data/auth'
const LOG_LEVEL   = process.env.LOG_LEVEL           || 'info'
const MAX_RETRIES = parseInt(process.env.WA_MAX_RETRIES || '10')

// ── Logger ────────────────────────────────────────────────────────────────────
const logger = pino({
    level: LOG_LEVEL,
    transport: process.stdout.isTTY
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
})

// ── State ─────────────────────────────────────────────────────────────────────
let sock          = null
let connected     = false
let currentQr     = null    // raw QR string (before encoding)
let currentQrPng  = null    // base64 PNG
let retryCount    = 0
let startedAt     = Date.now()

// ── Express app ───────────────────────────────────────────────────────────────
const app = express()
app.use(express.json())

// ── Auth middleware ───────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
    if (!API_KEY) return next()  // auth disabled

    const header = req.headers['authorization'] || ''
    const token  = header.startsWith('Bearer ') ? header.slice(7) : ''

    if (token !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' })
    }
    next()
}

// Apply auth to all routes
app.use(authMiddleware)

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normalize a phone number to WhatsApp JID.
 * Accepts: 905XXXXXXXXX  +90...  090...  05...  5...
 */
function toJid(phone) {
    let digits = String(phone).replace(/\D/g, '')

    if (digits.startsWith('00')) digits = digits.slice(2)
    if (digits.startsWith('05') && digits.length === 11) digits = '9' + digits.replace(/^0/, '')
    if (digits.startsWith('5')  && digits.length === 10) digits = '90' + digits

    return digits + '@s.whatsapp.net'
}

function requireConnected(res) {
    if (!connected) {
        res.status(503).json({ error: 'WhatsApp not connected', qr_pending: !!currentQr })
        return false
    }
    return true
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health / status
app.get('/status', (req, res) => {
    res.json({
        ok:          true,
        connected,
        qr_pending:  !connected && !!currentQr,
        uptime_s:    Math.floor((Date.now() - startedAt) / 1000),
        retry_count: retryCount,
    })
})

// QR code (base64 PNG) — only available before first connection
app.get('/qr', async (req, res) => {
    if (connected) {
        return res.json({ connected: true, message: 'Already connected, no QR needed.' })
    }
    if (!currentQrPng) {
        return res.status(404).json({ error: 'QR code not ready yet, retry in a few seconds.' })
    }
    res.json({ qr: currentQrPng })
})

// QR code as inline PNG image
app.get('/qr.png', async (req, res) => {
    if (connected) {
        return res.status(410).send('Already connected')
    }
    if (!currentQr) {
        return res.status(404).send('QR not ready')
    }
    const buf = await qrcode.toBuffer(currentQr)
    res.set('Content-Type', 'image/png')
    res.send(buf)
})

// Send single message
app.post('/send', async (req, res) => {
    if (!requireConnected(res)) return

    const { to, text } = req.body || {}

    if (!to || !text) {
        return res.status(400).json({ error: '"to" and "text" are required' })
    }

    const jid = toJid(to)

    try {
        await sock.sendMessage(jid, { text: String(text) })
        logger.info({ jid, len: text.length }, 'Message sent')
        res.json({ ok: true, jid })
    } catch (err) {
        logger.error({ err, jid }, 'Send failed')
        res.status(500).json({ error: err.message })
    }
})

// Send to multiple recipients
app.post('/send-bulk', async (req, res) => {
    if (!requireConnected(res)) return

    const messages = req.body
    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'Body must be a non-empty array of { to, text }' })
    }

    const results = []

    for (const { to, text } of messages) {
        if (!to || !text) {
            results.push({ to, ok: false, error: 'missing to or text' })
            continue
        }
        const jid = toJid(to)
        try {
            await sock.sendMessage(jid, { text: String(text) })
            results.push({ to, ok: true, jid })
            logger.info({ jid }, 'Bulk: message sent')
        } catch (err) {
            results.push({ to, ok: false, error: err.message })
            logger.error({ err, jid }, 'Bulk: send failed')
        }
    }

    res.json({ results })
})

// ── WhatsApp connection ───────────────────────────────────────────────────────
async function startBridge() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    const { version }          = await fetchLatestBaileysVersion()

    logger.info({ version }, 'Connecting to WhatsApp')

    sock = makeWASocket({
        version,
        auth:              state,
        printQRInTerminal: false,
        logger:            pino({ level: 'silent' }),  // suppress Baileys internal noise
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        // New QR code received
        if (qr) {
            currentQr    = qr
            currentQrPng = await qrcode.toDataURL(qr)
            // Terminale bas — `docker compose logs -f` ile telefondan taranabilir
            console.log('\n[QR] WhatsApp > Bağlı Cihazlar > Cihaz Ekle:\n')
            qrcodeTerminal.generate(qr, { small: true })
            console.log('')
            logger.info('QR code ready — /qr.png adresinden de görüntüleyebilirsiniz')
        }

        if (connection === 'open') {
            connected    = true
            currentQr    = null
            currentQrPng = null
            retryCount   = 0
            logger.info('WhatsApp connected!')
        }

        if (connection === 'close') {
            connected = false
            const statusCode = lastDisconnect?.error?.output?.statusCode
            const loggedOut  = statusCode === DisconnectReason.loggedOut

            logger.warn({ statusCode, loggedOut }, 'Connection closed')

            if (loggedOut) {
                logger.error('Logged out — delete auth volume and restart to re-scan QR')
                process.exit(1)
            }

            if (retryCount < MAX_RETRIES) {
                retryCount++
                const delay = Math.min(1000 * 2 ** retryCount, 60_000)  // exponential back-off, max 60s
                logger.info({ retryCount, delay_ms: delay }, 'Reconnecting...')
                setTimeout(startBridge, delay)
            } else {
                logger.error({ MAX_RETRIES }, 'Max retries exceeded, exiting')
                process.exit(1)
            }
        }
    })
}

// ── Boot ──────────────────────────────────────────────────────────────────────
startBridge().catch(err => {
    logger.error(err, 'Bridge startup failed')
    process.exit(1)
})

app.listen(PORT, '::', () => {
    logger.info({
        port:     PORT,
        auth:     API_KEY ? 'enabled' : 'DISABLED (set WA_API_KEY!)',
        auth_dir: AUTH_DIR,
    }, 'Bridge HTTP server started')
})
