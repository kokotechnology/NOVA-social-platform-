import { Capacitor } from '@capacitor/core'

export class MicrophoneBusyError extends Error {
  constructor() {
    super('The microphone is already in use by another NOVACHAT audio feature. End that session and try again.')
    this.name = 'MicrophoneBusyError'
  }
}

let microphoneInUse = false

export function acquireMicrophone() {
  if (microphoneInUse) throw new MicrophoneBusyError()
  microphoneInUse = true
  let released = false
  return () => {
    if (released) return
    released = true
    microphoneInUse = false
  }
}

export function microphoneAccessErrorMessage(
  error: unknown,
  platform = Capacitor.getPlatform(),
  devices: 'microphone' | 'camera and microphone' = 'microphone',
) {
  const mediaError = error instanceof Error ? error : null
  const name = mediaError?.name ?? ''
  const message = mediaError?.message ?? String(error ?? '')
  const normalizedMessage = message.toLowerCase()
  const deviceLabel = devices === 'microphone' ? 'microphone' : 'camera or microphone'

  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || /no (microphone|camera|audio input)|(?:microphone|camera).*not found/.test(normalizedMessage)) {
    return `No ${deviceLabel} was found on this device. Connect or enable the required device, then try again.`
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return `The ${deviceLabel} is unavailable or being used by another app. Close other apps using it, then try again.`
  }
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return `The ${deviceLabel} does not support the requested capture settings.`
  }
  if (name === 'SecurityError' && typeof window !== 'undefined' && window.isSecureContext === false) {
    return `${deviceLabel} access requires a secure connection. Open NOVACHAT using HTTPS or the installed app, then try again.`
  }
  if (
    name === 'MicrophoneBusyError'
    ||
    ['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(name)
    || /permission denied|not allowed to use|user denied/.test(normalizedMessage)
  ) {
    if (name === 'MicrophoneBusyError') return message
    return platform === 'android'
      ? `${devices === 'microphone' ? 'Microphone' : 'Camera and microphone'} permission was denied. Allow access when Android prompts. If it was denied before, open Android Settings > Apps > NOVACHAT > Permissions and allow ${devices === 'microphone' ? 'Microphone' : 'Camera and microphone'}, then try again.`
      : `${devices === 'microphone' ? 'Microphone' : 'Camera or microphone'} permission was denied. Allow access in your browser’s site settings, then try again.`
  }
  return message ? `Unable to access the ${deviceLabel}: ${message}` : `Unable to access the ${deviceLabel}. Check permissions and try again.`
}
