// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PostCard } from '../src/components/PostCard'
import { UpdatesPage } from '../src/pages/UpdatesPage'
import type { Post } from '../src/types'

const auth = vi.hoisted(() => ({ user: null as { id: string } | null }))
vi.mock('../src/context/AuthContext', () => ({ useAuth: () => ({ user: auth.user }) }))

const post: Post = {
  id: 'share-post-1',
  author: { id: 'author-1', name: 'Nora', handle: 'nora', avatar: '' },
  time: 'now',
  content: 'A post to share',
  likes: 0,
  comments: 0,
  shares: 0,
  saved: 0,
}

afterEach(() => {
  auth.user = null
  vi.unstubAllGlobals()
})

describe('mobile social actions', () => {
  it('renders a visible share action in the post action row', () => {
    vi.stubGlobal('window', { location: { origin: 'https://nova.test' } })
    const markup = renderToStaticMarkup(<MemoryRouter><PostCard post={post} /></MemoryRouter>)

    expect(markup).toContain('aria-label="Share post (0 shares)"')
    expect(markup).toContain('>Share</button>')
  })

  it('opens the share sheet when crypto.randomUUID is unavailable', async () => {
    vi.stubGlobal('crypto', {})
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onShareToStory = vi.fn()
    window.addEventListener('novachat:share-to-story', onShareToStory)

    await act(async () => {
      root.render(<MemoryRouter><PostCard post={post} /></MemoryRouter>)
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label^="Share post"]')?.click()
    })

    const shareDialog = document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="Share post"]')
    expect(shareDialog).not.toBeNull()
    expect(shareDialog?.parentElement?.parentElement).toBe(document.body)
    expect(shareDialog?.querySelector('[aria-label="Share destinations"]')).not.toBeNull()
    for (const destination of ['Story', 'Discussion Groups', "Friend's Profile", 'WhatsApp', 'Messages', 'Copy Link', 'More']) {
      expect(Array.from(shareDialog?.querySelectorAll('button') ?? []).some((button) => button.textContent?.trim() === destination)).toBe(true)
    }
    await act(async () => {
      Array.from(shareDialog?.querySelectorAll('button') ?? []).find((button) => button.textContent?.trim() === 'Story')?.click()
    })
    expect(onShareToStory).toHaveBeenCalledOnce()
    expect(document.body.querySelector('[role="dialog"][aria-label="Share post"]')).toBeNull()

    await act(async () => root.unmount())
    window.removeEventListener('novachat:share-to-story', onShareToStory)
    host.remove()
  })

  it("shows an explicit Delete action on the current user's own completed live replay post", () => {
    auth.user = { id: 'author-1' }
    vi.stubGlobal('window', { location: { origin: 'https://nova.test' } })
    const replayPost: Post = {
      ...post,
      live: { id: 'live-1', title: 'Town hall', status: 'ended', recordingStatus: 'READY', viewerCount: 0 },
      image: '/api/media/files/replay.webm',
    }
    const markup = renderToStaticMarkup(<MemoryRouter><PostCard post={replayPost} /></MemoryRouter>)

    expect(markup).toContain('aria-label="Delete post"')
    expect(markup).toContain('>Delete</span>')
  })

  it("does not show Delete to a user who does not own the replay post", () => {
    auth.user = { id: 'another-user' }
    vi.stubGlobal('window', { location: { origin: 'https://nova.test' } })
    const markup = renderToStaticMarkup(<MemoryRouter><PostCard post={post} /></MemoryRouter>)

    expect(markup).toContain('aria-label="Report post"')
    expect(markup).not.toContain('aria-label="Delete post"')
  })

  it('provides separate text and camera actions on the Status screen', () => {
    const markup = renderToStaticMarkup(<MemoryRouter><UpdatesPage /></MemoryRouter>)

    expect(markup).toContain('<h1 class="text-lg font-semibold">Status</h1>')
    expect(markup).toContain('aria-label="Create a text status"')
    expect(markup).toContain('aria-label="Create a photo or video status"')
  })
})
