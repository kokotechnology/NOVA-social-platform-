// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, uploadMedia } from '../src/lib/api'

class MockXMLHttpRequest {
  upload = { onprogress: null }
  status = 502
  responseText = JSON.stringify({ message: 'Database migration is missing.' })
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  onload: (() => void) | null = null

  open() {}
  setRequestHeader() {}
  getResponseHeader() { return 'application/json' }
  send() { this.onerror?.() }
  abort() { this.onabort?.() }
}

describe('media upload errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('preserves an HTTP error response exposed by the upload transport', async () => {
    vi.stubGlobal('XMLHttpRequest', MockXMLHttpRequest)

    await expect(uploadMedia(new File(['image'], 'image.png', { type: 'image/png' })))
      .rejects.toMatchObject({
        name: 'ApiError',
        status: 502,
        message: 'Database migration is missing.',
        code: 'SERVER_ERROR',
      } satisfies Partial<ApiError>)
  })
})
