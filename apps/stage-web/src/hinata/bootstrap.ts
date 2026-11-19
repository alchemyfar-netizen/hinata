import type { HinataProfile } from '@proj-airi/stage-ui/libs/hinata-cloud'

import {
  consumeLoginRedirect,
  downloadPrivateFile,
  hinataMemory,
  isHinataCloudConfigured,
  loadMemories,
  loadProfile,
  recentMessages,
  saveProfile,
  setPassword,
  signInWithPassword,
  validSession,
} from '@proj-airi/stage-ui/libs/hinata-cloud'

/**
 * Runs before the app mounts. Signs the user in to the Hinata cloud, then writes their settings into
 * the local storage keys that the stores read at startup: the OpenRouter brain, the voice, and the
 * finished setup steps. The stores therefore start configured and the setup screens never show.
 */
export async function hinataBootstrap() {
  if (!isHinataCloudConfigured())
    return

  const redirect = await consumeLoginRedirect()
  if (!await validSession())
    await showLoginScreen(redirect.error)

  let profile: HinataProfile | undefined
  try {
    profile = await loadProfile()
  }
  catch (error) {
    // Offline: start with the settings this device already has.
    console.warn('[hinata] profile unavailable', error)
  }

  if (profile && !profile.settings.openrouterKey && !localOpenRouterKey()) {
    const key = await askForOpenRouterKey()
    profile.settings.openrouterKey = key
    await saveProfile({ settings: { openrouterKey: key } }).catch(error => console.warn('[hinata] key not saved', error))
  }

  if (profile && !profile.settings.passwordSet) {
    const saved = await askToSetPassword()
    if (saved)
      await saveProfile({ settings: { passwordSet: true } }).catch(error => console.warn('[hinata] password flag not saved', error))
  }

  if (profile)
    applyProfile(profile)
  markSetupDone()

  await Promise.all([
    loadMemories().then((facts) => { hinataMemory.facts = facts }).catch(() => {}),
    recentMessages().then((messages) => { hinataMemory.recent = messages }).catch(() => {}),
    profile?.settings.avatarPath ? loadAvatar(profile.settings.avatarPath) : undefined,
  ])
  hinataMemory.userName = profile?.user_name ?? null
}

// ---------------- local settings ----------------

const PROVIDERS_KEY = 'settings/providers/configured'
const ADDED_KEY = 'settings/providers/added'

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  }
  catch {
    return fallback
  }
}

function localOpenRouterKey(): string {
  return String(readJson<Record<string, any>>(PROVIDERS_KEY, {})['openrouter-ai']?.config?.apiKey ?? '')
}

function setIfEmpty(key: string, value: string, emptyValues: string[] = ['']) {
  const current = localStorage.getItem(key)
  if (current === null || emptyValues.includes(current))
    localStorage.setItem(key, value)
}

function applyProfile(profile: HinataProfile) {
  const { settings } = profile
  const key = settings.openrouterKey || localOpenRouterKey()
  if (!key)
    return

  const providers = readJson<Record<string, any>>(PROVIDERS_KEY, {})
  for (const id of ['openrouter-ai', 'openrouter-audio-speech']) {
    providers[id] = {
      ...providers[id],
      id,
      definitionId: id,
      config: { ...providers[id]?.config, apiKey: key, baseUrl: 'https://openrouter.ai/api/v1/' },
      status: 'configured',
      configuredBy: 'user',
    }
  }
  localStorage.setItem(PROVIDERS_KEY, JSON.stringify(providers))
  localStorage.setItem(ADDED_KEY, JSON.stringify({ ...readJson(ADDED_KEY, {}), 'openrouter-ai': true, 'openrouter-audio-speech': true }))

  // The brain.
  setIfEmpty('settings/consciousness/active-provider', 'openrouter-ai')
  setIfEmpty('settings/consciousness/active-model', settings.chatModel || 'openai/gpt-4o-mini')

  // The voice: soft and gentle by default. Changes made in Settings on this device stay.
  setIfEmpty('settings/speech/active-provider', 'openrouter-audio-speech', ['', 'speech-noop'])
  setIfEmpty('settings/speech/active-model', settings.speechModel || 'openai/gpt-audio-mini')
  setIfEmpty('settings/speech/voice', settings.speechVoice || 'shimmer')
}

function markSetupDone() {
  const steps = readJson<Record<string, { version: number, outcome: string, at: number }>>('onboarding/steps', {})
  const at = Date.now()
  for (const id of ['welcome', 'provider-selection', 'provider-configuration', 'model-selection', 'permissions'])
    steps[id] ??= { version: 1, outcome: 'done', at }
  localStorage.setItem('onboarding/steps', JSON.stringify(steps))
}

// ---------------- avatar ----------------

const AVATAR_CACHE = 'hinata-avatar'

/** Downloads the private avatar once per device and keeps it in Cache Storage. */
async function loadAvatar(path: string) {
  const cacheUrl = new URL(`hinata-avatar/${encodeURIComponent(path)}`, location.origin).href
  try {
    const cache = 'caches' in globalThis ? await caches.open(AVATAR_CACHE) : undefined
    let blob = await (await cache?.match(cacheUrl))?.blob()
    if (!blob) {
      blob = await downloadPrivateFile(path)
      await cache?.put(cacheUrl, new Response(blob, { headers: { 'Content-Type': 'application/octet-stream' } }))
    }
    ;(globalThis as { __HINATA_VRM_URL__?: string }).__HINATA_VRM_URL__ = URL.createObjectURL(blob)
  }
  catch (error) {
    console.warn('[hinata] avatar unavailable, using the sample avatar', error)
  }
}

// ---------------- screens ----------------

