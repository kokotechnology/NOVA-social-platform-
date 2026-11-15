import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Check, ChevronDown, ImagePlus, LockKeyhole, MessageCircle, Pin, Plus, Search, Shield, ThumbsUp, Trash2, Users, X } from 'lucide-react'
import { Avatar } from '../components/ui/Avatar'
import { Button } from '../components/ui/Button'
import { useAuth } from '../context/AuthContext'
import { apiRequest, resolveMediaUrl, uploadMedia, uploadVideo } from '../lib/api'

type Role = 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER'
type MemberAction =
  | { action: 'role'; role: Exclude<Role, 'OWNER'> }
  | { action: 'restrict' | 'suspend'; until: string | null }
  | { action: 'ban'; reason?: string; until: string | null }
  | { action: 'unban' }
type Group = {
  id: string
  name: string
  description: string
  category: string
  avatarUrl: string | null
  coverUrl: string | null
  privacy: 'PUBLIC' | 'PRIVATE'
  visibility: 'VISIBLE' | 'HIDDEN'
  membershipApproval: boolean
  postApproval: boolean
  rules: string[]
  memberCount: number
  joined: boolean
  myRole: Role | null
  ownerId: string
  members?: Array<{ userId: string; role: Role; user?: { id: string; name: string; profile?: { displayName?: string | null; avatarUrl?: string | null; username?: string | null } | null } | null }>
  posts?: DiscussionPost[]
}
type DiscussionPost = {
  id: string
  groupId: string
  authorId: string
  type: 'TEXT' | 'IMAGE' | 'VIDEO' | 'LINK' | 'POLL' | 'QUESTION' | 'ANNOUNCEMENT'
  content: string
  linkUrl?: string | null
  isPinned: boolean
  isFeatured?: boolean
  createdAt: string
  updatedAt: string
  author?: { id: string; name: string; profile?: { displayName?: string | null; avatarUrl?: string | null } | null } | null
  media?: Array<{ id?: string; mediaUrl: string; mediaType: 'IMAGE' | 'VIDEO' }>
  poll?: { id: string; options: Array<{ id: string; text: string; votes?: number; _count?: { votes: number } }>; myVote?: string | null } | null
  myReaction?: string | null
  reactionCounts?: Record<string, number>
  commentCount?: number
  reactionUsers?: Array<{ type: string; user: { id: string; name: string; profile?: { displayName?: string | null; avatarUrl?: string | null } | null } }>
  sharedPost?: {
    id: string
    groupId: string
    content: string
    author?: { name?: string; profile?: { displayName?: string | null } | null } | null
    media?: Array<{ id?: string; mediaUrl: string; mediaType: 'IMAGE' | 'VIDEO' }>
  } | null
}
type DiscussionComment = {
  id: string
  postId: string
  authorId: string
  parentId: string | null
  content: string
  createdAt: string
  author?: { id: string; name: string; profile?: { displayName?: string | null; avatarUrl?: string | null } | null } | null
  reactions?: Array<{ type: string; user?: { id: string; name: string; profile?: { displayName?: string | null } | null } }>
  _count?: { replies: number; reactions: number }
  replyCount?: number
}
type DirectoryUser = { id: string; name: string; profile?: { displayName?: string | null; avatarUrl?: string | null; username?: string | null } | null }
type AdminData = {
  requests: Array<{ id: string; user?: { id: string; name: string } }>
  pendingPosts: DiscussionPost[]
  reports: Array<{ id: string; reason: string; category: string }>
  actions: Array<{ id: string; action: string; details?: string | null; createdAt: string }>
  bans: Array<{ id: string; userId: string; reason?: string | null; user?: { id: string; name: string } }>
}
type Invitation = { id: string; group: { id: string; name: string }; inviter?: { name: string } }
type ReactionListEntry = { id: string; type: string; user: { id: string; name: string; profile?: { displayName?: string | null } | null } }

const categories = ['General', 'Arts & culture', 'Business', 'Education', 'Entertainment', 'Food & drink', 'Gaming', 'Health & wellness', 'Hobbies', 'Local', 'Parenting', 'Science & technology', 'Sports', 'Travel']
const reactionEmojis: Record<string, string> = { LIKE: '👍', LOVE: '❤️', LAUGH: '😄', SAD: '😢', ANGRY: '😠' }

