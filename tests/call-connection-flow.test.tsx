// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../src/lib/api'
import { acquireMicrophone } from '../src/lib/microphoneAccess'

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  roomHandlers: {} as Record<string, (...args: unknown[]) => void>,
  roomConnect: vi.fn(),
  roomDisconnect: vi.fn(),
  setMicrophoneEnabled: vi.fn(),
  setCameraEnabled: vi.fn(),
  remoteTrackKind: 'audio',
}))

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>()
  return { ...actual, apiRequest: mocks.apiRequest, resolveMediaUrl: (url: string) => url }
})
vi.mock('../src/lib/eventStream', () => ({
  openAuthenticatedEventStream: () => ({ addEventListener: vi.fn(), close: vi.fn() }),
}))
vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'caller', name: 'Caller' } }),
}))
vi.mock('../src/components/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('../src/components/ui/Avatar', () => ({
  Avatar: ({ alt }: { alt: string }) => <span>{alt}</span>,
}))
vi.mock('livekit-client', () => ({
  Room: class {
    on = vi.fn((event: string, handler: (...args: unknown[]) => void) => { mocks.roomHandlers[event] = handler })
    connect = mocks.roomConnect
    disconnect = mocks.roomDisconnect
    localParticipant = {
      setMicrophoneEnabled: mocks.setMicrophoneEnabled,
      setCameraEnabled: mocks.setCameraEnabled,
      getTrackPublication: vi.fn(() => undefined),
    }
  },
  RoomEvent: {
    AudioPlaybackStatusChanged: 'audioPlaybackStatusChanged',
    VideoPlaybackStatusChanged: 'videoPlaybackStatusChanged',
    TrackSubscribed: 'trackSubscribed',
    TrackUnsubscribed: 'trackUnsubscribed',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
    Disconnected: 'disconnected',
  },
  Track: { Kind: { Audio: 'audio', Video: 'video' }, Source: { Camera: 'camera' } },
}))

import { CallsPage } from '../src/pages/CallsPage'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  Object.keys(mocks.roomHandlers).forEach((event) => delete mocks.roomHandlers[event])
  mocks.roomDisconnect.mockReset().mockResolvedValue(undefined)
  mocks.setMicrophoneEnabled.mockReset().mockResolvedValue(undefined)
  mocks.setCameraEnabled.mockReset().mockResolvedValue(undefined)
  mocks.apiRequest.mockReset()
  mocks.roomConnect.mockReset().mockImplementation(async () => {
    mocks.roomHandlers.trackSubscribed?.(
      {
        kind: mocks.remoteTrackKind,
        sid: `remote-${mocks.remoteTrackKind}`,
        mediaStreamTrack: { id: `remote-${mocks.remoteTrackKind}` },
        attach: vi.fn(),
        detach: vi.fn(),
      },
      {},
      { identity: 'callee' },
    )
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('LiveKit call connection flow', () => {
  it.each(['voice', 'video'] as const)('confirms a %s call after local media setup even if remote media arrives first', async (type) => {
    mocks.remoteTrackKind = type === 'video' ? 'video' : 'audio'
    const call = {
      id: 'call-1',
      callerId: 'caller',
      targetUserId: 'callee',
      type,
      status: 'ringing',
      participants: [
        { userId: 'caller', status: 'accepted', muted: false, cameraOn: type === 'video', speakerOn: true },
        { userId: 'callee', status: 'pending', muted: false, cameraOn: type === 'video', speakerOn: true },
      ],
      createdAt: new Date().toISOString(),
    }
    mocks.apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/calls/history') return { calls: [] }
      if (path === '/api/users') return { users: [{ id: 'callee', name: 'Callee', handle: 'callee' }] }
      if (path === '/api/conversations') return { conversations: [] }
      if (path === '/api/calls/start') return { call }
      if (path === '/api/calls/call-1/token') return { token: 'token', url: 'wss://media.example.test' }
      if (path === '/api/calls/call-1/connected') {
        expect(mocks.setMicrophoneEnabled).toHaveBeenCalledWith(true)
        if (type === 'video') expect(mocks.setCameraEnabled).toHaveBeenCalledWith(true)
        return { call: { ...call, status: 'connected' } }
      }
      if (path === '/api/calls/call-1/leave' || path === '/api/calls/call-1/end') return { call: { ...call, status: 'ended' } }
      throw new Error(`Unexpected API request: ${path}`)
    })

    await act(async () => {
      root.render(<MemoryRouter initialEntries={['/calls']}><CallsPage /></MemoryRouter>)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const startButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === (type === 'video' ? 'Video' : 'Voice'))
    expect(startButton).toBeTruthy()
    await act(async () => {
      startButton?.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(mocks.apiRequest).toHaveBeenCalledWith('/api/calls/call-1/connected', { method: 'POST' })
    expect(host.textContent).toContain('Connected ·')
    expect(host.textContent).not.toContain('Your LiveKit media has not connected')
    expect(() => acquireMicrophone()).toThrow('already in use')

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="End call"]')?.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const releaseMicrophone = acquireMicrophone()
    releaseMicrophone()
    expect(mocks.roomDisconnect).toHaveBeenCalledWith(true)
  })

  it('does not retry the confirmation after leaving the room', async () => {
    const current = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    const confirmation = vi.fn().mockRejectedValue(new ApiError(409, 'Your LiveKit media has not connected to this call.'))

    await expect(import('../src/lib/callConnection').then(({ retryCallConnectionConfirmation }) =>
      retryCallConnectionConfirmation(confirmation, current),
    )).resolves.toBeUndefined()
    expect(confirmation).toHaveBeenCalledTimes(1)
  })
})