const STYLE = `
#hinata-gate{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;
  background:radial-gradient(circle at 50% 30%,#3b2f55,#16131d 70%);color:#f3eefc;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
#hinata-gate .card{width:100%;max-width:380px;display:flex;flex-direction:column;gap:14px;text-align:center}
#hinata-gate h1{margin:0;font-size:30px;font-weight:700;letter-spacing:.5px;color:#d9c8ff}
#hinata-gate p{margin:0;font-size:15px;line-height:1.5;color:#cfc4e6}
#hinata-gate input{width:100%;box-sizing:border-box;padding:14px 16px;border-radius:14px;border:1px solid #6f5aa3;background:#221c30;color:#fff;font-size:16px}
#hinata-gate button{padding:14px 16px;border:0;border-radius:14px;background:#a98bf0;color:#1b1430;font-size:16px;font-weight:700;cursor:pointer}
#hinata-gate button:disabled{opacity:.6;cursor:default}
#hinata-gate .note{font-size:13px;color:#a99cc4}
#hinata-gate .error{font-size:14px;color:#ffb4c4;min-height:1em}
`

function mountGate(html: string) {
  document.getElementById('hinata-gate')?.remove()
  if (!document.getElementById('hinata-gate-style')) {
    const style = document.createElement('style')
    style.id = 'hinata-gate-style'
    style.textContent = STYLE
    document.head.append(style)
  }
  const gate = document.createElement('div')
  gate.id = 'hinata-gate'
  gate.innerHTML = `<form class="card" novalidate>${html}</form>`
  document.body.append(gate)
  return gate
}

/** Email + password sign-in. Resolves once signed in; nothing is emailed. */
function showLoginScreen(error?: string): Promise<void> {
  return new Promise((resolve) => {
    const gate = mountGate(`
      <h1>Hinata</h1>
      <p>U-um... welcome back. Sign in so I can remember you.</p>
      <input name="email" type="email" autocomplete="username" inputmode="email" placeholder="Email" required>
      <input name="password" type="password" autocomplete="current-password" placeholder="Password" required>
      <button type="submit">Sign in</button>
      <div class="error" role="alert"></div>
      <div class="note">Your memories stay private to your account.</div>
    `)
    const form = gate.querySelector('form')!
    const button = gate.querySelector('button')!
    const errorBox = gate.querySelector<HTMLElement>('.error')!
    const email = gate.querySelector<HTMLInputElement>('input[name="email"]')!
    const password = gate.querySelector<HTMLInputElement>('input[name="password"]')!
    errorBox.textContent = error ?? ''
    email.focus()

    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      if (!/^\S+@\S+\.\S+$/.test(email.value.trim()) || !password.value) {
        errorBox.textContent = 'Please type your email and password.'
        return
      }
      button.disabled = true
      errorBox.textContent = ''
      try {
        await signInWithPassword(email.value.trim(), password.value)
        gate.remove()
        resolve()
      }
      catch (signInError) {
        button.disabled = false
        errorBox.textContent = signInError instanceof Error ? signInError.message : 'Could not sign in.'
      }
    })
  })
}

/** Asks once, on a signed-in device, for a password that other devices use to sign in. Resolves true when saved. */
function askToSetPassword(): Promise<boolean> {
  return new Promise((resolve) => {
    const gate = mountGate(`
      <h1>Set a password</h1>
      <p>Choose a password for signing in to me on your phone and other devices. No more emails.</p>
      <input name="password" type="password" autocomplete="new-password" placeholder="New password (8+ characters)" required>
      <input name="confirm" type="password" autocomplete="new-password" placeholder="Type it again" required>
      <button type="submit">Save password</button>
      <div class="error" role="alert"></div>
      <div class="note"><a href="#" data-later style="color:#cbb8ff">Later</a></div>
    `)
    const button = gate.querySelector<HTMLButtonElement>('button')!
    const errorBox = gate.querySelector<HTMLElement>('.error')!
    const password = gate.querySelector<HTMLInputElement>('input[name="password"]')!
    const confirm = gate.querySelector<HTMLInputElement>('input[name="confirm"]')!
    password.focus()
    gate.querySelector('[data-later]')!.addEventListener('click', (event) => {
      event.preventDefault()
      gate.remove()
      resolve(false)
    })
    gate.querySelector('form')!.addEventListener('submit', async (event) => {
      event.preventDefault()
      if (password.value.length < 8) {
        errorBox.textContent = 'Please use at least 8 characters.'
        return
      }
      if (password.value !== confirm.value) {
        errorBox.textContent = 'The two passwords are different.'
        return
      }
      button.disabled = true
      errorBox.textContent = ''
      try {
        await setPassword(password.value)
        gate.remove()
        resolve(true)
      }
      catch (saveError) {
        button.disabled = false
        errorBox.textContent = saveError instanceof Error ? saveError.message : 'Could not save the password.'
      }
    })
  })
}

function askForOpenRouterKey(): Promise<string> {
  return new Promise((resolve) => {
    const gate = mountGate(`
      <h1>One last thing</h1>
      <p>Paste your OpenRouter key so I can think and talk. I'll remember it on all your devices.</p>
      <input name="key" type="password" autocomplete="off" placeholder="sk-or-..." required>
      <button type="submit">Save</button>
      <div class="error" role="alert"></div>
    `)
    const input = gate.querySelector<HTMLInputElement>('input')!
    const errorBox = gate.querySelector<HTMLElement>('.error')!
    gate.querySelector('form')!.addEventListener('submit', (event) => {
      event.preventDefault()
      const key = input.value.trim()
      if (!key.startsWith('sk-')) {
        errorBox.textContent = 'That doesn\'t look like an OpenRouter key.'
        return
      }
      gate.remove()
      resolve(key)
    })
  })
}
