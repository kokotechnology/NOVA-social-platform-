import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { Bookmark, Camera, Copy, ExternalLink, MessageCircle, MessageSquare, PencilLine, Share2, ShieldAlert, ThumbsUp, Trash2, Users, UserRound, X } from 'lucide-react'
import { Avatar } from './ui/Avatar'
import { Button } from './ui/Button'
import { PostMedia } from './PostMedia'
import { LiveFeedPlayer } from './LiveFeedPlayer'
import { useAuth } from '../context/AuthContext'
import { apiRequest } from '../lib/api'
import { canonicalPostUrl, copyTextToClipboard, sendPostToConversation, sharePostLink } from '../lib/postSharing'
import { getPostBackground, postBackgrounds } from '../lib/postBackgrounds'
import type { Post } from '../types'

type CommentRecord = {
  id: string
  parentId?: string | null
  content: string
  createdAt: string
  author: { id: string; name: string; avatar?: string }
}

type ShareConversation = {
  id: string
  name: string | null
  participants: { userId: string; user?: { name: string } }[]
}

type PostCardProps = {
  post: Post
  onDeleted?: (postId: string) => void
}

const createShareRequestId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`

export function PostCard({ post, onDeleted }: PostCardProps) {
  const { user } = useAuth()
  const [likes, setLikes] = useState(post.likes)
  const [liked, setLiked] = useState(post.currentUserReaction === 'LIKE')
  const [authorFollowing, setAuthorFollowing] = useState(post.authorFollowing ?? false)
  const [comments, setComments] = useState<CommentRecord[]>([])
  const [commentCount, setCommentCount] = useState(post.comments)
  const [liveViewerCount, setLiveViewerCount] = useState(post.live?.viewerCount ?? 0)
  const [commentDraft, setCommentDraft] = useState('')
  const [replyDraft, setReplyDraft] = useState('')
  const [replyToId, setReplyToId] = useState<string | null>(null)
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [content, setContent] = useState(post.content)
  const [imageUrl, setImageUrl] = useState(post.image ?? '')
  const [background, setBackground] = useState<string | null>(post.background ?? null)
  const [visibility, setVisibility] = useState<Post['visibility']>(post.visibility ?? 'PUBLIC')
  const [editing, setEditing] = useState(false)
  const [saved, setSaved] = useState(post.savedByCurrentUser ?? false)
  const [saveCount, setSaveCount] = useState(post.saved)
  const [shareCount, setShareCount] = useState(post.shares)
  const [shareOpen, setShareOpen] = useState(false)
  const [shareBusy, setShareBusy] = useState(false)
  const [shareRequestId, setShareRequestId] = useState('')
  const [groupShareRequestIds, setGroupShareRequestIds] = useState<Record<string, string>>({})
  const [shareConversations, setShareConversations] = useState<ShareConversation[]>([])
  const [shareFriends, setShareFriends] = useState<Array<{ id: string; name: string; profile?: { avatarUrl?: string | null } | null }>>([])
  const [shareGroups, setShareGroups] = useState<Array<{ id: string; name: string }>>([])
  const [shareCommentary, setShareCommentary] = useState('')
  const [shareMode, setShareMode] = useState<'compose' | 'groups' | 'friends' | 'messages'>('compose')
  const [shareAudience, setShareAudience] = useState<'PUBLIC' | 'FOLLOWERS'>('PUBLIC')
  const [shareDestinationsLoading, setShareDestinationsLoading] = useState(false)
  const [viewerProfile, setViewerProfile] = useState<{ name: string; avatar: string }>({ name: user?.name ?? 'You', avatar: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const isOwnPost = user?.id === post.author.id
  const isGroupPost = Boolean(post.groupOrigin && post.groupId)
  const groupPostPath = `/api/discussion-groups/${encodeURIComponent(post.groupId ?? '')}/posts/${encodeURIComponent(post.id)}`
  const groupPostUrl = post.groupId
    ? `${window.location.origin}/discussion-groups/${encodeURIComponent(post.groupId)}?postId=${encodeURIComponent(post.id)}`
    : canonicalPostUrl(window.location.origin, post.id)
  const shareUrl = post.sharedPost ? canonicalPostUrl(window.location.origin, post.sharedPost.id)
    : post.sharedDiscussionPost ? `${window.location.origin}/discussion-groups/${encodeURIComponent(post.sharedDiscussionPost.groupId)}?postId=${encodeURIComponent(post.sharedDiscussionPost.id)}`
      : isGroupPost ? groupPostUrl : canonicalPostUrl(window.location.origin, post.id)
  const externallyShareable = (!post.groupOrigin || (post.groupOrigin.privacy === 'PUBLIC' && post.groupOrigin.visibility === 'VISIBLE'))
    && (!post.visibility || post.visibility === 'PUBLIC')

  useEffect(() => {
    setLikes(post.likes)
    setLiked(post.currentUserReaction === 'LIKE')
    setCommentCount(post.comments)
    setLiveViewerCount(post.live?.viewerCount ?? 0)
    setAuthorFollowing(post.authorFollowing ?? false)
    setContent(post.content)
    setImageUrl(post.image ?? '')
    setBackground(post.background ?? null)
    setVisibility(post.visibility ?? 'PUBLIC')
    setSaved(post.savedByCurrentUser ?? false)
    setSaveCount(post.saved)
    setShareCount(post.shares)
  }, [post.authorFollowing, post.background, post.comments, post.content, post.currentUserReaction, post.image, post.likes, post.live?.viewerCount, post.saved, post.savedByCurrentUser, post.shares, post.visibility])

  const toggleLike = async () => {
    if (busy) return
    if (isGroupPost && !post.groupCanInteract) {
      setError('Join this Discussion Group to react to its posts.')
      return
    }
    setBusy(true)
    setError('')
    try {
      if (isGroupPost) {
        await apiRequest(`${groupPostPath}/reactions`, liked ? { method: 'DELETE' } : {
          method: 'POST',
          body: JSON.stringify({ type: 'LIKE' }),
        })
        setLiked(!liked)
        setLikes((count) => Math.max(0, count + (liked ? -1 : 1)))
        return
      }
      const response = liked
        ? await apiRequest<{ reactionCounts: Record<string, number> }>(`/api/posts/${post.id}/react`, { method: 'DELETE' })
        : await apiRequest<{ reactionCounts: Record<string, number> }>(`/api/posts/${post.id}/react`, {
            method: 'POST',
            body: JSON.stringify({ type: 'LIKE' }),
          })
      setLiked(!liked)
      setLikes(response.reactionCounts.LIKE ?? 0)
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Unable to update reaction.')
    } finally {
      setBusy(false)
    }
  }

  const loadComments = async () => {
    setCommentsLoading(true)
    setError('')
    try {
      if (isGroupPost) {
        const response = await apiRequest<{ comments: Array<CommentRecord & { author?: { name: string; profile?: { avatarUrl?: string | null } | null } }> }>(`${groupPostPath}/comments`)
        setComments(response.comments.map((comment) => ({
          ...comment,
          author: {
            id: comment.author?.id ?? '',
            name: comment.author?.name ?? 'Group member',
            avatar: comment.author?.avatar ?? comment.author?.profile?.avatarUrl ?? '',
          },
        })))
      } else {
        const response = await apiRequest<{ comments: CommentRecord[] }>(`/api/posts/${post.id}/comments`)
        setComments(response.comments)
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load comments.')
    } finally {
      setCommentsLoading(false)
    }
  }

  const toggleComments = async () => {
    const nextOpen = !commentsOpen
    setCommentsOpen(nextOpen)
    if (nextOpen) await loadComments()
  }

  const publishComment = async (draft: string, parentId?: string) => {
    if (!draft.trim() || busy) return
    if (isGroupPost && !post.groupCanInteract) {
      setError('Join this Discussion Group to comment.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const response = await apiRequest<{ comment: CommentRecord & { author?: { name: string; profile?: { avatarUrl?: string | null } | null } } }>(isGroupPost ? `${groupPostPath}/comments` : `/api/posts/${post.id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ content: draft.trim(), ...(parentId ? { parentId } : {}) }),
      })
      setComments((current) => [{
        ...response.comment,
        author: {
          ...response.comment.author,
          avatar: response.comment.author?.avatar ?? response.comment.author?.profile?.avatarUrl ?? '',
        },
      }, ...current])
      setCommentCount((count) => count + 1)
      if (parentId) {
        setReplyDraft('')
        setReplyToId(null)
      } else {
        setCommentDraft('')
      }
    } catch (commentError) {
      setError(commentError instanceof Error ? commentError.message : 'Unable to publish comment.')
    } finally {
      setBusy(false)
    }
  }

  const submitComment = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    await publishComment(commentDraft)
  }

  const submitReply = async (event: React.FormEvent<HTMLFormElement>, parentId: string) => {
    event.preventDefault()
    await publishComment(replyDraft, parentId)
  }

  const recordPostShare = async () => {
    if (isGroupPost) {
      const response = await apiRequest<{ shares: number }>(`${groupPostPath}/share-count`, {
        method: 'POST',
        body: JSON.stringify({ requestId: createShareRequestId() }),
      })
      setShareCount(response.shares)
      return
    }
    const response = await apiRequest<{ shares: number }>(`/api/posts/${encodeURIComponent(post.id)}/share`, { method: 'POST' })
    setShareCount(response.shares)
  }

  const openShareOptions = async () => {
    if (shareOpen) {
      setShareOpen(false)
      return
    }
    setShareOpen(true)
    setShareMode('compose')
    setShareCommentary('')
    setShareRequestId(createShareRequestId())
    setError('')
    setNotice('')
    if (user?.id) {
      void apiRequest<{ user: { name: string; profile?: { displayName?: string | null; avatarUrl?: string | null } | null } }>(`/api/users/${encodeURIComponent(user.id)}`)
        .then(({ user: profile }) => setViewerProfile({ name: profile.profile?.displayName ?? profile.name, avatar: profile.profile?.avatarUrl ?? '' }))
        .catch((profileError) => setError(profileError instanceof Error ? profileError.message : 'Unable to load your profile.'))
    }
  }

  const loadShareDestinations = async (mode: 'groups' | 'friends' | 'messages') => {
    setShareMode(mode)
    setShareDestinationsLoading(true)
    setError('')
    try {
      if (mode === 'groups') {
        const response = await apiRequest<{ groups: Array<{ id: string; name: string }> }>('/api/discussion-groups?filter=joined&limit=50')
        setShareGroups(response.groups.filter((group) => group.id !== post.groupId))
      } else if (mode === 'friends') {
        const response = await apiRequest<{ users: typeof shareFriends }>('/api/users/me/share-destinations')
        setShareFriends(response.users)
      } else {
        const response = await apiRequest<{ conversations: ShareConversation[] }>('/api/conversations')
        setShareConversations(response.conversations)
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : `Unable to load ${mode}.`)
    } finally {
      setShareDestinationsLoading(false)
    }
  }

  const shareFromDevice = async () => {
    setShareBusy(true)
    setError('')
    try {
      const result = await sharePostLink({ title: `Post by ${post.author.name}`, text: post.content, url: shareUrl })
      if (result === 'cancelled') return
      await recordPostShare()
      setNotice(result === 'copied' ? 'Post link copied.' : 'Post shared.')
      setShareOpen(false)
    } catch (shareError) {
      setError(shareError instanceof Error ? shareError.message : 'Unable to share this post.')
    } finally {
      setShareBusy(false)
    }
  }

  const publishReshare = async (sharedToUserId?: string) => {
    setShareBusy(true)
    setError('')
    try {
      const response = await apiRequest<{ duplicate?: boolean }>(`/api/posts/${encodeURIComponent(post.id)}/reshare`, {
        method: 'POST',
        body: JSON.stringify({
          commentary: shareCommentary.trim(),
          visibility: shareAudience,
          ...(sharedToUserId ? { sharedToUserId } : {}),
          requestId: shareRequestId || createShareRequestId(),
        }),
      })
      if (!response.duplicate) setShareCount((count) => count + 1)
      setNotice(sharedToUserId ? 'Shared to your friend’s profile.' : 'Shared to your Home Feed.')
      setShareOpen(false)
      setShareRequestId('')
    } catch (shareError) {
      setError(shareError instanceof Error ? shareError.message : 'Unable to reshare this post.')
    } finally {
      setShareBusy(false)
    }
  }

  const shareToGroup = async (groupId: string) => {
    if (isGroupPost && !post.groupCanInteract) {
      setError('Join this Discussion Group before sharing its post to another group.')
      return
    }
    const requestId = groupShareRequestIds[groupId] ?? createShareRequestId()
    setGroupShareRequestIds((current) => ({ ...current, [groupId]: requestId }))
    setShareBusy(true)
    setError('')
    try {
      if (isGroupPost) {
        await apiRequest(`${groupPostPath}/share`, {
          method: 'POST',
          body: JSON.stringify({ targetGroupId: groupId, content: shareCommentary.trim(), requestId }),
        })
      } else {
        await apiRequest(`/api/discussion-groups/${encodeURIComponent(groupId)}/share`, {
          method: 'POST',
          body: JSON.stringify({ postId: post.id, content: shareCommentary.trim(), requestId }),
        })
      }
      if (!isGroupPost) await recordPostShare()
      setNotice('Shared to the Discussion Group.')
      setShareOpen(false)
      setGroupShareRequestIds((current) => {
        const next = { ...current }
        delete next[groupId]
        return next
      })
    } catch (shareError) {
      setError(shareError instanceof Error ? shareError.message : 'Unable to share this post to that group.')
    } finally {
      setShareBusy(false)
    }
  }

  const shareToStory = async () => {
    if (!externallyShareable) {
      setError('Only public posts can be shared to a Story.')
      return
    }
    window.dispatchEvent(new CustomEvent('novachat:share-to-story', { detail: { postId: post.id, group: isGroupPost } }))
    setShareOpen(false)
  }

  const shareToWhatsApp = async () => {
    const text = `Post by ${post.author.name}${post.content ? `: ${post.content}` : ''}\n${shareUrl}`
    setError('')
    try {
      const popup = window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer')
      if (!popup) {
        await copyTextToClipboard(shareUrl)
        setNotice('WhatsApp could not open; the post link was copied instead.')
      } else {
        setNotice('Opened WhatsApp sharing.')
      }
      await recordPostShare()
    } catch (shareError) {
      setError(shareError instanceof Error ? shareError.message : 'Unable to share this post through WhatsApp.')
    }
  }

  const copyPostLink = async () => {
    setShareBusy(true)
    setError('')
    try {
      await copyTextToClipboard(shareUrl)
      if (externallyShareable) await recordPostShare()
      setNotice('Post link copied.')
      setShareOpen(false)
    } catch (shareError) {
      setError(shareError instanceof Error ? shareError.message : 'Unable to copy the post link.')
    } finally {
      setShareBusy(false)
    }
  }

  const shareToConversation = async (conversationId: string) => {
    setShareBusy(true)
    setError('')
    try {
      await sendPostToConversation(conversationId, post.author.name, shareUrl, apiRequest)
      await recordPostShare()
      setNotice('Post shared in your conversation.')
      setShareOpen(false)
    } catch (shareError) {
      setError(shareError instanceof Error ? shareError.message : 'Unable to share this post in that conversation.')
    } finally {
      setShareBusy(false)
    }
  }

  const toggleSave = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const response = await apiRequest<{ saved: boolean; savedCount: number }>(`/api/posts/${post.id}/save`, {
        method: saved ? 'DELETE' : 'POST',
      })
      setSaved(response.saved)
      setSaveCount(response.savedCount)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save this post.')
    } finally {
      setBusy(false)
    }
  }

  const savePostEdits = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const response = await apiRequest<{ post: { content: string; imageUrl: string | null; background: string | null; visibility: NonNullable<Post['visibility']> } }>(`/api/posts/${post.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: content.trim(), imageUrl: imageUrl.trim(), background, visibility }),
      })
      setContent(response.post.content)
      setImageUrl(response.post.imageUrl ?? '')
      setBackground(response.post.background)
      setVisibility(response.post.visibility)
      setEditing(false)
      setNotice('Post updated.')
    } catch (editError) {
      setError(editError instanceof Error ? editError.message : 'Unable to update this post.')
    } finally {
      setBusy(false)
    }
  }

  const toggleFollowAuthor = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const response = await apiRequest<{ following: boolean }>(`/api/users/${encodeURIComponent(post.author.id)}/follow`, {
        method: authorFollowing ? 'DELETE' : 'POST',
      })
      setAuthorFollowing(response.following)
      setNotice(response.following ? `Following @${post.author.handle}.` : `Unfollowed @${post.author.handle}.`)
    } catch (followError) {
      setError(followError instanceof Error ? followError.message : 'Unable to update follow status.')
    } finally {
      setBusy(false)
    }
  }

  const reportPost = async () => {
    const reason = window.prompt('Why are you reporting this post?')
    if (!reason || reason.trim().length < 4) return
    setError('')
    try {
      await apiRequest(isGroupPost ? `${groupPostPath}/report` : '/api/reports', {
        method: 'POST',
        body: JSON.stringify(isGroupPost ? { category: 'OTHER', reason: reason.trim() } : { targetType: 'post', targetId: post.id, category: 'OTHER', reason: reason.trim() }),
      })
      setNotice('Report submitted for review.')
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : 'Unable to report this post.')
    }
  }

  const deletePost = async () => {
    if (busy) return
    if (!window.confirm('Delete this post? This cannot be undone.')) return
    setBusy(true)
    setError('')
    try {
      await apiRequest(isGroupPost ? groupPostPath : `/api/posts/${post.id}`, { method: 'DELETE' })
      onDeleted?.(post.id)
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete this post.')
    } finally {
      setBusy(false)
    }
  }

  const selectedBackground = getPostBackground(background)

  return (
    <article id={`post-${post.id}`} className="rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex items-start justify-between gap-4">
        <Link to={`/profile/${encodeURIComponent(post.author.id)}`} className="flex min-w-0 items-center gap-3">
          <Avatar src={post.author.avatar} alt={post.author.name} size="md" />
          <div className="min-w-0">
            <p className="truncate font-semibold text-slate-900">{post.author.name}</p>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span>@{post.author.handle}</span>
              <span aria-hidden="true">·</span>
              <span>{post.time}</span>
            </div>
          </div>
        </Link>
        <div className="flex items-center gap-1">
          {!isOwnPost ? <button type="button" onClick={() => void toggleFollowAuthor()} disabled={busy} aria-label={authorFollowing ? `Unfollow ${post.author.name}` : `Follow ${post.author.name}`} className="rounded-xl px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-50">{authorFollowing ? 'Following' : 'Follow'}</button> : null}
          <button type="button" onClick={() => void (isOwnPost ? deletePost() : reportPost())} disabled={isOwnPost && busy} aria-label={isOwnPost ? 'Delete post' : 'Report post'} title={isOwnPost ? 'Delete post' : 'Report post'} className="inline-flex items-center gap-1 rounded-xl px-2 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-50">
            {isOwnPost ? <><Trash2 className="h-4 w-4" aria-hidden="true" /><span>Delete</span></> : <ShieldAlert className="h-4 w-4" aria-hidden="true" />}
          </button>
        </div>
      </div>

      {post.groupOrigin ? <Link to={`/discussion-groups/${encodeURIComponent(post.groupOrigin.id)}?postId=${encodeURIComponent(post.id)}`} className="mt-3 flex items-center gap-2 rounded-xl bg-indigo-50 px-3 py-2 text-sm font-semibold text-indigo-900 hover:bg-indigo-100">
        <Avatar src={post.groupOrigin.avatarUrl ?? ''} alt="" size="sm" />
        <span className="min-w-0 flex-1 truncate">Posted in {post.groupOrigin.name}</span>
        <span aria-hidden="true">↗</span>
      </Link> : null}
      {post.sharedToUserId ? <p className="mt-2 text-xs font-medium text-slate-500">Shared to a friend&apos;s profile</p> : null}
      {post.category ? <div className="mt-3 inline-flex rounded-full bg-violet-50 px-2.5 py-1 text-[10px] font-semibold uppercase text-violet-700">{post.category}</div> : null}
      {editing ? (
        <form onSubmit={(event) => void savePostEdits(event)} className="mt-4 space-y-3">
          <textarea aria-label="Edit post content" value={content} onChange={(event) => setContent(event.target.value)} maxLength={2500} required className="min-h-28 w-full rounded-xl border border-slate-200 p-3 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none" />
          <input type="url" aria-label="Edit image URL" value={imageUrl} onChange={(event) => setImageUrl(event.target.value)} placeholder="Image URL (optional)" className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none" />
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Post background">
            <button type="button" aria-pressed={!background} onClick={() => setBackground(null)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700">No background</button>
            {postBackgrounds.map((option) => (
              <button
                key={option.label}
                type="button"
                aria-label={`${option.label} background`}
                aria-pressed={background === option.value}
                onClick={() => setBackground(option.value)}
                className="h-9 w-9 rounded-lg border border-slate-300"
                style={{ background: option.value }}
              />
            ))}
          </div>
          <label className="flex items-center justify-between gap-3 text-sm text-slate-600">
            <span>Who can see this post?</span>
            <select aria-label="Post privacy" value={visibility} onChange={(event) => setVisibility(event.target.value as NonNullable<Post['visibility']>)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
              <option value="PUBLIC">Everyone</option>
              <option value="FOLLOWERS">Followers</option>
              <option value="PRIVATE">Only me</option>
            </select>
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
            <Button type="submit" variant="primary" size="sm" disabled={busy || !content.trim()}>{busy ? 'Saving…' : 'Save changes'}</Button>
          </div>
        </form>
      ) : (
        <>
          {content && selectedBackground && !imageUrl && !post.live ? (
            <div className="colored-post-content -mx-4 sm:-mx-5" style={{ background: selectedBackground.value, color: selectedBackground.text }}>
              {content}
            </div>
          ) : content ? <p className="mt-4 whitespace-pre-wrap text-[15px] leading-7 text-slate-700">{content}</p> : null}
          {post.live ? <section className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3" aria-label="Live broadcast">
            <p className="flex items-center gap-2 text-sm font-semibold text-rose-800">
              <span className="rounded-full bg-rose-600 px-2 py-1 text-[10px] tracking-normal text-white">{post.live.status === 'live' ? 'LIVE' : 'ENDED'}</span>
              <span>{post.live.title}</span>
              {post.live.status === 'live' ? <span className="ml-auto text-xs font-medium">{liveViewerCount} watching</span> : null}
            </p>
            {post.live.description ? <p className="mt-2 text-sm text-slate-700">{post.live.description}</p> : null}
            {post.live.status === 'live'
              ? <LiveFeedPlayer liveId={post.live.id} title={post.live.title} viewerCount={liveViewerCount} onViewerCountChange={setLiveViewerCount} />
              : <p className="mt-2 text-xs text-slate-600">
                {imageUrl
                  ? 'Watch the saved replay below.'
                  : post.live.recordingStatus === 'PROCESSING' || post.live.recordingStatus === 'RECORDING'
                    ? 'The replay is still being finalized. Check back soon.'
                    : 'This broadcast ended without an available recording.'}
              </p>}
          </section> : null}
          {post.sharedPost || post.sharedDiscussionPost ? <Link to={post.sharedPost
            ? `/#post-${encodeURIComponent(post.sharedPost.id)}`
            : `/discussion-groups/${encodeURIComponent(post.sharedDiscussionPost!.groupId)}?postId=${encodeURIComponent(post.sharedDiscussionPost!.id)}`}
            className="mt-4 block rounded-2xl border border-slate-200 bg-slate-50 p-3 hover:border-indigo-200">
            <p className="text-xs font-semibold text-slate-700">
              Originally by {post.sharedPost?.author.name ?? post.sharedDiscussionPost?.author.name}
              {post.sharedDiscussionPost ? <> · <span className="text-indigo-700">{post.sharedDiscussionPost.group.name}</span></> : null}
            </p>
            <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{post.sharedPost?.content ?? post.sharedDiscussionPost?.content}</p>
            {post.sharedPost?.imageUrl ? <PostMedia url={post.sharedPost.imageUrl} alt="Original post attachment" className="mt-3 max-h-[28rem] w-full rounded-xl object-cover" /> : null}
            {post.sharedDiscussionPost?.media?.map((media, index) => <PostMedia key={`${post.sharedDiscussionPost!.id}-${index}`} url={media.url} alt="Original group post attachment" className="mt-3 max-h-[28rem] w-full rounded-xl object-cover" />)}
            <span className="mt-2 block text-xs font-semibold text-indigo-700">Open original post</span>
          </Link> : null}
          {post.groupMedia?.map((media, index) => <PostMedia key={`${post.id}-${index}`} url={media.url} alt={`Discussion Group attachment ${index + 1}`} className="mt-4 max-h-[32rem] w-full rounded-[24px] object-cover" />)}
          {imageUrl && !post.sharedPost && !post.sharedDiscussionPost ? <PostMedia url={imageUrl} postId={post.id} measurementSource="feed" alt="Post attachment" className="mt-4 max-h-[32rem] w-full rounded-[24px] object-cover" /> : null}
          <p className="mt-2 text-xs text-slate-500">{visibility === 'PUBLIC' ? 'Everyone' : visibility === 'FOLLOWERS' ? 'Followers' : 'Only me'}</p>
        </>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
        <Button variant="ghost" size="sm" className={`px-2 ${liked ? 'text-indigo-700' : 'text-slate-600'}`} onClick={() => void toggleLike()} disabled={busy} icon={<ThumbsUp className="h-4 w-4" aria-hidden="true" />}>
          {likes}
        </Button>
        <Button variant="ghost" size="sm" className="px-2 text-slate-600" onClick={() => void toggleComments()} icon={<MessageCircle className="h-4 w-4" aria-hidden="true" />}>
          {commentCount}
        </Button>
        {!isGroupPost ? <Button variant="ghost" size="sm" className={`px-2 ${saved ? 'text-indigo-700' : 'text-slate-600'}`} onClick={() => void toggleSave()} disabled={busy} icon={<Bookmark className="h-4 w-4" aria-hidden="true" />}>
          {saveCount}
        </Button> : null}
        <Button variant="ghost" size="sm" className="px-2 text-slate-600" onClick={() => void openShareOptions()} aria-label={`Share post (${shareCount} shares)`} icon={<Share2 className="h-4 w-4" aria-hidden="true" />}>
          Share
        </Button>
        {isOwnPost && !isGroupPost ? <Button variant="ghost" size="sm" className="px-2 text-slate-600" onClick={() => setEditing((value) => !value)} icon={<PencilLine className="h-4 w-4" aria-hidden="true" />}>Edit</Button> : null}
      </div>

      {notice ? <p className="mt-2 text-sm text-emerald-700" role="status">{notice}</p> : null}
      {error ? <p className="mt-2 text-sm text-rose-700" role="alert">{error}</p> : null}
      {shareOpen ? createPortal(<div className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-950/55 p-0 sm:items-center sm:p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !shareBusy) setShareOpen(false) }}>
        <section aria-label="Share post" role="dialog" aria-modal="true" aria-labelledby={`share-post-title-${post.id}`} className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] text-slate-900 shadow-2xl sm:rounded-3xl">
          <header className="flex items-center justify-between gap-3">
            <div><h3 id={`share-post-title-${post.id}`} className="text-lg font-semibold">{shareMode === 'compose' ? 'Share this post' : `Share to ${shareMode}`}</h3><p className="text-sm text-slate-500">Choose where this post should go.</p></div>
            <button type="button" onClick={() => setShareOpen(false)} disabled={shareBusy} aria-label="Close share options" className="rounded-full p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-50"><X className="h-5 w-5" aria-hidden="true" /></button>
          </header>
          {shareMode === 'compose' ? <>
            <div className="mt-4 flex items-center gap-3">
              <Avatar src={viewerProfile.avatar} alt={viewerProfile.name} size="md" />
              <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{viewerProfile.name}</p><p className="text-xs text-slate-500">Sharing as you</p></div>
              <select aria-label="Share audience" value={shareAudience} onChange={(event) => setShareAudience(event.target.value as 'PUBLIC' | 'FOLLOWERS')} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold">
                <option value="PUBLIC">Public</option><option value="FOLLOWERS">Followers</option>
              </select>
            </div>
            <textarea aria-label="Share commentary" value={shareCommentary} onChange={(event) => setShareCommentary(event.target.value)} maxLength={2000} placeholder="Say something about this..." className="mt-4 min-h-24 w-full resize-y rounded-2xl border border-slate-200 p-3 text-sm focus:border-indigo-400 focus:outline-none" />
            <Button variant="primary" className="mt-3 w-full justify-center" onClick={() => void publishReshare()} disabled={shareBusy || !externallyShareable}>
              {shareBusy ? 'Sharing…' : 'Share Now'}
            </Button>
            <div className="mt-5 grid grid-cols-2 gap-2" aria-label="Share destinations">
              <button type="button" onClick={() => void shareToStory()} disabled={!externallyShareable} className="flex items-center gap-2 rounded-xl border border-slate-200 p-3 text-left text-sm font-semibold hover:bg-slate-50 disabled:opacity-40"><Camera className="h-5 w-5 text-indigo-600" />Story</button>
              <button type="button" onClick={() => void loadShareDestinations('groups')} disabled={shareDestinationsLoading || isGroupPost && !post.groupCanInteract || !externallyShareable} className="flex items-center gap-2 rounded-xl border border-slate-200 p-3 text-left text-sm font-semibold hover:bg-slate-50 disabled:opacity-40"><Users className="h-5 w-5 text-indigo-600" />Discussion Groups</button>
              <button type="button" onClick={() => void loadShareDestinations('friends')} disabled={shareDestinationsLoading} className="flex items-center gap-2 rounded-xl border border-slate-200 p-3 text-left text-sm font-semibold hover:bg-slate-50"><UserRound className="h-5 w-5 text-indigo-600" />Friend&apos;s Profile</button>
              <button type="button" onClick={shareToWhatsApp} disabled={!externallyShareable} className="flex items-center gap-2 rounded-xl border border-slate-200 p-3 text-left text-sm font-semibold hover:bg-slate-50 disabled:opacity-40"><ExternalLink className="h-5 w-5 text-emerald-600" />WhatsApp</button>
              <button type="button" onClick={() => void loadShareDestinations('messages')} disabled={shareDestinationsLoading} className="flex items-center gap-2 rounded-xl border border-slate-200 p-3 text-left text-sm font-semibold hover:bg-slate-50"><MessageSquare className="h-5 w-5 text-indigo-600" />Messages</button>
              <button type="button" onClick={() => void copyPostLink()} disabled={shareBusy || !externallyShareable} className="flex items-center gap-2 rounded-xl border border-slate-200 p-3 text-left text-sm font-semibold hover:bg-slate-50 disabled:opacity-40"><Copy className="h-5 w-5 text-indigo-600" />Copy Link</button>
              <button type="button" onClick={() => void shareFromDevice()} disabled={shareBusy || !externallyShareable} className="col-span-2 flex items-center gap-2 rounded-xl border border-slate-200 p-3 text-left text-sm font-semibold hover:bg-slate-50 disabled:opacity-40"><Share2 className="h-5 w-5 text-indigo-600" />More</button>
            </div>
          </> : <>
            <div className="mt-4 flex items-center justify-between">
              <button type="button" onClick={() => setShareMode('compose')} className="text-sm font-semibold text-indigo-700 hover:underline">← Back to sharing options</button>
            </div>
            {shareDestinationsLoading ? <p className="mt-4 text-sm text-slate-500" role="status">Loading {shareMode}…</p> : null}
            {shareMode === 'groups' && !shareDestinationsLoading ? shareGroups.length ? <ul className="mt-3 max-h-72 divide-y divide-slate-100 overflow-y-auto">{shareGroups.map((group) => <li key={group.id} className="flex items-center gap-3 py-3"><span className="min-w-0 flex-1 truncate text-sm font-medium">{group.name}</span><Button variant="primary" size="sm" onClick={() => void shareToGroup(group.id)} disabled={shareBusy}>{shareBusy ? 'Sharing…' : 'Share'}</Button></li>)}</ul> : <p className="mt-4 text-sm text-slate-500">Join a Discussion Group to share this post there.</p> : null}
            {shareMode === 'friends' && !shareDestinationsLoading ? shareFriends.length ? <ul className="mt-3 max-h-72 divide-y divide-slate-100 overflow-y-auto">{shareFriends.map((friend) => <li key={friend.id} className="flex items-center gap-3 py-3"><Avatar src={friend.profile?.avatarUrl ?? ''} alt={friend.name} size="sm" /><span className="min-w-0 flex-1 truncate text-sm font-medium">{friend.name}</span><Button variant="primary" size="sm" onClick={() => void publishReshare(friend.id)} disabled={shareBusy}>{shareBusy ? 'Sharing…' : 'Share'}</Button></li>)}</ul> : <p className="mt-4 text-sm text-slate-500">Friend profile sharing is available for mutual follows.</p> : null}
            {shareMode === 'messages' && !shareDestinationsLoading ? shareConversations.length ? <ul className="mt-3 max-h-72 divide-y divide-slate-100 overflow-y-auto">{shareConversations.map((conversation) => {
              const peer = conversation.participants.find((participant) => participant.userId !== user?.id)?.user?.name
              return <li key={conversation.id} className="flex items-center gap-2 py-3"><span className="min-w-0 flex-1 truncate text-sm font-medium">{conversation.name ?? peer ?? 'Group conversation'}</span><Button variant="primary" size="sm" onClick={() => void shareToConversation(conversation.id)} disabled={shareBusy}>{shareBusy ? 'Sending…' : 'Send'}</Button></li>
            })}</ul> : <p className="mt-4 text-sm text-slate-500">No conversations are available to share into.</p> : null}
          </>}
          {error ? <p className="mt-3 text-sm text-rose-700" role="alert">{error}</p> : null}
        </section>
      </div>, document.body) : null}

      {commentsOpen ? (
        <section className="mt-4 border-t border-slate-100 pt-4" aria-label="Post comments">
          <form onSubmit={(event) => void submitComment(event)} className="flex gap-2">
            <input aria-label="Write a comment" value={commentDraft} onChange={(event) => setCommentDraft(event.target.value)} maxLength={1200} placeholder="Write a comment…" className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none" />
            <Button type="submit" variant="primary" size="sm" disabled={busy || !commentDraft.trim()}>{busy ? 'Posting…' : 'Comment'}</Button>
          </form>
          {commentsLoading ? <p className="mt-4 text-sm text-slate-500">Loading comments…</p> : comments.length === 0 ? <p className="mt-4 text-sm text-slate-500">No comments yet.</p> : (
            <ul className="mt-4 space-y-3">
              {comments.filter((comment) => !comment.parentId).map((comment) => (
                <li key={comment.id} className="flex gap-2">
                  <Avatar src={comment.author.avatar ?? ''} alt={comment.author.name} size="sm" />
                  <div className="min-w-0 flex-1 rounded-2xl bg-slate-50 px-3 py-2">
                    <p className="text-xs font-semibold text-slate-800">{comment.author.name}</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{comment.content}</p>
                    <button type="button" onClick={() => { setReplyToId(replyToId === comment.id ? null : comment.id); setReplyDraft('') }} className="mt-2 text-xs font-semibold text-indigo-700">Reply</button>
                    {comments.filter((reply) => reply.parentId === comment.id).map((reply) => (
                      <div key={reply.id} className="mt-3 border-l-2 border-indigo-100 pl-3">
                        <p className="text-xs font-semibold text-slate-800">{reply.author.name}</p>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{reply.content}</p>
                      </div>
                    ))}
                    {replyToId === comment.id ? (
                      <form onSubmit={(event) => void submitReply(event, comment.id)} className="mt-3 flex gap-2">
                        <input aria-label="Write a reply" value={replyDraft} onChange={(event) => setReplyDraft(event.target.value)} maxLength={1200} placeholder="Write a reply…" className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none" />
                        <Button type="submit" variant="primary" size="sm" disabled={busy || !replyDraft.trim()}>{busy ? 'Replying…' : 'Reply'}</Button>
                      </form>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </article>
  )
}