function isManager(role: Role | null) {
  return role === 'OWNER' || role === 'ADMIN' || role === 'MODERATOR'
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export function DiscussionGroupsPage() {
  const { groupId } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [groups, setGroups] = useState<Group[]>([])
  const [selected, setSelected] = useState<Group | null>(null)
  const [nextPostCursor, setNextPostCursor] = useState<string | null>(null)
  const [postSort, setPostSort] = useState<'relevant' | 'newest'>('relevant')
  const [filter, setFilter] = useState<'discover' | 'popular' | 'suggested' | 'joined' | 'managed'>('discover')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [query, setQuery] = useState('')
  const [searchValue, setSearchValue] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [groupForm, setGroupForm] = useState({ name: '', description: '', category: 'General', privacy: 'PUBLIC' as Group['privacy'], visibility: 'VISIBLE' as Group['visibility'], membershipApproval: false, postApproval: false, rules: '' })
  const [groupImage, setGroupImage] = useState<File | null>(null)
  const [groupAvatar, setGroupAvatar] = useState<File | null>(null)
  const [postType, setPostType] = useState<DiscussionPost['type']>('TEXT')
  const [postText, setPostText] = useState('')
  const [postLink, setPostLink] = useState('')
  const [postFiles, setPostFiles] = useState<File[]>([])
  const [pollOptions, setPollOptions] = useState(['', ''])
  const [comments, setComments] = useState<Record<string, DiscussionComment[]>>({})
  const [commentCursors, setCommentCursors] = useState<Record<string, string | null>>({})
  const [commentsOpen, setCommentsOpen] = useState<Record<string, boolean>>({})
  const [commentDraft, setCommentDraft] = useState<Record<string, string>>({})
  const [editingComments, setEditingComments] = useState<Record<string, string>>({})
  const [replyParent, setReplyParent] = useState<string | null>(null)
  const [reactionLists, setReactionLists] = useState<Record<string, ReactionListEntry[]>>({})
  const [reactionListOpen, setReactionListOpen] = useState<Record<string, boolean>>({})
  const [reactionCursors, setReactionCursors] = useState<Record<string, string | null>>({})
  const [postEdit, setPostEdit] = useState<{ id: string; type: DiscussionPost['type']; content: string; linkUrl: string; media: NonNullable<DiscussionPost['media']>; pollOptions: string[] } | null>(null)
  const [postEditFiles, setPostEditFiles] = useState<File[]>([])
  const [shareTargets, setShareTargets] = useState<Group[]>([])
  const [sharingPostId, setSharingPostId] = useState<string | null>(null)
  const [shareTargetId, setShareTargetId] = useState('')
  const [shareCaption, setShareCaption] = useState('')
  const [adminData, setAdminData] = useState<AdminData | null>(null)
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [directory, setDirectory] = useState<DirectoryUser[]>([])
  const [inviteUserId, setInviteUserId] = useState('')
  const [memberSearch, setMemberSearch] = useState('')
  const [tab, setTab] = useState<'feed' | 'about' | 'members' | 'admin'>('feed')

  const loadGroups = useCallback(async (nextFilter = filter, nextQuery = query) => {
    try {
      setLoading(true)
      const params = new URLSearchParams({ filter: nextFilter })
      if (nextQuery.trim()) params.set('q', nextQuery.trim())
      if (categoryFilter) params.set('category', categoryFilter)
      const response = await apiRequest<{ groups: Group[] }>(`/api/discussion-groups?${params}`)
      setGroups(response.groups)
      setError('')
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load Discussion Groups.')
    } finally {
      setLoading(false)
    }
  }, [filter, query, categoryFilter])

  const openGroup = useCallback(async (id: string) => {
    try {
      const response = await apiRequest<{ group: Group; nextCursor: string | null }>(`/api/discussion-groups/${encodeURIComponent(id)}?sort=${postSort}`)
      setSelected(response.group)
      setNextPostCursor(response.nextCursor)
      setError('')
    } catch (loadError) {
      setSelected(null)
      setError(loadError instanceof Error ? loadError.message : 'Unable to open this group.')
    }
  }, [postSort])

  useEffect(() => { void loadGroups() }, [loadGroups])
  useEffect(() => {
    if (groupId) void openGroup(groupId)
  }, [groupId, openGroup])

  const refreshSelected = useCallback(async () => {
    await loadGroups()
    if (groupId) await openGroup(groupId)
  }, [groupId, loadGroups, openGroup])

  const loadMorePosts = async () => {
    if (!selected || !nextPostCursor) return
    try {
      const params = new URLSearchParams({ sort: postSort, cursor: nextPostCursor })
      const result = await apiRequest<{ group: Group; nextCursor: string | null }>(`/api/discussion-groups/${selected.id}?${params}`)
      setSelected((current) => current ? { ...current, posts: [...(current.posts ?? []), ...(result.group.posts ?? [])] } : current)
      setNextPostCursor(result.nextCursor)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load more discussions.')
    }
  }

  const resetGroupForm = () => {
    setGroupForm({ name: '', description: '', category: 'General', privacy: 'PUBLIC', visibility: 'VISIBLE', membershipApproval: false, postApproval: false, rules: '' })
    setGroupImage(null)
    setGroupAvatar(null)
  }

  const createGroup = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      const coverUrl = groupImage ? (await uploadMedia(groupImage)).mediaUrl : undefined
      const avatarUrl = groupAvatar ? (await uploadMedia(groupAvatar)).mediaUrl : undefined
      const result = await apiRequest<{ group: Group }>('/api/discussion-groups', {
        method: 'POST',
        body: JSON.stringify({
          ...groupForm,
          coverUrl, avatarUrl,
          rules: groupForm.rules.split('\n').map((rule) => rule.trim()).filter(Boolean),
        }),
      })
      setShowCreate(false)
      resetGroupForm()
      await loadGroups('discover', '')
      navigate(`/discussion-groups/${result.group.id}`)
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create the group.')
    } finally {
      setBusy(false)
    }
  }

  const saveGroup = async (event: FormEvent) => {
    event.preventDefault()
    if (!selected) return
    setBusy(true)
    try {
      const coverUrl = groupImage ? (await uploadMedia(groupImage)).mediaUrl : selected.coverUrl
      const avatarUrl = groupAvatar ? (await uploadMedia(groupAvatar)).mediaUrl : selected.avatarUrl
      await apiRequest(`/api/discussion-groups/${selected.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...groupForm, coverUrl, avatarUrl,
          rules: groupForm.rules.split('\n').map((rule) => rule.trim()).filter(Boolean),
        }),
      })
      setEditing(false)
      setGroupImage(null)
      setGroupAvatar(null)
      await refreshSelected()
      setNotice('Group settings saved.')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save group settings.')
    } finally {
      setBusy(false)
    }
  }

  const startEditing = () => {
    if (!selected) return
    setGroupForm({
      name: selected.name, description: selected.description, category: selected.category, privacy: selected.privacy,
      visibility: selected.visibility, membershipApproval: selected.membershipApproval, postApproval: selected.postApproval,
      rules: selected.rules.join('\n'),
    })
    setEditing(true)
  }

  const joinGroup = async (id: string) => {
    try {
      const result = await apiRequest<{ joined?: boolean; requested?: boolean }>(`/api/discussion-groups/${id}/join`, { method: 'POST' })
      setNotice(result.requested ? 'Your membership request was sent.' : 'You joined the group.')
      await refreshSelected()
    } catch (joinError) {
      setError(joinError instanceof Error ? joinError.message : 'Unable to join this group.')
    }
  }

  const leaveGroup = async () => {
    if (!selected || !window.confirm(`Leave ${selected.name}?`)) return
    try {
      await apiRequest(`/api/discussion-groups/${selected.id}/leave`, { method: 'POST' })
      navigate('/discussion-groups')
      await loadGroups()
    } catch (leaveError) {
      setError(leaveError instanceof Error ? leaveError.message : 'Unable to leave this group.')
    }
  }

  const deleteGroup = async () => {
    if (!selected) return
    const confirmName = window.prompt(`Type "${selected.name}" to permanently delete this group and its discussion content.`)
    if (confirmName !== selected.name) return
    try {
      await apiRequest(`/api/discussion-groups/${selected.id}`, { method: 'DELETE', body: JSON.stringify({ confirmName }) })
      navigate('/discussion-groups')
      await loadGroups()
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete the group.')
    }
  }

  const uploadPost = async (event: FormEvent) => {
    event.preventDefault()
    if (!selected) return
    setBusy(true)
    try {
      const media = await Promise.all(postFiles.map(async (file) => ({
        url: file.type.startsWith('video/') ? (await uploadVideo(file)).mediaUrl : (await uploadMedia(file)).mediaUrl,
        type: file.type.startsWith('video/') ? 'VIDEO' as const : 'IMAGE' as const,
      })))
      await apiRequest(`/api/discussion-groups/${selected.id}/posts`, {
        method: 'POST',
        body: JSON.stringify({
          type: postType, content: postText, linkUrl: postLink.trim() || undefined, media,
          pollOptions: postType === 'POLL' ? pollOptions.map((option) => option.trim()).filter(Boolean) : undefined,
        }),
      })
      setPostText('')
      setPostLink('')
      setPostFiles([])
      setPollOptions(['', ''])
      setPostType('TEXT')
      await refreshSelected()
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : 'Unable to publish your post.')
    } finally {
      setBusy(false)
    }
  }

  const reactToPost = async (post: DiscussionPost) => {
    if (!selected) return
    try {
      const path = `/api/discussion-groups/${selected.id}/posts/${post.id}/reactions`
      if (post.myReaction) await apiRequest(path, { method: 'DELETE' })
      else await apiRequest(path, { method: 'POST', body: JSON.stringify({ type: 'LIKE' }) })
      await refreshSelected()
    } catch (reactionError) {
      setError(reactionError instanceof Error ? reactionError.message : 'Unable to update your reaction.')
    }
  }

  const loadReactionUsers = async (postId: string, cursor?: string) => {
    if (!selected) return
    try {
      const params = new URLSearchParams({ limit: '30' })
      if (cursor) params.set('cursor', cursor)
      const result = await apiRequest<{ reactions: Array<{ id: string; type: string; user: { id: string; name: string; profile?: { displayName?: string | null } | null } }>; nextCursor: string | null }>(
        `/api/discussion-groups/${selected.id}/posts/${postId}/reactions?${params}`,
      )
      setReactionLists((current) => ({ ...current, [postId]: cursor ? [...(current[postId] ?? []), ...result.reactions] : result.reactions }))
      setReactionCursors((current) => ({ ...current, [postId]: result.nextCursor }))
      setReactionListOpen((current) => ({ ...current, [postId]: true }))
    } catch (reactionError) {
      setError(reactionError instanceof Error ? reactionError.message : 'Unable to load people who reacted.')
    }
  }

  const loadComments = async (postId: string, parentId?: string, cursor?: string) => {
    if (!selected) return
    const key = `${postId}:${parentId ?? ''}`
    try {
      const params = new URLSearchParams({ limit: '30' })
      if (parentId) params.set('parentId', parentId)
      if (cursor) params.set('cursor', cursor)
      const result = await apiRequest<{ comments: DiscussionComment[]; nextCursor: string | null }>(`/api/discussion-groups/${selected.id}/posts/${postId}/comments?${params}`)
      setComments((current) => ({ ...current, [key]: cursor ? [...(current[key] ?? []), ...result.comments] : result.comments }))
      setCommentCursors((current) => ({ ...current, [key]: result.nextCursor }))
      setCommentsOpen((current) => ({ ...current, [key]: true }))
    } catch (commentError) {
      setError(commentError instanceof Error ? commentError.message : 'Unable to load comments.')
    }
  }

  const sendComment = async (postId: string, parentId?: string) => {
    if (!selected) return
    const key = `${postId}:${parentId ?? ''}`
    const content = commentDraft[key]?.trim()
    if (!content) return
    try {
      await apiRequest(`/api/discussion-groups/${selected.id}/posts/${postId}/comments`, { method: 'POST', body: JSON.stringify({ content, parentId }) })
      setCommentDraft((current) => ({ ...current, [key]: '' }))
      setReplyParent(null)
      await refreshSelected()
      await loadComments(postId, parentId)
    } catch (commentError) {
      setError(commentError instanceof Error ? commentError.message : 'Unable to add your comment.')
    }
  }

  const saveComment = async (commentId: string, content: string, postId: string, parentId?: string) => {
      if (!selected) return
      try {
        await apiRequest(`/api/discussion-groups/${selected.id}/comments/${commentId}`, { method: 'PATCH', body: JSON.stringify({ content }) })
        setEditingComments((current) => { const next = { ...current }; delete next[commentId]; return next })
        await refreshSelected()
        await loadComments(postId, parentId)
      } catch (editError) {
        setError(editError instanceof Error ? editError.message : 'Unable to edit this comment.')
      }
    }

    const deleteComment = async (commentId: string, postId: string, parentId?: string) => {
      if (!selected) return
      try {
        await apiRequest(`/api/discussion-groups/${selected.id}/comments/${commentId}`, { method: 'DELETE' })
        await refreshSelected()
        await loadComments(postId, parentId)
      } catch (deleteError) {
        setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete this comment.')
      }
    }

  const startPostEdit = (post: DiscussionPost) => {
      setPostEdit({
        id: post.id,
        type: post.type,
        content: post.content,
        linkUrl: post.linkUrl ?? '',
        media: [...(post.media ?? [])],
        pollOptions: post.poll?.options.map((option) => option.text) ?? ['', ''],
      })
      setPostEditFiles([])
    }

  const savePostEdit = async (event: FormEvent) => {
      event.preventDefault()
      if (!selected || !postEdit) return
      setBusy(true)
      try {
        const uploaded = await Promise.all(postEditFiles.map(async (file) => ({
          url: file.type.startsWith('video/') ? (await uploadVideo(file)).mediaUrl : (await uploadMedia(file)).mediaUrl,
          type: file.type.startsWith('video/') ? 'VIDEO' as const : 'IMAGE' as const,
        })))
        await apiRequest(`/api/discussion-groups/${selected.id}/posts/${postEdit.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            type: postEdit.type,
            content: postEdit.content,
            linkUrl: postEdit.linkUrl.trim() || null,
            media: [...postEdit.media.map((item) => ({ url: item.mediaUrl, type: item.mediaType })), ...uploaded],
            ...(postEdit.type === 'POLL' ? { pollOptions: postEdit.pollOptions.map((option) => option.trim()).filter(Boolean) } : {}),
          }),
        })
        setPostEdit(null)
        setPostEditFiles([])
        await refreshSelected()
        setNotice('Post updated.')
      } catch (editError) {
        setError(editError instanceof Error ? editError.message : 'Unable to edit this post.')
      } finally {
        setBusy(false)
      }
    }

  const openShare = async (postId: string) => {
      try {
        const result = await apiRequest<{ groups: Group[] }>('/api/discussion-groups?filter=joined&limit=50')
        const targets = result.groups.filter((group) => group.id !== selected?.id)
        setShareTargets(targets)
        setShareTargetId(targets[0]?.id ?? '')
        setShareCaption('')
        setSharingPostId(postId)
      } catch (shareError) {
        setError(shareError instanceof Error ? shareError.message : 'Unable to load destination groups.')
      }
    }

  const sharePost = async () => {
      if (!selected || !sharingPostId || !shareTargetId) return
      try {
        await apiRequest(`/api/discussion-groups/${selected.id}/posts/${sharingPostId}/share`, {
          method: 'POST',
          body: JSON.stringify({ targetGroupId: shareTargetId, content: shareCaption }),
        })
        setSharingPostId(null)
        setNotice('Post shared to your group.')
      } catch (shareError) {
        setError(shareError instanceof Error ? shareError.message : 'Unable to share this post.')
      }
    }
  const votePoll = async (pollId: string, optionId: string) => {
    if (!selected) return
    try {
      await apiRequest(`/api/discussion-groups/${selected.id}/polls/${pollId}/vote`, { method: 'POST', body: JSON.stringify({ optionId }) })
      await refreshSelected()
    } catch (voteError) {
      setError(voteError instanceof Error ? voteError.message : 'Unable to submit your vote.')
    }
  }

  const loadAdmin = async () => {
    if (!selected) return
    try {
      const result = await apiRequest<AdminData>(`/api/discussion-groups/${selected.id}/admin`)
      setAdminData(result)
    } catch (adminError) {
      setError(adminError instanceof Error ? adminError.message : 'Unable to load group management.')
    }
  }

  const loadInvitations = async () => {
    try {
      const result = await apiRequest<{ invitations: Invitation[] }>('/api/discussion-groups/invitations')
      setInvitations(result.invitations)
    } catch (invitationError) {
      setError(invitationError instanceof Error ? invitationError.message : 'Unable to load group invitations.')
    }
  }

  const respondInvitation = async (invitationId: string, accept: boolean) => {
    try {
      await apiRequest(`/api/discussion-groups/invitations/${invitationId}/respond`, { method: 'POST', body: JSON.stringify({ accept }) })
      await loadInvitations()
      await loadGroups()
    } catch (invitationError) {
      setError(invitationError instanceof Error ? invitationError.message : 'Unable to respond to this invitation.')
    }
  }

  const loadDirectory = async () => {
    try {
      const result = await apiRequest<{ users: DirectoryUser[] }>('/api/users')
      setDirectory(result.users.filter((person) => person.id !== user?.id && !selected?.members?.some((member) => member.userId === person.id)))
    } catch (directoryError) {
      setError(directoryError instanceof Error ? directoryError.message : 'Unable to load members.')
    }
  }

  const searchMembers = async (event: FormEvent) => {
    event.preventDefault()
    if (!selected) return
    try {
      const params = new URLSearchParams({ q: memberSearch, limit: '100' })
      const result = await apiRequest<{ members: NonNullable<Group['members']> }>(`/api/discussion-groups/${selected.id}/members?${params}`)
      setSelected((current) => current ? { ...current, members: result.members } : current)
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : 'Unable to search group members.')
    }
  }

  useEffect(() => {
    if (groupId) return
    let active = true
    void apiRequest<{ invitations: Invitation[] }>('/api/discussion-groups/invitations')
      .then(({ invitations: nextInvitations }) => { if (active) setInvitations(nextInvitations) })
      .catch((invitationError: unknown) => {
        if (active) setError(invitationError instanceof Error ? invitationError.message : 'Unable to load group invitations.')
      })
    return () => { active = false }
  }, [groupId])

  const groupList = useMemo(() => groups, [groups])
  const groupTabs: Array<'feed' | 'about' | 'members' | 'admin'> = ['feed', 'about', 'members']
  if (isManager(selected?.myRole ?? null)) groupTabs.push('admin')

  const respondRequest = async (requestId: string, approve: boolean) => {
    if (!selected) return
    try {
      await apiRequest(`/api/discussion-groups/${selected.id}/requests/${requestId}/decision`, { method: 'POST', body: JSON.stringify({ approve }) })
      await loadAdmin()
      await refreshSelected()
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Unable to update the request.')
    }
  }

  const decidePost = async (postId: string, approve: boolean) => {
    if (!selected) return
    try {
      await apiRequest(`/api/discussion-groups/${selected.id}/posts/${postId}/decision`, { method: 'POST', body: JSON.stringify({ approve }) })
      await loadAdmin()
      await refreshSelected()
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Unable to review this post.')
    }
  }

  const manageMember = async (memberId: string, action: MemberAction) => {
    if (!selected) return
    try {
      await apiRequest(`/api/discussion-groups/${selected.id}/members/${memberId}`, { method: 'PATCH', body: JSON.stringify(action) })
      await refreshSelected()
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Unable to update this member.')
    }
  }

  const removeMember = async (memberId: string) => {
    if (!selected || !window.confirm('Remove this member from the group?')) return
    try {
      await apiRequest(`/api/discussion-groups/${selected.id}/members/${memberId}`, { method: 'DELETE' })
      await refreshSelected()
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Unable to remove this member.')
    }
  }

  const reviewReport = async (reportId: string, status: 'RESOLVED' | 'REJECTED') => {
    if (!selected) return
    try {
      await apiRequest(`/api/discussion-groups/${selected.id}/reports/${reportId}/decision`, { method: 'POST', body: JSON.stringify({ status }) })
      await loadAdmin()
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Unable to review this report.')
    }
  }

  const inviteMember = async () => {
    if (!selected || !inviteUserId) return
    try {
      await apiRequest(`/api/discussion-groups/${selected.id}/invitations`, { method: 'POST', body: JSON.stringify({ userId: inviteUserId }) })
      setInviteUserId('')
      setNotice('Invitation sent.')
    } catch (inviteError) {
      setError(inviteError instanceof Error ? inviteError.message : 'Unable to send the invitation.')
    }
  }

  const reportPost = async (postId: string) => {
    if (!selected) return
    const reason = window.prompt('Why are you reporting this post?')
    if (!reason || reason.trim().length < 4) return
    try {
      await apiRequest(`/api/discussion-groups/${selected.id}/posts/${postId}/report`, { method: 'POST', body: JSON.stringify({ category: 'OTHER', reason: reason.trim() }) })
      setNotice('Report sent to group moderators.')
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : 'Unable to report this post.')
    }
  }

  const performSearch = (event: FormEvent) => {
    event.preventDefault()
    setQuery(searchValue)
  }

  const renderMentionText = (content: string) => content.split(/(@[a-zA-Z0-9_.-]{2,32})/g).map((part, index) => {
    if (!part.startsWith('@')) return part
    const handle = part.slice(1).toLowerCase()
    const member = selected?.members?.find((entry) => entry.user?.profile?.username?.replace(/^@/, '').toLowerCase() === handle)
    return member
      ? <Link key={`${part}-${index}`} to={`/profile/${encodeURIComponent(member.userId)}`} className="font-semibold text-blue-700 hover:underline">{part}</Link>
      : part
  })

  const setFilterAndLoad = (nextFilter: typeof filter) => {
    setFilter(nextFilter)
  }

  const renderGroupForm = (onSubmit: (event: FormEvent) => void, submitLabel: string) => (
    <form onSubmit={onSubmit} className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2">
      <label className="text-sm font-medium text-slate-700">Group name
        <input required minLength={2} maxLength={80} value={groupForm.name} onChange={(event) => setGroupForm((form) => ({ ...form, name: event.target.value }))} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 font-normal" />
      </label>
      <label className="text-sm font-medium text-slate-700">Category
        <select value={groupForm.category} onChange={(event) => setGroupForm((form) => ({ ...form, category: event.target.value }))} className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 font-normal">
          {categories.map((category) => <option key={category}>{category}</option>)}
        </select>
      </label>
      <label className="text-sm font-medium text-slate-700 sm:col-span-2">Description
        <textarea maxLength={2000} rows={3} value={groupForm.description} onChange={(event) => setGroupForm((form) => ({ ...form, description: event.target.value }))} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 font-normal" />
      </label>
      <label className="text-sm font-medium text-slate-700">Privacy
        <select value={groupForm.privacy} onChange={(event) => setGroupForm((form) => ({ ...form, privacy: event.target.value as Group['privacy'], membershipApproval: event.target.value === 'PRIVATE' ? true : form.membershipApproval }))} className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 font-normal">
          <option value="PUBLIC">Public</option><option value="PRIVATE">Private</option>
        </select>
      </label>
      <label className="text-sm font-medium text-slate-700">Discoverability
        <select value={groupForm.visibility} onChange={(event) => setGroupForm((form) => ({ ...form, visibility: event.target.value as Group['visibility'] }))} className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 font-normal">
          <option value="VISIBLE">Visible in search</option><option value="HIDDEN">Hidden</option>
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={groupForm.membershipApproval} onChange={(event) => setGroupForm((form) => ({ ...form, membershipApproval: event.target.checked }))} />Approve join requests</label>
      <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={groupForm.postApproval} onChange={(event) => setGroupForm((form) => ({ ...form, postApproval: event.target.checked }))} />Approve member posts</label>
      <label className="text-sm font-medium text-slate-700 sm:col-span-2">Group rules (one per line)
        <textarea maxLength={5000} rows={3} value={groupForm.rules} onChange={(event) => setGroupForm((form) => ({ ...form, rules: event.target.value }))} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 font-normal" />
      </label>
      <label className="flex items-center gap-2 text-sm text-slate-700 sm:col-span-2"><ImagePlus className="h-4 w-4" />Cover image (JPEG, PNG, or WebP)
        <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setGroupImage(event.target.files?.[0] ?? null)} className="max-w-full text-xs" />
      </label>
      <label className="flex items-center gap-2 text-sm text-slate-700 sm:col-span-2"><ImagePlus className="h-4 w-4" />Group profile image (optional)
        <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setGroupAvatar(event.target.files?.[0] ?? null)} className="max-w-full text-xs" />
      </label>
      {groupImage || groupAvatar ? <p className="text-xs text-slate-500 sm:col-span-2">Selected: {[groupImage?.name, groupAvatar?.name].filter(Boolean).join(', ')}</p> : null}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" variant="primary" size="sm" disabled={busy || groupForm.name.trim().length < 2}>{busy ? 'Saving…' : submitLabel}</Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => { setShowCreate(false); setEditing(false); resetGroupForm() }}>Cancel</Button>
      </div>
    </form>
  )

  return (
    <main className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <header className="rounded-3xl bg-gradient-to-br from-[#10214f] via-blue-800 to-indigo-700 p-5 text-white shadow-lg sm:p-7">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-200">Find your people</p>
            <h1 className="mt-1 text-2xl font-bold sm:text-3xl">Discussion Groups</h1>
            <p className="mt-1 text-sm text-blue-100">Share ideas, post updates, and build a community together.</p>
          </div>
          <Button variant="secondary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => { resetGroupForm(); setShowCreate((open) => !open) }}>Create group</Button>
        </div>
        {!groupId ? (
          <>
            <form onSubmit={performSearch} className="mt-5 flex flex-wrap gap-2">
              <label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl bg-white px-3 text-slate-500">
                <Search className="h-4 w-4 shrink-0" />
                <input value={searchValue} onChange={(event) => setSearchValue(event.target.value)} placeholder="Search groups by name or description" className="min-w-0 flex-1 py-2.5 text-sm text-slate-900 outline-none" />
              </label>
              <select aria-label="Filter by category" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)} className="order-3 w-full rounded-xl bg-white px-3 py-2 text-sm text-slate-800 sm:order-none sm:w-auto">
                <option value="">All categories</option>{categories.map((category) => <option key={category} value={category}>{category}</option>)}
              </select>
              <Button type="submit" variant="secondary" size="sm">Search</Button>
            </form>
            <nav aria-label="Discussion group filters" className="mt-4 flex gap-2">
              {([['discover', 'Recently created'], ['popular', 'Popular'], ['suggested', 'Suggested'], ['joined', 'Your groups'], ['managed', 'Managed']] as const).map(([value, label]) => (
                <button key={value} type="button" onClick={() => setFilterAndLoad(value)} className={`rounded-full px-4 py-2 text-sm font-semibold ${filter === value ? 'bg-white text-blue-800' : 'bg-white/10 text-white hover:bg-white/20'}`}>{label}</button>
              ))}
            </nav>
          </>
        ) : <Link to="/discussion-groups" onClick={() => setTab('feed')} className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-sky-100 hover:text-white"><ArrowLeft className="h-4 w-4" />All Discussion Groups</Link>}
      </header>

      {error ? <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}<button type="button" onClick={() => setError('')} className="ml-3 font-semibold underline">Dismiss</button></div> : null}
      {notice ? <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{notice}<button type="button" onClick={() => setNotice('')} className="ml-3 font-semibold underline">Dismiss</button></div> : null}
      {showCreate ? renderGroupForm(createGroup, 'Create group') : null}
      {!groupId && invitations.length ? <section className="rounded-2xl border border-blue-100 bg-blue-50/60 p-4"><h2 className="font-semibold text-slate-900">Group invitations</h2><ul className="mt-2 divide-y divide-blue-100">{invitations.map((invitation) => <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><p className="text-sm text-slate-700"><strong>{invitation.inviter?.name ?? 'A member'}</strong> invited you to <strong>{invitation.group.name}</strong>.</p><div className="flex gap-2"><Button variant="primary" size="sm" onClick={() => void respondInvitation(invitation.id, true)}>Accept</Button><Button variant="secondary" size="sm" onClick={() => void respondInvitation(invitation.id, false)}>Decline</Button></div></li>)}</ul></section> : null}

      {!groupId ? (
        <section>
          {loading ? <p role="status" className="p-8 text-center text-sm text-slate-500">Loading Discussion Groups…</p> : groupList.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center">
              <Users className="mx-auto h-8 w-8 text-slate-400" />
              <h2 className="mt-3 font-semibold text-slate-900">No groups found</h2>
              <p className="mt-1 text-sm text-slate-500">{query ? 'Try another search.' : 'Create the first group in your community.'}</p>
              <Button variant="primary" size="sm" className="mt-4" onClick={() => setShowCreate(true)}>Create a group</Button>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {groupList.map((group) => (
                <article key={group.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                  <Link to={`/discussion-groups/${group.id}`} onClick={() => setTab('feed')} className="block">
                    <div className="h-28 bg-gradient-to-br from-blue-100 to-indigo-100">
                      {group.coverUrl ? <img src={resolveMediaUrl(group.coverUrl)} alt="" className="h-full w-full object-cover" /> : null}
                    </div>
                    <div className="px-4 pb-2">
                      <div className="-mt-7 flex items-end gap-3">
                            <div className="rounded-full border-4 border-white"><Avatar src={resolveMediaUrl(group.avatarUrl)} alt={group.name} size="lg" /></div>
                        <div className="min-w-0 pb-1">
                          <h2 className="truncate font-semibold text-slate-900">{group.name}</h2>
                          <p className="text-xs text-slate-500">{group.memberCount} members · {group.category}</p>
                        </div>
                      </div>
                      <p className="mt-3 line-clamp-2 min-h-10 text-sm text-slate-600">{group.description || 'A NOVACHAT Discussion Group.'}</p>
                    </div>
                  </Link>
                  <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3">
                    <span className="inline-flex items-center gap-1 text-xs text-slate-500">{group.privacy === 'PRIVATE' ? <LockKeyhole className="h-3.5 w-3.5" /> : <Users className="h-3.5 w-3.5" />}{group.privacy === 'PRIVATE' ? 'Private' : 'Public'}</span>
                    {group.joined ? <span className="text-xs font-semibold text-emerald-700">Joined</span> : <Button variant="primary" size="sm" onClick={() => void joinGroup(group.id)}>{group.membershipApproval || group.privacy === 'PRIVATE' ? 'Request to join' : 'Join'}</Button>}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : selected ? (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.55fr)_minmax(280px,0.8fr)]">
          <section className="min-w-0 space-y-4">
            <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="relative h-40 bg-gradient-to-br from-blue-100 to-indigo-200 sm:h-56">
                {selected.coverUrl ? <img src={resolveMediaUrl(selected.coverUrl)} alt="" className="h-full w-full object-cover" /> : null}
              </div>
              <div className="px-4 pb-4 sm:px-6">
                <div className="-mt-8 flex flex-wrap items-end justify-between gap-3">
                  <div className="flex min-w-0 items-end gap-3">
                    <div className="rounded-full border-4 border-white"><Avatar src={resolveMediaUrl(selected.avatarUrl)} alt={selected.name} size="lg" /></div>
                    <div className="min-w-0 pb-1">
                      <h2 className="truncate text-xl font-bold text-slate-900 sm:text-2xl">{selected.name}</h2>
                      <p className="text-sm text-slate-500">{selected.memberCount} members · {selected.category} · {selected.privacy.toLowerCase()}</p>
                    </div>
                  </div>
                  {!selected.joined ? <Button variant="primary" size="sm" onClick={() => void joinGroup(selected.id)}>{selected.membershipApproval || selected.privacy === 'PRIVATE' ? 'Request to join' : 'Join group'}</Button> : null}
                  {selected.joined && selected.myRole !== 'OWNER' ? <Button variant="secondary" size="sm" onClick={() => void leaveGroup()}>Leave group</Button> : null}
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm text-slate-600">{selected.description}</p>
                <nav aria-label="Group sections" className="mt-4 flex gap-1 overflow-x-auto border-t border-slate-100 pt-3">
                  {groupTabs.map((value) => (
                    <button key={value} type="button" onClick={() => { setTab(value); if (value === 'admin') void loadAdmin() }} className={`rounded-lg px-3 py-2 text-sm font-semibold capitalize ${tab === value ? 'bg-blue-50 text-blue-700' : 'text-slate-500 hover:bg-slate-50'}`}>{value === 'admin' ? 'Manage' : value}</button>
                  ))}
                  {selected.myRole === 'OWNER' || selected.myRole === 'ADMIN' ? <button type="button" onClick={startEditing} className="ml-auto rounded-lg px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">Edit</button> : null}
                </nav>
              </div>
            </article>

            {editing ? renderGroupForm(saveGroup, 'Save changes') : null}

            {tab === 'feed' ? (
              <>
                <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2">
                  <span className="text-sm font-semibold text-slate-700">Group discussions</span>
                  <label className="flex items-center gap-2 text-xs text-slate-500">Sort
                    <select value={postSort} onChange={(event) => setPostSort(event.target.value as typeof postSort)} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-700">
                      <option value="relevant">Relevant</option><option value="newest">Newest</option>
                    </select>
                  </label>
                </div>
                {selected.joined ? (
                  <form onSubmit={uploadPost} className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                    <h3 className="font-semibold text-slate-900">Start a discussion</h3>
                    <div className="flex flex-wrap gap-2">
                      <select aria-label="Post type" value={postType} onChange={(event) => setPostType(event.target.value as DiscussionPost['type'])} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
                        <option value="TEXT">Post</option><option value="QUESTION">Question</option><option value="IMAGE">Photo</option><option value="VIDEO">Video</option><option value="LINK">Link</option><option value="POLL">Poll</option>
                        {isManager(selected.myRole) ? <option value="ANNOUNCEMENT">Announcement</option> : null}
                      </select>
                      <label className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600"><ImagePlus className="h-4 w-4" />Add media<input type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/ogg" onChange={(event) => setPostFiles(Array.from(event.target.files ?? []).slice(0, 10))} className="sr-only" /></label>
                      <span className="self-center text-xs text-slate-500">{postFiles.map((file) => file.name).join(', ')}</span>
                    </div>
                    <textarea aria-label="Post text" value={postText} onChange={(event) => setPostText(event.target.value)} maxLength={5000} rows={3} placeholder={postType === 'QUESTION' ? 'Ask your group a question…' : 'Share with your group…'} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
                    {selected.members?.some((member) => member.user?.profile?.username) ? <label className="flex items-center gap-2 text-xs text-slate-500">Mention a member
                      <select aria-label="Mention a group member in the post" value="" onChange={(event) => {
                        const handle = selected.members?.find((member) => member.userId === event.target.value)?.user?.profile?.username?.replace(/^@/, '')
                        if (handle) setPostText((current) => `${current}${current && !/\s$/.test(current) ? ' ' : ''}@${handle} `)
                      }} className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm">
                        <option value="">Select member</option>{selected.members?.filter((member) => member.user?.profile?.username).map((member) => <option key={member.userId} value={member.userId}>{member.user?.profile?.displayName || member.user?.name} · @{member.user?.profile?.username?.replace(/^@/, '')}</option>)}
                      </select>
                    </label> : null}
                    {postType === 'LINK' ? <input type="url" required value={postLink} onChange={(event) => setPostLink(event.target.value)} placeholder="https://example.com" className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" /> : null}
                    {postType === 'POLL' ? <div className="space-y-2">{pollOptions.map((option, index) => <div key={index} className="flex gap-2"><input value={option} onChange={(event) => setPollOptions((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} maxLength={120} placeholder={`Option ${index + 1}`} className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm" />{pollOptions.length > 2 ? <button type="button" onClick={() => setPollOptions((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label="Remove poll option"><X className="h-4 w-4" /></button> : null}</div>)}{pollOptions.length < 10 ? <button type="button" onClick={() => setPollOptions((current) => [...current, ''])} className="text-sm font-semibold text-blue-700">Add option</button> : null}</div> : null}
                    <div className="flex justify-end"><Button type="submit" variant="primary" size="sm" disabled={busy || !(postText.trim() || postFiles.length || postType === 'POLL' && pollOptions.filter((option) => option.trim()).length >= 2 || postType === 'LINK' && postLink.trim())}>{busy ? 'Publishing…' : 'Publish'}</Button></div>
                  </form>
                ) : selected.privacy === 'PUBLIC' ? <p className="rounded-xl bg-blue-50 p-4 text-sm text-blue-800">Join this group to take part in the discussion.</p> : null}
                {(selected.posts ?? []).map((post) => (
                  <article key={post.id} className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                    <header className="flex items-start gap-3">
                      <Avatar src={resolveMediaUrl(post.author?.profile?.avatarUrl)} alt={post.author?.name ?? 'Group member'} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-slate-900">{post.author?.profile?.displayName || post.author?.name || 'Group member'}{post.isFeatured ? <span className="ml-2 inline-flex items-center gap-1 text-xs font-medium text-amber-700">Featured</span> : null}{post.isPinned ? <span className="ml-2 inline-flex items-center gap-1 text-xs font-medium text-blue-700"><Pin className="h-3 w-3" />Pinned</span> : null}</p>
                        <time className="text-xs text-slate-500">{formatTime(post.createdAt)}</time>
                      </div>
                      <details className="relative">
                        <summary aria-label="Post actions" className="cursor-pointer list-none rounded-lg px-2 py-1 text-slate-500 hover:bg-slate-100"><ChevronDown className="h-4 w-4" /></summary>
                        <div className="absolute right-0 z-10 mt-1 min-w-36 rounded-xl border border-slate-200 bg-white p-1 shadow-lg">
                          {isManager(selected.myRole) ? <button type="button" onClick={() => void apiRequest(`/api/discussion-groups/${selected.id}/posts/${post.id}/pin`, { method: 'PATCH', body: JSON.stringify({ pinned: !post.isPinned }) }).then(refreshSelected).catch((actionError) => setError(actionError instanceof Error ? actionError.message : 'Unable to update pin.'))} className="block w-full rounded-lg px-3 py-2 text-left text-xs hover:bg-slate-50">{post.isPinned ? 'Unpin post' : 'Pin post'}</button> : null}
                          {isManager(selected.myRole) ? <button type="button" onClick={() => void apiRequest(`/api/discussion-groups/${selected.id}/posts/${post.id}/feature`, { method: 'PATCH', body: JSON.stringify({ featured: !post.isFeatured }) }).then(refreshSelected).catch((actionError) => setError(actionError instanceof Error ? actionError.message : 'Unable to update featured post.'))} className="block w-full rounded-lg px-3 py-2 text-left text-xs hover:bg-slate-50">{post.isFeatured ? 'Remove featured status' : 'Feature post'}</button> : null}
                          {post.authorId === user?.id || isManager(selected.myRole) ? <button type="button" onClick={() => startPostEdit(post)} className="block w-full rounded-lg px-3 py-2 text-left text-xs hover:bg-slate-50">Edit post</button> : null}
                          {post.authorId === user?.id || isManager(selected.myRole) ? <button type="button" onClick={() => { if (window.confirm('Delete this post and its discussion?')) void apiRequest(`/api/discussion-groups/${selected.id}/posts/${post.id}`, { method: 'DELETE' }).then(refreshSelected).catch((actionError) => setError(actionError instanceof Error ? actionError.message : 'Unable to delete post.')) }} className="block w-full rounded-lg px-3 py-2 text-left text-xs text-rose-700 hover:bg-rose-50">Delete post</button> : null}
                          {selected.privacy === 'PUBLIC' && selected.visibility === 'VISIBLE' ? <button type="button" onClick={() => void openShare(post.id)} className="block w-full rounded-lg px-3 py-2 text-left text-xs hover:bg-slate-50">Share to a group</button> : null}
                          <button type="button" onClick={() => void reportPost(post.id)} className="block w-full rounded-lg px-3 py-2 text-left text-xs hover:bg-slate-50">Report post</button>
                        </div>
                      </details>
                    </header>
                    {postEdit?.id === post.id ? <form onSubmit={savePostEdit} className="space-y-2 rounded-xl border border-blue-100 bg-blue-50/50 p-3">
                      <label className="block text-xs font-semibold text-slate-600">Post type
                        <select value={postEdit.type} onChange={(event) => setPostEdit((current) => current ? { ...current, type: event.target.value as DiscussionPost['type'] } : current)} className="mt-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm">
                          {(['TEXT', 'QUESTION', 'IMAGE', 'VIDEO', 'LINK', 'POLL'] as const).map((type) => <option key={type} value={type}>{type[0] + type.slice(1).toLowerCase()}</option>)}
                          {isManager(selected.myRole) ? <option value="ANNOUNCEMENT">Announcement</option> : null}
                        </select>
                      </label>
                      <textarea aria-label="Edit post text" value={postEdit.content} maxLength={5000} onChange={(event) => setPostEdit((current) => current ? { ...current, content: event.target.value } : current)} rows={3} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
                      {postEdit.type === 'LINK' ? <input aria-label="Edit post link" type="url" required value={postEdit.linkUrl} onChange={(event) => setPostEdit((current) => current ? { ...current, linkUrl: event.target.value } : current)} placeholder="https://example.com" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" /> : null}
                      {postEdit.type === 'POLL' ? <div className="space-y-2">{postEdit.pollOptions.map((option, index) => <div key={index} className="flex gap-2"><input aria-label={`Edit poll option ${index + 1}`} value={option} maxLength={120} onChange={(event) => setPostEdit((current) => current ? { ...current, pollOptions: current.pollOptions.map((item, itemIndex) => itemIndex === index ? event.target.value : item) } : current)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />{postEdit.pollOptions.length > 2 ? <button type="button" aria-label={`Remove poll option ${index + 1}`} onClick={() => setPostEdit((current) => current ? { ...current, pollOptions: current.pollOptions.filter((_, itemIndex) => itemIndex !== index) } : current)}><X className="h-4 w-4" /></button> : null}</div>)}{postEdit.pollOptions.length < 10 ? <button type="button" onClick={() => setPostEdit((current) => current ? { ...current, pollOptions: [...current.pollOptions, ''] } : current)} className="text-xs font-semibold text-blue-700">Add option</button> : null}</div> : null}
                      <div className="flex flex-wrap gap-2">{postEdit.media.map((media, index) => <span key={media.id ?? media.mediaUrl} className="inline-flex items-center gap-1 rounded-lg bg-white px-2 py-1 text-xs text-slate-600">Attachment {index + 1}<button type="button" aria-label={`Remove attachment ${index + 1}`} onClick={() => setPostEdit((current) => current ? { ...current, media: current.media.filter((item) => item !== media) } : current)}><X className="h-3 w-3" /></button></span>)}</div>
                      <label className="block text-xs font-medium text-slate-600">Add/replace media
                        <input type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/ogg" onChange={(event) => setPostEditFiles(Array.from(event.target.files ?? []).slice(0, 10))} className="mt-1 block max-w-full text-xs" />
                      </label>
                      <div className="flex justify-end gap-2"><Button type="button" variant="secondary" size="sm" onClick={() => setPostEdit(null)}>Cancel</Button><Button type="submit" variant="primary" size="sm" disabled={busy}>{busy ? 'Saving…' : 'Save post'}</Button></div>
                    </form> : null}
                    {post.content ? <p className="whitespace-pre-wrap text-sm leading-6 text-slate-800">{renderMentionText(post.content)}</p> : null}
                    {post.sharedPost ? <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3"><p className="text-xs font-semibold text-slate-700">Shared from {post.sharedPost.author?.profile?.displayName || post.sharedPost.author?.name || 'another group member'}</p>{post.sharedPost.content ? <p className="whitespace-pre-wrap text-sm text-slate-700">{post.sharedPost.content}</p> : null}{post.sharedPost.media?.map((media, index) => media.mediaType === 'VIDEO' ? <video key={media.id ?? index} src={resolveMediaUrl(media.mediaUrl)} controls className="max-h-72 w-full rounded-lg bg-black" /> : <img key={media.id ?? index} src={resolveMediaUrl(media.mediaUrl)} alt="Shared group post attachment" className="max-h-72 w-full rounded-lg object-cover" />)}</div> : null}
                    {post.linkUrl ? <a href={post.linkUrl} target="_blank" rel="noreferrer" className="block break-all rounded-xl bg-slate-50 p-3 text-sm font-medium text-blue-700 underline">{post.linkUrl}</a> : null}
                    {post.media?.length ? <div className={`grid gap-1 overflow-hidden rounded-xl ${post.media.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>{post.media.map((media, index) => media.mediaType === 'VIDEO' ? <video key={media.id ?? index} src={resolveMediaUrl(media.mediaUrl)} controls className="max-h-96 w-full rounded-xl bg-black" /> : <img key={media.id ?? index} src={resolveMediaUrl(media.mediaUrl)} alt="Group post attachment" className="max-h-96 w-full rounded-xl object-cover" />)}</div> : null}
                    {post.poll ? <div className="space-y-2 rounded-xl bg-slate-50 p-3">{post.poll.options.map((option) => <button key={option.id} type="button" disabled={!selected.joined} onClick={() => void votePoll(post.poll!.id, option.id)} className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm ${post.poll?.myVote === option.id ? 'border-blue-300 bg-blue-50 text-blue-800' : 'border-slate-200 bg-white text-slate-700'}`}><span>{option.text}</span><span className="text-xs text-slate-500">{option._count?.votes ?? option.votes ?? 0}</span></button>)}</div> : null}
                    <div className="flex items-center gap-4 border-t border-slate-100 pt-2">
                      <button type="button" disabled={!selected.joined} onClick={() => void reactToPost(post)} className={`inline-flex items-center gap-1.5 text-sm ${post.myReaction ? 'font-semibold text-blue-700' : 'text-slate-500 hover:text-blue-700'}`}><ThumbsUp className="h-4 w-4" />{post.myReaction ? reactionEmojis[post.myReaction] : 'Like'} <span>{Object.values(post.reactionCounts ?? {}).reduce((sum, count) => sum + count, 0)}</span></button>
                      <button type="button" onClick={() => commentsOpen[`${post.id}:`] ? setCommentsOpen((current) => ({ ...current, [`${post.id}:`]: false })) : void loadComments(post.id)} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-blue-700"><MessageCircle className="h-4 w-4" />{post.commentCount ?? 0} comments</button>
                    </div>
                    {post.reactionUsers?.length ? <button type="button" onClick={() => reactionListOpen[post.id] ? setReactionListOpen((current) => ({ ...current, [post.id]: false })) : void loadReactionUsers(post.id)} className="text-left text-xs text-slate-500 hover:text-blue-700">Reacted by {(reactionLists[post.id] ?? post.reactionUsers).map((reaction) => reaction.user.profile?.displayName || reaction.user.name).join(', ')}</button> : null}
                    {reactionListOpen[post.id] ? <div className="space-y-1 rounded-lg bg-slate-50 p-2 text-xs text-slate-600">{(reactionLists[post.id] ?? []).map((reaction) => <p key={reaction.id}>{reaction.user.profile?.displayName || reaction.user.name} · {reactionEmojis[reaction.type] ?? reaction.type}</p>)}{reactionCursors[post.id] ? <button type="button" onClick={() => void loadReactionUsers(post.id, reactionCursors[post.id] ?? undefined)} className="font-semibold text-blue-700">Load more reactions</button> : null}</div> : null}
                    {sharingPostId === post.id ? <div className="space-y-2 rounded-xl border border-blue-100 bg-blue-50/60 p-3"><h4 className="text-sm font-semibold text-slate-800">Share to another group</h4>{shareTargets.length ? <><select aria-label="Choose destination group" value={shareTargetId} onChange={(event) => setShareTargetId(event.target.value)} className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">{shareTargets.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select><textarea aria-label="Share caption" value={shareCaption} maxLength={2000} onChange={(event) => setShareCaption(event.target.value)} placeholder="Add a note (optional)" className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" /><div className="flex justify-end gap-2"><Button variant="secondary" size="sm" onClick={() => setSharingPostId(null)}>Cancel</Button><Button variant="primary" size="sm" onClick={() => void sharePost()}>Share</Button></div></> : <p className="text-xs text-slate-600">Join another group before sharing this post.</p>}</div> : null}
                    {commentsOpen[`${post.id}:`] ? (
                      <div className="space-y-3 border-t border-slate-100 pt-3">
                        {(comments[`${post.id}:`] ?? []).map((comment) => (
                          <div key={comment.id} className="flex gap-2">
                            <Avatar src={resolveMediaUrl(comment.author?.profile?.avatarUrl)} alt={comment.author?.name ?? 'Member'} size="sm" />
                            <div className="min-w-0 flex-1">
                              <div className="rounded-xl bg-slate-50 px-3 py-2"><p className="text-xs font-semibold text-slate-800">{comment.author?.profile?.displayName || comment.author?.name || 'Group member'}</p>{editingComments[comment.id] !== undefined ? <div className="mt-1 space-y-2"><textarea aria-label="Edit comment" value={editingComments[comment.id]} onChange={(event) => setEditingComments((current) => ({ ...current, [comment.id]: event.target.value }))} maxLength={2000} className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm" /><div className="flex gap-2"><button type="button" onClick={() => void saveComment(comment.id, editingComments[comment.id], post.id, comment.parentId ?? undefined)} className="font-semibold text-blue-700">Save</button><button type="button" onClick={() => setEditingComments((current) => { const next = { ...current }; delete next[comment.id]; return next })}>Cancel</button></div></div> : <p className="whitespace-pre-wrap text-sm text-slate-700">{renderMentionText(comment.content)}</p>}</div>
                              <div className="mt-1 flex gap-3 pl-2 text-xs text-slate-500">
                                <button type="button" disabled={!selected.joined} onClick={() => void apiRequest(`/api/discussion-groups/${selected.id}/comments/${comment.id}/reactions`, { method: 'POST', body: JSON.stringify({ type: 'LIKE' }) }).then(() => loadComments(post.id)).catch((actionError) => setError(actionError instanceof Error ? actionError.message : 'Unable to react.'))}>Like {comment._count?.reactions ?? comment.reactions?.length ?? 0}</button>
                                <button type="button" onClick={() => { setReplyParent(replyParent === comment.id ? null : comment.id); if (!commentsOpen[`${post.id}:${comment.id}`]) void loadComments(post.id, comment.id) }}>Reply ({comment._count?.replies ?? comment.replyCount ?? 0})</button>
                                {comment.authorId === user?.id || isManager(selected.myRole) ? <button type="button" onClick={() => setEditingComments((current) => ({ ...current, [comment.id]: comment.content }))}>Edit</button> : null}
                                {comment.authorId === user?.id || isManager(selected.myRole) ? <button type="button" onClick={() => { if (window.confirm('Delete this comment and replies?')) void deleteComment(comment.id, post.id) }} className="text-rose-600">Delete</button> : null}
                              </div>
                              {comment.reactions?.length ? <p className="mt-1 pl-2 text-[11px] text-slate-500">Liked by {comment.reactions.map((reaction) => reaction.user?.profile?.displayName || reaction.user?.name || 'Member').join(', ')}</p> : null}
                              {replyParent === comment.id ? <div className="mt-2 flex flex-wrap gap-2"><input value={commentDraft[`${post.id}:${comment.id}`] ?? ''} onChange={(event) => setCommentDraft((current) => ({ ...current, [`${post.id}:${comment.id}`]: event.target.value }))} placeholder="Write a reply…" className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-xs" />{selected.members?.some((member) => member.user?.profile?.username) ? <select aria-label="Mention a member in the reply" value="" onChange={(event) => { const handle = selected.members?.find((member) => member.userId === event.target.value)?.user?.profile?.username?.replace(/^@/, ''); if (handle) setCommentDraft((current) => ({ ...current, [`${post.id}:${comment.id}`]: `${current[`${post.id}:${comment.id}`] ?? ''}${(current[`${post.id}:${comment.id}`] ?? '').trim() ? ' ' : ''}@${handle} ` })) }} className="rounded-lg border border-slate-200 bg-white px-2 text-xs"><option value="">Mention</option>{selected.members?.filter((member) => member.user?.profile?.username).map((member) => <option key={member.userId} value={member.userId}>{member.user?.profile?.displayName || member.user?.name}</option>)}</select> : null}<Button variant="primary" size="sm" onClick={() => void sendComment(post.id, comment.id)}>Reply</Button></div> : null}
                              {commentsOpen[`${post.id}:${comment.id}`] ? <div className="mt-2 space-y-2 border-l-2 border-slate-100 pl-3">{(comments[`${post.id}:${comment.id}`] ?? []).map((reply) => <div key={reply.id} className="rounded-lg bg-slate-50 p-2 text-xs text-slate-700"><strong>{reply.author?.profile?.displayName || reply.author?.name}</strong>{editingComments[reply.id] !== undefined ? <div className="mt-1 space-y-1"><input aria-label="Edit reply" value={editingComments[reply.id]} onChange={(event) => setEditingComments((current) => ({ ...current, [reply.id]: event.target.value }))} className="w-full rounded border border-slate-200 px-2 py-1" /><div className="flex gap-2"><button type="button" onClick={() => void saveComment(reply.id, editingComments[reply.id], post.id, comment.id)} className="font-semibold text-blue-700">Save</button><button type="button" onClick={() => setEditingComments((current) => { const next = { ...current }; delete next[reply.id]; return next })}>Cancel</button></div></div> : <span> {renderMentionText(reply.content)}</span>}{reply.authorId === user?.id || isManager(selected.myRole) ? <span className="ml-2 inline-flex gap-2"><button type="button" onClick={() => setEditingComments((current) => ({ ...current, [reply.id]: reply.content }))}>Edit</button><button type="button" onClick={() => { if (window.confirm('Delete this reply?')) void deleteComment(reply.id, post.id, comment.id) }} className="text-rose-600">Delete</button></span> : null}</div>)}
                                {commentCursors[`${post.id}:${comment.id}`] ? <button type="button" onClick={() => void loadComments(post.id, comment.id, commentCursors[`${post.id}:${comment.id}`] ?? undefined)} className="text-xs font-semibold text-blue-700">Load more replies</button> : null}
                              </div> : null}
                            </div>
                          </div>
                        ))}
                        {commentCursors[`${post.id}:`] ? <button type="button" onClick={() => void loadComments(post.id, undefined, commentCursors[`${post.id}:`] ?? undefined)} className="text-xs font-semibold text-blue-700">Load more comments</button> : null}
                        {selected.joined ? <div className="flex flex-wrap gap-2"><input value={commentDraft[`${post.id}:`] ?? ''} onChange={(event) => setCommentDraft((current) => ({ ...current, [`${post.id}:`]: event.target.value }))} placeholder="Write a comment…" maxLength={2000} className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm" />{selected.members?.some((member) => member.user?.profile?.username) ? <select aria-label="Mention a member in the comment" value="" onChange={(event) => { const handle = selected.members?.find((member) => member.userId === event.target.value)?.user?.profile?.username?.replace(/^@/, ''); if (handle) setCommentDraft((current) => ({ ...current, [`${post.id}:`]: `${current[`${post.id}:`] ?? ''}${(current[`${post.id}:`] ?? '').trim() ? ' ' : ''}@${handle} ` })) }} className="rounded-lg border border-slate-200 bg-white px-2 text-xs"><option value="">Mention</option>{selected.members?.filter((member) => member.user?.profile?.username).map((member) => <option key={member.userId} value={member.userId}>{member.user?.profile?.displayName || member.user?.name}</option>)}</select> : null}<Button variant="primary" size="sm" onClick={() => void sendComment(post.id)}>Send</Button></div> : null}
                      </div>
                    ) : null}
                  </article>
                ))}
                {!selected.posts?.length ? <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">No discussions yet. Start the first post.</div> : null}
                {nextPostCursor ? <div className="text-center"><Button variant="secondary" size="sm" onClick={() => void loadMorePosts()}>Load more discussions</Button></div> : null}
              </>
            ) : null}

            {tab === 'about' ? (
              <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5">
                <div><h3 className="font-semibold text-slate-900">About this group</h3><p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{selected.description || 'This group has no description yet.'}</p></div>
                <div className="grid gap-3 text-sm sm:grid-cols-2">
                  <p><span className="font-semibold">Privacy:</span> {selected.privacy.toLowerCase()}</p><p><span className="font-semibold">Visibility:</span> {selected.visibility.toLowerCase()}</p>
                  <p><span className="font-semibold">Category:</span> {selected.category}</p><p><span className="font-semibold">Members:</span> {selected.memberCount}</p>
                  <p><span className="font-semibold">Membership:</span> {selected.membershipApproval ? 'Approval required' : 'Open to join'}</p><p><span className="font-semibold">Posts:</span> {selected.postApproval ? 'Admin approval required' : 'Member posts appear immediately'}</p>
                </div>
                {selected.rules.length ? <div><h3 className="font-semibold text-slate-900">Group rules</h3><ol className="mt-2 list-inside list-decimal space-y-1 text-sm text-slate-600">{selected.rules.map((rule, index) => <li key={`${index}-${rule}`}>{rule}</li>)}</ol></div> : null}
                {selected.myRole === 'OWNER' ? <Button variant="ghost" size="sm" icon={<Trash2 className="h-4 w-4" />} onClick={() => void deleteGroup()} className="text-rose-700">Delete group</Button> : null}
              </section>
            ) : null}

            {tab === 'members' ? (
              <section className="rounded-2xl border border-slate-200 bg-white p-4">
                <h3 className="mb-3 flex items-center gap-2 font-semibold text-slate-900"><Users className="h-4 w-4" />Members · {selected.memberCount}</h3>
                <form onSubmit={searchMembers} className="mb-3 flex gap-2"><input value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} placeholder="Search members" className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm" /><Button type="submit" variant="secondary" size="sm">Search</Button></form>
                <ul className="divide-y divide-slate-100">{(selected.members ?? []).map((member) => (
                  <li key={member.userId} className="flex items-center gap-3 py-3">
                    <Avatar src={resolveMediaUrl(member.user?.profile?.avatarUrl)} alt={member.user?.name ?? 'Member'} size="sm" />
                    <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-slate-800">{member.user?.profile?.displayName || member.user?.name || member.userId}</p><p className="text-xs capitalize text-slate-500">{member.role.toLowerCase()}</p></div>
                    {isManager(selected.myRole) && member.userId !== user?.id && member.role !== 'OWNER' ? <div className="flex gap-1">
                      {selected.myRole === 'OWNER' || selected.myRole === 'ADMIN' ? <button type="button" onClick={() => void manageMember(member.userId, { action: 'role', role: member.role === 'MODERATOR' ? 'MEMBER' : 'MODERATOR' })} aria-label={member.role === 'MODERATOR' ? 'Remove moderator' : 'Make moderator'} className="rounded-lg p-2 text-blue-700 hover:bg-blue-50"><Shield className="h-4 w-4" /></button> : null}
                      <button type="button" onClick={() => void removeMember(member.userId)} aria-label="Remove member" className="rounded-lg p-2 text-rose-700 hover:bg-rose-50"><X className="h-4 w-4" /></button>
                      <details className="relative">
                        <summary aria-label="More moderation actions" className="cursor-pointer rounded-lg px-2 py-1 text-slate-500 hover:bg-slate-100"><ChevronDown className="h-4 w-4" /></summary>
                        <div className="absolute right-0 z-10 mt-1 min-w-40 rounded-xl border border-slate-200 bg-white p-1 shadow-lg">
                          <button type="button" onClick={() => void manageMember(member.userId, { action: 'restrict', until: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() })} className="block w-full rounded-lg px-3 py-2 text-left text-xs hover:bg-slate-50">Restrict posts for 24h</button>
                          <button type="button" onClick={() => void manageMember(member.userId, { action: 'suspend', until: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() })} className="block w-full rounded-lg px-3 py-2 text-left text-xs hover:bg-slate-50">Suspend for 24h</button>
                          <button type="button" onClick={() => { if (window.confirm('Ban this member from the group?')) void manageMember(member.userId, { action: 'ban', reason: 'Group moderation', until: null }) }} className="block w-full rounded-lg px-3 py-2 text-left text-xs text-rose-700 hover:bg-rose-50">Ban from group</button>
                        </div>
                      </details>
                    </div> : null}
                  </li>
                ))}</ul>
              </section>
            ) : null}

            {tab === 'admin' && isManager(selected.myRole) ? (
              <section className="space-y-4">
                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="flex items-center justify-between"><h3 className="font-semibold text-slate-900">Membership requests</h3><Button variant="secondary" size="sm" onClick={() => void loadAdmin()}>Refresh</Button></div>
                  {(adminData?.requests ?? []).length ? <ul className="mt-3 divide-y divide-slate-100">{adminData!.requests.map((request) => <li key={request.id} className="flex items-center justify-between gap-3 py-2 text-sm"><span>{request.user?.name ?? 'New member'}</span><span className="flex gap-2"><button type="button" onClick={() => void respondRequest(request.id, true)} className="rounded-lg bg-emerald-50 px-3 py-1.5 font-semibold text-emerald-700"><Check className="inline h-4 w-4" /> Approve</button><button type="button" onClick={() => void respondRequest(request.id, false)} className="rounded-lg bg-rose-50 px-3 py-1.5 font-semibold text-rose-700">Reject</button></span></li>)}</ul> : <p className="mt-3 text-sm text-slate-500">No pending requests.</p>}
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <h3 className="font-semibold text-slate-900">Pending posts</h3>
                  {(adminData?.pendingPosts ?? []).length ? <ul className="mt-3 space-y-3">{adminData!.pendingPosts.map((post) => <li key={post.id} className="rounded-xl bg-slate-50 p-3"><p className="text-sm">{post.content}</p><div className="mt-2 flex gap-2"><Button variant="primary" size="sm" onClick={() => void decidePost(post.id, true)}>Approve</Button><Button variant="secondary" size="sm" onClick={() => void decidePost(post.id, false)}>Reject</Button></div></li>)}</ul> : <p className="mt-3 text-sm text-slate-500">No posts are waiting for approval.</p>}
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <h3 className="font-semibold text-slate-900">Invite members</h3>
                  <div className="mt-3 flex flex-wrap gap-2"><Button variant="secondary" size="sm" onClick={() => void loadDirectory()}>Load people</Button>{directory.length ? <><select aria-label="Select person to invite" value={inviteUserId} onChange={(event) => setInviteUserId(event.target.value)} className="min-w-40 rounded-lg border border-slate-300 px-3 py-2 text-sm"><option value="">Choose a person</option>{directory.map((person) => <option key={person.id} value={person.id}>{person.profile?.displayName || person.name}</option>)}</select><Button variant="primary" size="sm" disabled={!inviteUserId} onClick={() => void inviteMember()}>Invite</Button></> : null}</div>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <h3 className="font-semibold text-slate-900">Banned members</h3>
                  {(adminData?.bans ?? []).length ? <ul className="mt-2 divide-y divide-slate-100">{adminData!.bans.map((ban) => <li key={ban.id} className="flex items-center justify-between gap-2 py-2 text-sm"><span>{ban.user?.name ?? ban.userId}</span><button type="button" onClick={() => void manageMember(ban.userId, { action: 'unban' })} className="font-semibold text-blue-700">Unban</button></li>)}</ul> : <p className="mt-2 text-sm text-slate-500">No active bans.</p>}
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <h3 className="font-semibold text-slate-900">Moderation history</h3>
                  {(adminData?.actions ?? []).length ? <ul className="mt-2 space-y-2 text-sm text-slate-600">{adminData!.actions.map((action) => <li key={action.id} className="border-t border-slate-100 pt-2"><span className="font-medium">{action.action.replaceAll('_', ' ')}</span> · {formatTime(action.createdAt)}</li>)}</ul> : <p className="mt-2 text-sm text-slate-500">No moderation activity yet.</p>}
                  {(adminData?.reports ?? []).length ? <ul className="mt-3 space-y-2 border-t border-slate-100 pt-3">{adminData!.reports.map((report) => <li key={report.id} className="rounded-xl bg-amber-50 p-3"><p className="text-xs font-semibold text-amber-900">{report.category}</p><p className="mt-1 text-sm text-slate-700">{report.reason}</p><div className="mt-2 flex gap-2"><Button variant="secondary" size="sm" onClick={() => void reviewReport(report.id, 'RESOLVED')}>Resolve</Button><Button variant="ghost" size="sm" onClick={() => void reviewReport(report.id, 'REJECTED')}>Dismiss</Button></div></li>)}</ul> : null}
                </div>
              </section>
            ) : null}
          </section>

          <aside className="space-y-4">
            <section className="rounded-2xl border border-slate-200 bg-white p-4">
              <h3 className="font-semibold text-slate-900">About</h3>
              <p className="mt-2 line-clamp-4 text-sm text-slate-600">{selected.description || 'A NOVACHAT Discussion Group.'}</p>
              <p className="mt-3 flex items-center gap-2 text-xs text-slate-500">{selected.privacy === 'PRIVATE' ? <LockKeyhole className="h-4 w-4" /> : <Users className="h-4 w-4" />}{selected.privacy === 'PRIVATE' ? 'Private group' : 'Public group'} · {selected.visibility.toLowerCase()}</p>
              <p className="mt-2 text-xs text-slate-500">{selected.memberCount} members · {selected.category}</p>
            </section>
            <section className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between"><h3 className="font-semibold text-slate-900">Members</h3><button type="button" onClick={() => setTab('members')} className="text-xs font-semibold text-blue-700">See all</button></div>
              <div className="mt-3 space-y-2">{(selected.members ?? []).slice(0, 6).map((member) => <div key={member.userId} className="flex items-center gap-2"><Avatar src={resolveMediaUrl(member.user?.profile?.avatarUrl)} alt={member.user?.name ?? 'Member'} size="sm" /><span className="truncate text-sm text-slate-700">{member.user?.profile?.displayName || member.user?.name || 'Member'}</span><span className="ml-auto text-[10px] capitalize text-slate-400">{member.role.toLowerCase()}</span></div>)}</div>
            </section>
          </aside>
        </div>
      ) : <p role="status" className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">{error ? 'This group is unavailable.' : 'Loading group…'}</p>}
    </main>
  )
}
