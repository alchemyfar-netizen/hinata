/**
 * Hinata's cloud home on Supabase: sign-in, profile settings, long-term memory,
 * recent conversation and the private avatar file.
 *
 * Plain `fetch` against the Supabase REST, Auth and Storage APIs, so the build needs no new dependency.
 * Row level security on every table keeps each row readable by its owner only.
 */

const SUPABASE_URL = (import.meta.env.VITE_HINATA_SUPABASE_URL as string | undefined)?.replace(/\/$/, '') ?? ''
const SUPABASE_KEY = (import.meta.env.VITE_HINATA_SUPABASE_KEY as string | undefined) ?? ''
const SESSION_KEY = 'hinata/session'
const BUCKET = 'hinata-private'

export interface HinataSession {
  access_token: string
  refresh_token: string
  /** Unix seconds. */
  expires_at: number
  user: { id: string, email?: string }
}

export interface HinataProfileSettings {
  openrouterKey?: string
  chatModel?: string
  speechModel?: string
  speechVoice?: string
  /** Path inside the user's folder of the private bucket, e.g. `Hinata.vrm`. */
  avatarPath?: string
  /** True once the user has set a password for signing in on other devices. */
  passwordSet?: boolean
}

export interface HinataProfile {
  user_name: string | null
  settings: HinataProfileSettings
}

export interface HinataMessage {
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export function isHinataCloudConfigured() {
  return !!SUPABASE_URL && !!SUPABASE_KEY
}

// ---------------- session ----------------

function readSession(): HinataSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    return raw ? JSON.parse(raw) as HinataSession : null
  }
  catch {
    return null
  }
}

function writeSession(session: HinataSession | null) {
  try {
    if (session)
      localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    else
      localStorage.removeItem(SESSION_KEY)
  }
  catch {}
}

export function currentUser() {
  return readSession()?.user ?? null
}

async function authFetch(path: string, body: unknown) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok)
    throw new Error(data.msg || data.error_description || data.message || `Sign-in failed (${res.status})`)
  return data
}

function sessionFrom(data: any): HinataSession {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at ?? Math.floor(Date.now() / 1000) + Number(data.expires_in ?? 3600),
    user: { id: data.user?.id, email: data.user?.email },
  }
}

/** Signs in with email and password. Nothing is emailed. */
export async function signInWithPassword(email: string, password: string) {
  try {
    writeSession(sessionFrom(await authFetch('token?grant_type=password', { email, password })))
  }
  catch (error) {
    const message = error instanceof Error ? error.message : ''
    throw new Error(/invalid login credentials/i.test(message) ? 'That email or password is not right.' : message || 'Could not sign in.')
  }
}

/** Sets the password of the signed-in account, so other devices can sign in without email. */
export async function setPassword(password: string) {
  const session = await validSession()
  if (!session)
    throw new Error('Not signed in to Hinata')
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    method: 'PUT',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.msg || data.message || `Could not save the password (${res.status})`)
  }
}

/** Emails a sign-in link that comes back to this app. */
export async function sendLoginLink(email: string, redirectTo: string) {
  await authFetch(`otp?redirect_to=${encodeURIComponent(redirectTo)}`, { email, create_user: false })
}

/**
 * Reads the tokens that a sign-in link puts in the URL hash, stores the session
 * and removes the tokens from the address bar. Returns an error text when the link failed.
 */
export async function consumeLoginRedirect(): Promise<{ signedIn: boolean, error?: string }> {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : ''
  if (!hash.includes('access_token=') && !hash.includes('error='))
    return { signedIn: false }

  const params = new URLSearchParams(hash)
  history.replaceState(null, '', location.pathname + location.search)

  if (params.get('error'))
    return { signedIn: false, error: params.get('error_description') || params.get('error') || 'Sign-in failed' }

  const accessToken = params.get('access_token') ?? ''
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok)
    return { signedIn: false, error: 'This sign-in link has expired. Ask for a new one.' }
  const user = await res.json()
  writeSession({
    access_token: accessToken,
    refresh_token: params.get('refresh_token') ?? '',
    expires_at: Number(params.get('expires_at')) || Math.floor(Date.now() / 1000) + Number(params.get('expires_in') ?? 3600),
    user: { id: user.id, email: user.email },
  })
  return { signedIn: true }
}

let refreshing: Promise<HinataSession | null> | undefined

/**
 * One refresh at a time across all tabs. Supabase rotates the refresh token, so two tabs
 * refreshing with the same token would make the second one fail and sign the user out.
 */
function withRefreshLock<T>(task: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks)
    return navigator.locks.request('hinata-session-refresh', task)
  return task()
}

/** A session whose access token is valid for at least another minute, or null when signed out. */
export async function validSession(): Promise<HinataSession | null> {
  const session = readSession()
  if (!session)
    return null
  if (session.expires_at - 60 > Date.now() / 1000)
    return session

  refreshing ??= withRefreshLock(async () => {
    // Another tab may have refreshed while this one waited for the lock: its session is in storage.
    const latest = readSession()
    if (!latest)
      return null
    if (latest.expires_at - 60 > Date.now() / 1000)
      return latest
    try {
      const data = await authFetch('token?grant_type=refresh_token', { refresh_token: latest.refresh_token })
      const next = sessionFrom(data)
      writeSession(next)
      return next
    }
    catch (error) {
      // Offline: keep the session for the next try.
      if (error instanceof TypeError)
        return null
      // A tab that refreshed with the same token in the meantime already stored the new session.
      const now = readSession()
      if (now && now.refresh_token !== latest.refresh_token)
        return now
      if (/refresh token/i.test(error instanceof Error ? error.message : ''))
        writeSession(null)
      return null
    }
  }).finally(() => {
    refreshing = undefined
  })
  return refreshing
}

