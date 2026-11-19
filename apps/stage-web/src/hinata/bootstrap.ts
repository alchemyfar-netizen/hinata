import type { HinataState } from '@proj-airi/stage-ui/libs/hinata-cloud'

import {
  captureAccessKey,
  downloadAvatar,
  forgetHinataAccessKey,
  HINATA_FUNCTION_URL,
  hasStoredHinataAccessKey,
  hinataAccessKey,
  hinataMemory,
  HinataUnauthorizedError,
  isHinataCloudConfigured,
  loadState,
} from '@proj-airi/stage-ui/libs/hinata-cloud'

/**
 * Runs before the app mounts. Reads the personal key from the Hinata link, then writes Hinata's settings into
 * the local storage keys that the stores read at startup: the brain and voice (through the Hinata function,
 * which holds the real OpenRouter key) and the finished setup steps. No sign-in or setup screen ever shows.
 */
export async function hinataBootstrap() {
  if (!isHinataCloudConfigured())
    return

  try {
    // Left over from the email and password sign-in of earlier versions.
    localStorage.removeItem('hinata/session')
  }
  catch {}

  captureAccessKey()

  let state: HinataState | undefined
  try {
    state = await loadState()
  }
  catch (error) {
    // An old personal link saved on this device: drop it and use the built-in key.
    if (error instanceof HinataUnauthorizedError && hasStoredHinataAccessKey()) {
      forgetHinataAccessKey()
      state = await loadState().catch(() => undefined)
    }
    else {
      // Offline: start with what this device already has.
      console.warn('[hinata] state unavailable', error)
    }
  }

  applySettings(state)
  markSetupDone()
  useHinataLook()

  hinataMemory.userName = state?.userName ?? null
  hinataMemory.facts = state?.facts ?? []
  hinataMemory.recent = state?.recent ?? []
  if (state?.settings.avatarPath)
    await loadAvatar(state.settings.avatarPath)
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

function setIfEmpty(key: string, value: string, emptyValues: string[] = ['']) {
  const current = localStorage.getItem(key)
  if (current === null || emptyValues.includes(current))
    localStorage.setItem(key, value)
}

function applySettings(state: HinataState | undefined) {
  const settings = state?.settings ?? {}
  const providers = readJson<Record<string, any>>(PROVIDERS_KEY, {})
  for (const id of ['openrouter-ai', 'openrouter-audio-speech']) {
    providers[id] = {
      ...providers[id],
      id,
      definitionId: id,
      // The Hinata function speaks the OpenRouter API and adds the real key; the device only has its personal key.
      config: { ...providers[id]?.config, apiKey: hinataAccessKey(), baseUrl: `${HINATA_FUNCTION_URL}/v1/` },
      status: 'configured',
      configuredBy: 'user',
    }
  }
  // Hearing: speech to text through the Hinata function (a Gemini model on OpenRouter). Same in every browser.
  const transcriber = 'openai-compatible-audio-transcription'
  providers[transcriber] = {
    ...providers[transcriber],
    id: transcriber,
    definitionId: transcriber,
    config: { ...providers[transcriber]?.config, apiKey: hinataAccessKey(), baseUrl: `${HINATA_FUNCTION_URL}/v1/`, model: 'whisper-1' },
    status: 'configured',
    configuredBy: 'user',
  }
  localStorage.setItem(PROVIDERS_KEY, JSON.stringify(providers))
  localStorage.setItem(ADDED_KEY, JSON.stringify({ ...readJson(ADDED_KEY, {}), 'openrouter-ai': true, 'openrouter-audio-speech': true, [transcriber]: true }))

  // The brain.
  setIfEmpty('settings/consciousness/active-provider', 'openrouter-ai')
  setIfEmpty('settings/consciousness/active-model', settings.chatModel || 'openai/gpt-4o-mini')

  // The voice: soft and gentle by default. Changes made in Settings on this device stay.
  setIfEmpty('settings/speech/active-provider', 'openrouter-audio-speech', ['', 'speech-noop'])
  setIfEmpty('settings/speech/active-model', settings.speechModel || 'openai/gpt-audio-mini')
  setIfEmpty('settings/speech/voice', settings.speechVoice || 'shimmer')
  localStorage.setItem('settings/speech/enabled', 'true')

  // Hearing defaults, applied once per device: the Hinata transcriber, and speech sends itself when you stop talking.
  if (localStorage.getItem('hinata/hearing-version') !== '2') {
    localStorage.setItem('settings/hearing/active-provider', transcriber)
    localStorage.setItem('settings/hearing/active-model', 'whisper-1')
    localStorage.setItem('settings/hearing/enabled', 'true')
    localStorage.setItem('settings/hearing/auto-send-enabled', 'true')
    localStorage.setItem('settings/hearing/auto-send-delay', '1200')
    localStorage.setItem('hinata/hearing-version', '2')
  }
}

function markSetupDone() {
  const steps = readJson<Record<string, { version: number, outcome: string, at: number }>>('onboarding/steps', {})
  const at = Date.now()
  for (const id of ['welcome', 'provider-selection', 'provider-configuration', 'model-selection', 'permissions'])
    steps[id] ??= { version: 1, outcome: 'done', at }
  localStorage.setItem('onboarding/steps', JSON.stringify(steps))
}

const HINATA_AVATAR_REF = { id: 'hinata-vrm-avatar-model', displayModelId: 'preset-vrm-hinata', type: 'vrm', config: {} }
const LAVENDER_HUE = '305'

/**
 * Hinata's avatar and colors on every device. A browser that opened older versions keeps AIRI's model on its
 * saved character and AIRI's color, so both are corrected here; a different avatar picked later in Settings stays.
 */
function useHinataLook() {
  try {
    const raw = localStorage.getItem('airi-cards')
    const cards = raw ? JSON.parse(raw) as [string, any][] : []
    const entry = cards.find(([id]) => id === 'default')
    const airi = entry?.[1]?.extensions?.airi
    if (airi && localStorage.getItem('hinata/look-version') !== '1') {
      airi.avatarModels = [HINATA_AVATAR_REF, ...(airi.avatarModels ?? []).filter((model: { id: string }) => model.id !== HINATA_AVATAR_REF.id)]
      airi.defaultAvatarModelId = HINATA_AVATAR_REF.id
      localStorage.setItem('airi-cards', JSON.stringify(cards))
    }
    const hue = localStorage.getItem('settings/theme/colors/hue')
    if (hue === null || hue === '220.44' || hue === '275')
      localStorage.setItem('settings/theme/colors/hue', LAVENDER_HUE)
    localStorage.setItem('hinata/look-version', '1')
  }
  catch (error) {
    console.warn('[hinata] could not apply the Hinata look', error)
  }
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
      blob = await downloadAvatar()
      await cache?.put(cacheUrl, new Response(blob, { headers: { 'Content-Type': 'application/octet-stream' } }))
    }
    ;(globalThis as { __HINATA_VRM_URL__?: string }).__HINATA_VRM_URL__ = URL.createObjectURL(blob)
  }
  catch (error) {
    console.warn('[hinata] avatar unavailable, using the sample avatar', error)
  }
}
