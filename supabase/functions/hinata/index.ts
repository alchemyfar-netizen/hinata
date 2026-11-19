// Hinata's server side. Holds the OpenRouter key and the database credentials, so the public web app carries
// neither. Every request must carry the owner's personal access token (from their personal Hinata link).
//
// Routes (under /functions/v1/hinata):
//   POST /v1/audio/transcriptions  hearing: speech to text (OpenAI-compatible, answered by Gemini)
//   /v1/*           OpenRouter API, passed through with the real key (chat, voice, model lists)
//   GET  /state     name, remembered facts, recent messages and settings
//   POST /memories  { facts: string[] }
//   POST /messages  { messages: { role, content }[] }
//   GET  /avatar    the private avatar file
//
// Secrets: HINATA_ACCESS_TOKEN, HINATA_OWNER_ID, OPENROUTER_API_KEY.
// Provided by Supabase: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

const ACCESS_TOKEN = Deno.env.get('HINATA_ACCESS_TOKEN') ?? ''
const OWNER_ID = Deno.env.get('HINATA_OWNER_ID') ?? ''
const OPENROUTER_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

function cors(req: Request): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': req.headers.get('Origin') ?? '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': req.headers.get('Access-Control-Request-Headers') ?? 'authorization, content-type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  }
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } })
}

/** Constant-time comparison of the presented token with the owner's token. */
function authorized(req: Request) {
  const presented = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!ACCESS_TOKEN || presented.length !== ACCESS_TOKEN.length)
    return false
  let diff = 0
  for (let i = 0; i < presented.length; i++)
    diff |= presented.charCodeAt(i) ^ ACCESS_TOKEN.charCodeAt(i)
  return diff === 0
}

async function db(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
  if (!res.ok)
    throw new Error(`database ${res.status}: ${await res.text()}`)
  const text = await res.text()
  return text ? JSON.parse(text) : undefined
}

async function proxyOpenRouter(req: Request, path: string) {
  const url = new URL(req.url)
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${OPENROUTER_KEY}`)
  headers.set('Content-Type', req.headers.get('Content-Type') ?? 'application/json')
  headers.set('HTTP-Referer', 'https://alchemyfar-netizen.github.io/hinata/')
  headers.set('X-Title', 'Hinata')
  const upstream = await fetch(`https://openrouter.ai/api/v1/${path}${url.search}`, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
  })
  const out = new Headers(cors(req))
  for (const name of ['Content-Type', 'Cache-Control'])
    if (upstream.headers.get(name))
      out.set(name, upstream.headers.get(name)!)
  // Streams (chat tokens, audio) pass straight through.
  return new Response(upstream.body, { status: upstream.status, headers: out })
}

// ---------------- hearing ----------------

const TRANSCRIBE_MODELS = ['google/gemini-2.5-flash-lite', 'google/gemini-2.5-flash']
const TRANSCRIBE_PROMPT = 'Transcribe the speech in this audio exactly as spoken (English, Tamil, Hindi or a mix; write it in the script '
  + 'the speaker would type in chat). Output only the spoken words, with no notes, quotes or labels. '
  + 'If there is no clear human speech, output nothing at all.'

function toBase64(bytes: Uint8Array) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function audioFormat(file: File) {
  const hint = `${file.type} ${file.name}`.toLowerCase()
  for (const format of ['wav', 'mp3', 'ogg', 'webm', 'flac', 'm4a', 'aac'])
    if (hint.includes(format))
      return format
  return hint.includes('mpeg') ? 'mp3' : 'wav'
}

/**
 * OpenAI-compatible `POST /v1/audio/transcriptions` (multipart `file`), answered by an audio-capable model on
 * OpenRouter, which has no Whisper endpoint of its own. Works the same in every browser, unlike browser speech APIs.
 */