export function signOut() {
  writeSession(null)
}

// ---------------- data ----------------

async function rest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = await validSession()
  if (!session)
    throw new Error('Not signed in to Hinata')
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
  if (!res.ok)
    throw new Error(`Hinata cloud: ${res.status} ${await res.text().catch(() => '')}`)
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export async function loadProfile(): Promise<HinataProfile> {
  const rows = await rest<HinataProfile[]>('hinata_profile?select=user_name,settings')
  return rows[0] ?? { user_name: null, settings: {} }
}

export async function saveProfile(patch: Partial<HinataProfile>) {
  const current = await loadProfile()
  await rest('hinata_profile?on_conflict=user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      user_name: patch.user_name ?? current.user_name,
      settings: { ...current.settings, ...patch.settings },
      updated_at: new Date().toISOString(),
    }),
  })
}

export async function loadMemories(limit = 200): Promise<string[]> {
  const rows = await rest<{ fact: string }[]>(`hinata_memories?select=fact&order=created_at.asc&limit=${limit}`)
  return rows.map(row => row.fact)
}

export async function addMemories(facts: string[]) {
  const clean = [...new Set(facts.map(fact => fact.trim().slice(0, 300)).filter(Boolean))]
  if (!clean.length)
    return
  await rest('hinata_memories?on_conflict=user_id,fact', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(clean.map(fact => ({ fact }))),
  })
}

export async function recentMessages(limit = 12): Promise<HinataMessage[]> {
  const rows = await rest<HinataMessage[]>(`hinata_messages?select=role,content,created_at&order=created_at.desc&limit=${limit}`)
  return rows.reverse()
}

export async function logMessages(messages: { role: 'user' | 'assistant', content: string }[]) {
  const clean = messages
    .map(message => ({ role: message.role, content: message.content.trim().slice(0, 8000) }))
    .filter(message => message.content)
  if (clean.length)
    await rest('hinata_messages', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(clean) })
}

/** Downloads a file from the user's own folder of the private bucket. */
export async function downloadPrivateFile(path: string): Promise<Blob> {
  const session = await validSession()
  if (!session)
    throw new Error('Not signed in to Hinata')
  const objectPath = `${session.user.id}/${path}`.split('/').map(encodeURIComponent).join('/')
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/${BUCKET}/${objectPath}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${session.access_token}` },
  })
  if (!res.ok)
    throw new Error(`Hinata avatar download failed (${res.status})`)
  return res.blob()
}

// ---------------- memory for the chat ----------------

/** What Hinata knows, loaded once at startup and extended as she learns. Read by the chat context provider. */
export const hinataMemory: {
  userName: string | null
  facts: string[]
  recent: HinataMessage[]
} = { userName: null, facts: [], recent: [] }

const MEMORY_EXTRACT_PROMPT = 'Extract durable personal facts about the USER from their latest message that a caring friend should remember '
  + '(their name, likes, dislikes, important people, goals, upcoming plans, feelings about ongoing situations). '
  + 'Ignore small talk and commands to the assistant. Reply with ONLY a JSON array of short third-person strings, '
  + 'e.g. ["Their best friend is Haroon"], or [] if nothing is worth remembering.'

/** Asks a small model which facts in the user's message are worth keeping, then saves them. */
export async function learnFromTurn(userText: string, assistantText: string, apiKey: string) {
  if (!isHinataCloudConfigured() || !currentUser())
    return

  // Stage control tokens such as `<|ACT {"emotion":"happy"}|>` are for the avatar, not for memory.
  const spoken = assistantText.replace(/<\|[\s\S]*?\|>/g, '').replace(/\s+/g, ' ').trim()
  await logMessages([
    { role: 'user', content: userText },
    { role: 'assistant', content: spoken },
  ]).catch(error => console.warn('[hinata] message log failed', error))
  hinataMemory.recent.push(
    { role: 'user', content: userText, created_at: new Date().toISOString() },
    { role: 'assistant', content: spoken, created_at: new Date().toISOString() },
  )
  hinataMemory.recent.splice(0, Math.max(0, hinataMemory.recent.length - 12))

  if (!apiKey || userText.trim().length < 12)
    return

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        temperature: 0,
        messages: [
          { role: 'system', content: MEMORY_EXTRACT_PROMPT },
          { role: 'user', content: userText.slice(0, 2000) },
        ],
      }),
    })
    if (!res.ok)
      return
    const data = await res.json()
    const raw = String(data.choices?.[0]?.message?.content ?? '[]')
    const facts = JSON.parse(raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1) || '[]')
    if (!Array.isArray(facts))
      return
    const fresh = facts
      .filter((fact): fact is string => typeof fact === 'string')
      .filter(fact => !hinataMemory.facts.some(known => known.toLowerCase() === fact.toLowerCase()))
    if (!fresh.length)
      return
    await addMemories(fresh)
    hinataMemory.facts.push(...fresh)
  }
  catch (error) {
    console.warn('[hinata] memory update failed', error)
  }
}
