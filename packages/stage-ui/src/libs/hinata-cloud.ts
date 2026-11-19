/**
 * Hinata's cloud home: the `hinata` Supabase Edge Function.
 *
 * The function holds the OpenRouter key and the database credentials. The app only carries the owner's
 * personal access token, which arrives once per device through the personal Hinata link (`#key=...`).
 * No login, no email, no password.
 */

const SUPABASE_URL = (import.meta.env.VITE_HINATA_SUPABASE_URL as string | undefined)?.replace(/\/$/, '') ?? ''
const KEY_STORAGE = 'hinata/key'

/** Base URL of the Hinata function. OpenRouter-compatible clients use `${HINATA_FUNCTION_URL}/v1/`. */
export const HINATA_FUNCTION_URL = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/hinata` : ''

export interface HinataMessage {
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export interface HinataState {
  userName: string | null
  settings: {
    chatModel?: string
    speechModel?: string
    speechVoice?: string
    avatarPath?: string
  }
  facts: string[]
  recent: HinataMessage[]
}

export function isHinataCloudConfigured() {
  return !!HINATA_FUNCTION_URL
}

// ---------------- personal access token ----------------

export function hinataAccessKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? ''
  }
  catch {
    return ''
  }
}

export function forgetHinataAccessKey() {
  try {
    localStorage.removeItem(KEY_STORAGE)
  }
  catch {}
}

/** Saves the token from a personal link (`#key=...`, or a pasted link) and removes it from the address bar. */
export function captureAccessKey(source = location.hash): boolean {
  const match = /[#&?]key=([\w-]{20,})/.exec(source)
  if (!match)
    return false
  try {
    localStorage.setItem(KEY_STORAGE, match[1])
  }
  catch {
    return false
  }
  if (source === location.hash)
    history.replaceState(null, '', location.pathname + location.search)
  return true
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${HINATA_FUNCTION_URL}/${path}`, {
    ...init,
    headers: { 'Authorization': `Bearer ${hinataAccessKey()}`, 'Content-Type': 'application/json', ...init.headers },
  })
  if (res.status === 401)
    throw new HinataUnauthorizedError()
  if (!res.ok)
    throw new Error(`Hinata server ${res.status}`)
  return res.json() as Promise<T>
}

export class HinataUnauthorizedError extends Error {
  constructor() {
    super('This Hinata link is not valid.')
  }
}

export function loadState() {
  return api<HinataState>('state')
}

export async function addMemories(facts: string[]) {
  if (facts.length)
    await api('memories', { method: 'POST', body: JSON.stringify({ facts }) })
}

export async function logMessages(messages: { role: 'user' | 'assistant', content: string }[]) {
  if (messages.length)
    await api('messages', { method: 'POST', body: JSON.stringify({ messages }) })
}

/** Downloads the private avatar file. */
export async function downloadAvatar(): Promise<Blob> {
  const res = await fetch(`${HINATA_FUNCTION_URL}/avatar`, { headers: { Authorization: `Bearer ${hinataAccessKey()}` } })
  if (!res.ok)
    throw new Error(`Hinata avatar unavailable (${res.status})`)
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

/** Saves the exchange, then asks a small model which facts in the user's message are worth keeping. */
export async function learnFromTurn(userText: string, assistantText: string) {
  if (!isHinataCloudConfigured() || !hinataAccessKey())
    return

  // Stage control tokens such as `<|ACT {"emotion":"happy"}|>` are for the avatar, not for memory.
  const spoken = assistantText.replace(/<\|[\s\S]*?\|>/g, '').replace(/\s+/g, ' ').trim()
  await logMessages([
    { role: 'user', content: userText },
    { role: 'assistant', content: spoken },
  ]).catch(error => console.warn('[hinata] message log failed', error))
  const now = new Date().toISOString()
  hinataMemory.recent.push({ role: 'user', content: userText, created_at: now }, { role: 'assistant', content: spoken, created_at: now })
  hinataMemory.recent.splice(0, Math.max(0, hinataMemory.recent.length - 12))

  if (userText.trim().length < 12)
    return

  try {
    const res = await fetch(`${HINATA_FUNCTION_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${hinataAccessKey()}`, 'Content-Type': 'application/json' },
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
      .filter((fact): fact is string => typeof fact === 'string' && !!fact.trim())
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