async function transcribe(req: Request) {
  const form = await req.formData()
  const file = form.get('file')
  if (!(file instanceof File) || !file.size)
    return json(req, { error: 'No audio received.' }, 400)
  const audio = { data: toBase64(new Uint8Array(await file.arrayBuffer())), format: audioFormat(file) }

  let lastError = ''
  for (const model of TRANSCRIBE_MODELS) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://alchemyfar-netizen.github.io/hinata/',
        'X-Title': 'Hinata',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [{ role: 'user', content: [{ type: 'text', text: TRANSCRIBE_PROMPT }, { type: 'input_audio', input_audio: audio }] }],
      }),
    })
    if (!res.ok) {
      lastError = `${model} ${res.status}: ${(await res.text()).slice(0, 200)}`
      continue
    }
    const data = await res.json()
    let text = String(data.choices?.[0]?.message?.content ?? '').trim()
    // Models sometimes describe silence instead of returning nothing.
    if (/^[([]?\s*(no (clear )?(human )?speech|silence|inaudible|no audio)/i.test(text))
      text = ''
    return json(req, { text })
  }
  return json(req, { error: 'Transcription failed.', detail: lastError }, 502)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: cors(req) })
  if (!authorized(req))
    return json(req, { error: 'This Hinata link is not valid.' }, 401)

  const path = new URL(req.url).pathname.replace(/^.*?\/hinata\/?/, '')

  try {
    if (path === 'v1/audio/transcriptions' && req.method === 'POST')
      return await transcribe(req)

    if (path.startsWith('v1/'))
      return await proxyOpenRouter(req, path.slice(3))

    if (path === 'state' && req.method === 'GET') {
      const owner = `user_id=eq.${OWNER_ID}`
      const [profiles, facts, recent] = await Promise.all([
        db(`hinata_profile?select=user_name,settings&${owner}`),
        db(`hinata_memories?select=fact&${owner}&order=created_at.asc&limit=200`),
        db(`hinata_messages?select=role,content,created_at&${owner}&order=id.desc&limit=12`),
      ])
      const settings = { ...(profiles[0]?.settings ?? {}) }
      delete settings.openrouterKey
      return json(req, {
        userName: profiles[0]?.user_name ?? null,
        settings,
        facts: facts.map((row: { fact: string }) => row.fact),
        recent: recent.reverse(),
      })
    }

    if (path === 'memories' && req.method === 'POST') {
      const { facts } = await req.json()
      const clean = [...new Set((Array.isArray(facts) ? facts : [])
        .filter((fact: unknown) => typeof fact === 'string')
        .map((fact: string) => fact.trim().slice(0, 300))
        .filter(Boolean))]
      if (clean.length) {
        await db('hinata_memories?on_conflict=user_id,fact', {
          method: 'POST',
          headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify(clean.map(fact => ({ user_id: OWNER_ID, fact }))),
        })
      }
      return json(req, { saved: clean.length })
    }

    if (path === 'messages' && req.method === 'POST') {
      const { messages } = await req.json()
      const clean = (Array.isArray(messages) ? messages : [])
        .filter((m: any) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .slice(0, 20)
        .map((m: any) => ({ user_id: OWNER_ID, role: m.role, content: m.content.trim().slice(0, 8000) }))
      if (clean.length)
        await db('hinata_messages', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(clean) })
      return json(req, { saved: clean.length })
    }

    if (path === 'avatar' && req.method === 'GET') {
      const profiles = await db(`hinata_profile?select=settings&user_id=eq.${OWNER_ID}`)
      const avatarPath = profiles[0]?.settings?.avatarPath
      if (!avatarPath)
        return json(req, { error: 'No avatar uploaded.' }, 404)
      const objectPath = `${OWNER_ID}/${avatarPath}`.split('/').map(encodeURIComponent).join('/')
      const file = await fetch(`${SUPABASE_URL}/storage/v1/object/hinata-private/${objectPath}`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      })
      if (!file.ok)
        return json(req, { error: `Avatar unavailable (${file.status}).` }, 502)
      return new Response(file.body, {
        headers: { ...cors(req), 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=86400' },
      })
    }

    return json(req, { error: 'Not found.' }, 404)
  }
  catch (error) {
    console.error(error)
    return json(req, { error: 'Hinata server error.', detail: String(error).slice(0, 300) }, 500)
  }
})
