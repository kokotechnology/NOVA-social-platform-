// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

const state = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  post: {
    id: 'post-1',
    groupId: 'group-1',
    authorId: 'owner-id',
    type: 'TEXT',
    content: 'Group update',
    isPinned: false,
    isFeatured: false,
    createdAt: '2026-11-15T00:00:00.000Z',
    updatedAt: '2026-11-15T00:00:00.000Z',
    reactionCounts: {},
    reactionUsers: [],
    commentCount: 0,
    media: [],
  },
  sentPost: null as Record<string, unknown> | null,
  sharedTo: '',
}))

vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'owner-id', name: 'Owner' }, isLoading: false }),
}))

vi.mock('../src/lib/api', () => ({
  apiRequest: state.apiRequest,
  resolveMediaUrl: (url: string | null | undefined) => url ?? '',
  uploadMedia: vi.fn(),
  uploadVideo: vi.fn(),
}))

import { DiscussionGroupsPage } from '../src/pages/DiscussionGroupsPage'

let root: Root | null = null
let host: HTMLDivElement

const group = () => ({
  id: 'group-1',
  name: 'Frontend Test Group',
  description: 'Testing the full group interface',
  category: 'General',
  avatarUrl: null,
  coverUrl: null,
  privacy: 'PUBLIC' as const,
  visibility: 'VISIBLE' as const,
  membershipApproval: false,
  postApproval: false,
  rules: [],
  memberCount: 2,
  joined: true,
  myRole: 'OWNER' as const,
  ownerId: 'owner-id',
  members: [
    { userId: 'owner-id', role: 'OWNER' as const, user: { id: 'owner-id', name: 'Owner', profile: { username: 'ownerhandle' } } },
    { userId: 'member-id', role: 'MEMBER' as const, user: { id: 'member-id', name: 'Member', profile: { username: 'memberhandle' } } },
  ],
  posts: [{ ...state.post }],
})

function configureApi() {
  state.apiRequest.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path === '/api/discussion-groups?filter=discover') return { groups: [] }
    if (path === '/api/discussion-groups/group-1?sort=relevant') return { group: group(), nextCursor: null }
    if (path === '/api/discussion-groups?filter=joined&limit=50') {
      return { groups: [{ ...group(), id: 'destination-id', name: 'Destination Group' }] }
    }
    if (path.includes('/posts/post-1/feature') && options?.method === 'PATCH') {
      state.post.isFeatured = JSON.parse(String(options.body)).featured
      return { featured: state.post.isFeatured }
    }
    if (path.endsWith('/posts') && options?.method === 'POST') {
      state.sentPost = JSON.parse(String(options.body)) as Record<string, unknown>
      return { post: { ...state.post, ...state.sentPost } }
    }
    if (path.endsWith('/posts/post-1/share') && options?.method === 'POST') {
      state.sharedTo = (JSON.parse(String(options.body)) as { targetGroupId: string }).targetGroupId
      return { post: { id: 'share-1' } }
    }
    return {}
  })
}

async function renderPage() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<MemoryRouter initialEntries={['/discussion-groups/group-1']}><Routes>
      <Route path="/discussion-groups/:groupId" element={<DiscussionGroupsPage />} />
    </Routes></MemoryRouter>)
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function click(element: Element | null) {
  if (!element) throw new Error('Expected control was not rendered.')
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function changeSelect(select: HTMLSelectElement, value: string) {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    setValue.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await Promise.resolve()
  })
}

describe('Discussion Groups UI workflows', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    state.post.isFeatured = false
    state.sentPost = null
    state.sharedTo = ''
    configureApi()
  })

  afterEach(async () => {
    if (root) await act(async () => { root!.unmount() })
    root = null
    host?.remove()
    state.apiRequest.mockReset()
  })

  it('inserts a member mention, publishes it, features a post, and shares it to a joined group', async () => {
    await renderPage()

    await changeSelect(host.querySelector<HTMLSelectElement>('[aria-label="Mention a group member in the post"]')!, 'member-id')
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Post text"]')?.value).toContain('@memberhandle')
    await click([...host.querySelectorAll('button')].find((button) => button.textContent === 'Publish') ?? null)
    expect(state.sentPost?.content).toContain('@memberhandle')

    await click(host.querySelector('[aria-label="Post actions"]'))
    await click([...host.querySelectorAll('button')].find((button) => button.textContent === 'Feature post') ?? null)
    expect(state.apiRequest).toHaveBeenCalledWith('/api/discussion-groups/group-1/posts/post-1/feature', expect.objectContaining({ method: 'PATCH' }))

    await click(host.querySelector('[aria-label="Post actions"]'))
    await click([...host.querySelectorAll('button')].find((button) => button.textContent === 'Share to a group') ?? null)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(host.textContent).toContain('Share to another group')
    await click([...host.querySelectorAll('button')].find((button) => button.textContent === 'Share') ?? null)
    expect(state.sharedTo).toBe('destination-id')
  })
})
