import type { LucideIcon } from 'lucide-react'

export type NavItem = {
  label: string
  path: string
  icon: LucideIcon
  badge?: string
}

export type UserSummary = {
  id: string
  name: string
  handle: string
  avatar: string
  verified?: boolean
  followerCount?: number
}

export type Post = {
  id: string
  author: UserSummary
  time: string
  content: string
  image?: string
  background?: string
  likes: number
  comments: number
  shares: number
  saved: number
  savedByCurrentUser?: boolean
  visibility?: 'PUBLIC' | 'FOLLOWERS' | 'PRIVATE'
  category?: string
  currentUserReaction?: string | null
  authorFollowing?: boolean
  groupOrigin?: { id: string; name: string; avatarUrl?: string | null; privacy: 'PUBLIC' | 'PRIVATE'; visibility: 'VISIBLE' | 'HIDDEN'; canInteract: boolean }
  groupId?: string
  groupPostType?: string
  groupMedia?: Array<{ url: string; type: string }>
  groupCanInteract?: boolean
  sharedToUserId?: string | null
  sharedPost?: { id: string; content: string; imageUrl?: string | null; author: UserSummary } | null
  sharedDiscussionPost?: {
    id: string
    groupId: string
    content: string
    author: UserSummary
    group: { id: string; name: string; avatarUrl?: string | null }
    media?: Array<{ url: string; type: string }>
  } | null
  live?: {
    id: string
    title: string
    description?: string | null
    status: 'live' | 'paused' | 'ended'
    recordingStatus?: 'UNAVAILABLE' | 'RECORDING' | 'PROCESSING' | 'READY'
    viewerCount: number
  }
}

export type NotificationItem = {
  id: string
  type: 'like' | 'comment' | 'follow' | 'mention' | 'system'
  user: string
  action: string
  time: string
  unread?: boolean
}

export type Conversation = {
  id: string
  name: string
  handle: string
  avatar: string
  lastMessage: string
  time: string
  unread: number
  online?: boolean
}

export type Community = {
  id: string
  name: string
  description: string
  members: string
  category: string
  cover: string
  joined?: boolean
}

export type SettingGroup = {
  id: string
  title: string
  items: { label: string; value: string; highlight?: boolean }[]
}

export type Story = {
  id: string
  name: string
  avatar: string
  accent: string
}
