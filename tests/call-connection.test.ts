import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../src/lib/api'
import { retryCallConnectionConfirmation } from '../src/lib/callConnection'

describe('LiveKit call connection confirmation', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries transient media-not-connected responses until LiveKit confirms the call', async () => {
    vi.useFakeTimers()
    const confirm = vi.fn()
      .mockRejectedValueOnce(new ApiError(409, 'Your LiveKit media has not connected to this call.'))
      .mockRejectedValueOnce(new ApiError(409, 'A second call participant has not connected to LiveKit yet.'))
      .mockResolvedValue(undefined)

    const confirmation = retryCallConnectionConfirmation(confirm, () => true)
    await vi.advanceTimersByTimeAsync(250 + 500)
    await expect(confirmation).resolves.toBeUndefined()
    expect(confirm).toHaveBeenCalledTimes(3)
  })

  it('surfaces unrelated or persistent confirmation errors without retrying', async () => {
    const error = new ApiError(503, 'LiveKit could not verify the call media connection.')
    const confirm = vi.fn().mockRejectedValue(error)

    await expect(retryCallConnectionConfirmation(confirm, () => true)).rejects.toBe(error)
    expect(confirm).toHaveBeenCalledTimes(1)
  })
})
