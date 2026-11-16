import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { acquireMicrophone, microphoneAccessErrorMessage } from '../src/lib/microphoneAccess'

let releaseMicrophone: (() => void) | undefined

afterEach(() => {
  releaseMicrophone?.()
  releaseMicrophone = undefined
})

describe('microphone access', () => {
  it('declares Android runtime permissions used by the Capacitor WebView', () => {
    const manifest = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8')

    expect(manifest).toContain('android.permission.RECORD_AUDIO')
    expect(manifest).toContain('android.permission.CAMERA')
    expect(manifest).toContain('android.permission.MODIFY_AUDIO_SETTINGS')
  })

  it('prevents a second capture request until the active stream releases its lease', () => {
    releaseMicrophone = acquireMicrophone()
    expect(() => acquireMicrophone()).toThrow('already in use')

    releaseMicrophone()
    releaseMicrophone = undefined
    const releaseAgain = acquireMicrophone()
    releaseAgain()
  })

  it('guides Android users to settings after a denied or previously denied permission', () => {
    const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })

    expect(microphoneAccessErrorMessage(denied, 'android')).toContain('Android Settings > Apps > NOVACHAT > Permissions')
  })

  it('guides browser users to site settings after permission denial', () => {
    const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })

    expect(microphoneAccessErrorMessage(denied, 'web')).toContain('browser’s site settings')
  })

  it('distinguishes a missing microphone from a microphone already in use', () => {
    const missing = Object.assign(new Error('Requested device not found'), { name: 'NotFoundError' })
    const busy = Object.assign(new Error('Could not start audio source'), { name: 'NotReadableError' })

    expect(microphoneAccessErrorMessage(missing)).toContain('No microphone was found')
    expect(microphoneAccessErrorMessage(busy)).toContain('being used by another app')
  })
})
