import { Router } from 'express';
import { z } from 'zod';
import { prisma, isDatabaseAvailable } from '../lib/prisma.js';
import { fallbackStore, findUserById } from '../lib/fallbackStore.js';
import { socialStore } from '../lib/socialStore.js';
import { createNotification } from '../lib/platform.js';
import { uploadedMediaBelongsTo, uploadedVideoBelongsTo } from '../lib/mediaStorage.js';
import env from '../config/env.js';
import { requireActiveAccountIfAuthenticated, requireAuth } from '../middleware/auth.js';
import { realtimeHub } from '../lib/realtime.js';

const router = Router();
router.use(requireActiveAccountIfAuthenticated);

const safeMediaUrl = (value: string) => {
  if (value.startsWith('/api/media/')) return true;
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
};

const groupSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(2000).optional(),
  category: z.string().trim().min(1).max(60).optional(),
  avatarUrl: z.string().trim().max(500).refine(safeMediaUrl).nullable().optional(),
  coverUrl: z.string().trim().max(500).refine(safeMediaUrl).nullable().optional(),
  privacy: z.enum(['PUBLIC', 'PRIVATE']).optional(),
  visibility: z.enum(['VISIBLE', 'HIDDEN']).optional(),
  membershipApproval: z.boolean().optional(),
  postApproval: z.boolean().optional(),
  rules: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
});
const postMediaSchema = z.object({
  url: z.string().trim().max(500).refine(safeMediaUrl),
  type: z.enum(['IMAGE', 'VIDEO']),
});
const postSchema = z.object({
  type: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'LINK', 'POLL', 'QUESTION', 'ANNOUNCEMENT']).default('TEXT'),
  content: z.string().trim().max(5000).default(''),
  linkUrl: z.string().url().max(2000).optional(),
  media: z.array(postMediaSchema).max(10).default([]),
  pollOptions: z.array(z.string().trim().min(1).max(120)).min(2).max(10).optional(),
}).refine((value) => Boolean(value.content || value.media.length || value.linkUrl || value.pollOptions), {
  message: 'A post must include text, media, a link, or a poll.',
});
const postEditSchema = z.object({
  type: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'LINK', 'POLL', 'QUESTION', 'ANNOUNCEMENT']).optional(),
  content: z.string().trim().max(5000).optional(),
  linkUrl: z.string().url().max(2000).nullable().optional(),
  media: z.array(postMediaSchema).max(10).optional(),
  pollOptions: z.array(z.string().trim().min(1).max(120)).min(2).max(10).optional(),
}).refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one post field to update.' });
const contentSchema = z.object({ content: z.string().trim().min(1).max(2000), parentId: z.string().min(1).optional() });
const reactionSchema = z.object({ type: z.enum(['LIKE', 'LOVE', 'LAUGH', 'SAD', 'ANGRY']).default('LIKE') });
const reportSchema = z.object({
  category: z.enum(['SPAM', 'HARASSMENT', 'SEXUAL_CONTENT', 'HATE', 'VIOLENCE', 'SCAM', 'OTHER']),
  reason: z.string().trim().min(4).max(500),
});
const memberActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('role'), role: z.enum(['ADMIN', 'MODERATOR', 'MEMBER']) }),
  z.object({ action: z.literal('restrict'), until: z.string().datetime().nullable() }),
  z.object({ action: z.literal('suspend'), until: z.string().datetime().nullable() }),
  z.object({ action: z.literal('ban'), reason: z.string().trim().max(500).optional(), until: z.string().datetime().nullable().optional() }),
  z.object({ action: z.literal('unban') }),
]);

const makeId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
const nowIso = () => new Date().toISOString();
const managerRoles = ['OWNER', 'ADMIN', 'MODERATOR'];
const adminRoles = ['OWNER', 'ADMIN'];
const normalizedHandle = (value: string) => value.replace(/^@/, '').toLowerCase();

function safeUserSummary(userId: string) {
  const user = findUserById(userId);
  if (!user) return null;
  const profile = socialStore.state.profiles.find((entry) => entry.userId === userId);
  return {
    id: user.id,
    name: user.name,
    profile: profile ? { displayName: profile.displayName, avatarUrl: profile.avatarUrl, username: profile.username } : null,
  };
}

async function findGroup(groupId: string) {
  if (await isDatabaseAvailable()) return prisma.discussionGroup.findUnique({ where: { id: groupId } });
  return socialStore.state.discussionGroups.find((group) => group.id === groupId) ?? null;
}

async function findMembership(groupId: string, userId: string) {
  if (await isDatabaseAvailable()) return prisma.discussionGroupMembership.findUnique({ where: { groupId_userId: { groupId, userId } } });
  return socialStore.state.discussionMemberships.find((entry) => entry.groupId === groupId && entry.userId === userId) ?? null;
}

async function canManage(groupId: string, userId: string) {
  const member = await findMembership(groupId, userId);
  return Boolean(member && managerRoles.includes(member.role));
}

async function canAdmin(groupId: string, userId: string) {
  const member = await findMembership(groupId, userId);
  return Boolean(member && adminRoles.includes(member.role));
}

async function getVisibleGroup(groupId: string, userId: string) {
  const group = await findGroup(groupId);
  if (!group) return { group: null, member: null };
  if (await activeBan(groupId, userId)) return { group: null, member: null };
  const member = await findMembership(groupId, userId);
  if ((group.privacy === 'PRIVATE' || group.visibility === 'HIDDEN') && !member) return { group: null, member: null };
  return { group, member };
}

async function activeBan(groupId: string, userId: string) {
  const now = new Date();
  if (await isDatabaseAvailable()) {
    const ban = await prisma.discussionGroupBan.findUnique({ where: { groupId_userId: { groupId, userId } } });
    return ban && (!ban.expiresAt || ban.expiresAt > now) ? ban : null;
  }
  return socialStore.state.discussionBans.find((ban) => ban.groupId === groupId && ban.userId === userId
    && (!ban.expiresAt || new Date(ban.expiresAt).getTime() > now.getTime())) ?? null;
}

async function requireActiveMember(groupId: string, userId: string) {
  const membership = await findMembership(groupId, userId);
  if (!membership || (membership.suspendedUntil && new Date(membership.suspendedUntil).getTime() > Date.now())) return null;
  return membership;
}

async function addAction(groupId: string, actorId: string, action: string, targetId?: string | null, details?: string | null) {
  if (await isDatabaseAvailable()) {
    return prisma.discussionGroupModerationAction.create({
      data: { groupId, actorId, action, targetId: targetId ?? null, details: details ?? null },
    });
  }
  const actionRecord = { id: makeId('dg_action'), groupId, actorId, action, targetId: targetId ?? null, details: details ?? null, createdAt: nowIso() };
  socialStore.state.discussionActions.push(actionRecord);
  return actionRecord;
}

async function emitDiscussionFeedUpdate(groupId: string, group: { privacy: string; visibility: string }) {
  const allowedUserIds = await (async () => {
    if (await isDatabaseAvailable()) {
      if (group.privacy === 'PUBLIC' && group.visibility === 'VISIBLE') {
        return (await prisma.user.findMany({ where: { status: 'ACTIVE' }, select: { id: true } })).map(({ id }) => id);
      }
      return (await prisma.discussionGroupMembership.findMany({ where: { groupId }, select: { userId: true } })).map(({ userId }) => userId);
    }
    if (group.privacy === 'PUBLIC' && group.visibility === 'VISIBLE') {
      return fallbackStore.list().filter((user) => user.status === 'ACTIVE').map(({ id }) => id);
    }
    return socialStore.state.discussionMemberships.filter((member) => member.groupId === groupId).map(({ userId }) => userId);
  })();
  realtimeHub.emit('live:feed:update', { allowedUserIds });
}

function removeFallbackDiscussionPosts(postIds: Set<string>) {
  for (const post of socialStore.state.discussionPosts) {
    if (post.sharedFromId && postIds.has(post.sharedFromId)) post.sharedFromId = null;
  }
  const comments = socialStore.state.discussionComments.filter((comment) => postIds.has(comment.postId));
  const commentIds = new Set(comments.map((comment) => comment.id));
  const polls = socialStore.state.discussionPolls.filter((poll) => postIds.has(poll.postId));
  const pollIds = new Set(polls.map((poll) => poll.id));
  const optionIds = new Set(socialStore.state.discussionPollOptions.filter((option) => pollIds.has(option.pollId)).map((option) => option.id));
  socialStore.state.discussionPosts = socialStore.state.discussionPosts.filter((post) => !postIds.has(post.id));
  socialStore.state.discussionPostMedia = socialStore.state.discussionPostMedia.filter((media) => !postIds.has(media.postId));
  socialStore.state.discussionComments = socialStore.state.discussionComments.filter((comment) => !postIds.has(comment.postId));
  socialStore.state.discussionPostReactions = socialStore.state.discussionPostReactions.filter((reaction) => !postIds.has(reaction.postId));
  socialStore.state.discussionCommentReactions = socialStore.state.discussionCommentReactions.filter((reaction) => !commentIds.has(reaction.commentId));
  socialStore.state.discussionPolls = socialStore.state.discussionPolls.filter((poll) => !postIds.has(poll.postId));
  socialStore.state.discussionPollOptions = socialStore.state.discussionPollOptions.filter((option) => !pollIds.has(option.pollId));
  socialStore.state.discussionPollVotes = socialStore.state.discussionPollVotes.filter((vote) => !optionIds.has(vote.optionId));
  socialStore.state.discussionReports = socialStore.state.discussionReports.filter((report) =>
    !postIds.has(report.postId) && !commentIds.has(report.commentId));
}

async function notifyMembershipChange(groupId: string, actorId: string, targetId: string, action: string) {
  if (actorId === targetId) return;
  const group = await findGroup(groupId);
  await createNotification(targetId, actorId, 'discussion_group_admin_action', `A group administrator ${action} your membership in ${group?.name ?? 'a group'}.`, {
    link: `/discussion-groups/${groupId}`,
  });
}

async function validateMediaOwnership(media: Array<{ url: string; type: 'IMAGE' | 'VIDEO' }>, userId: string) {
  for (const item of media) {
    const belongsToUser = item.type === 'VIDEO'
      ? await uploadedVideoBelongsTo(item.url, userId, env.NODE_ENV)
      : await uploadedMediaBelongsTo(item.url, userId, env.NODE_ENV);
    if (!belongsToUser) return false;
  }
  return true;
}

async function notifyDiscussionMentions(content: string, actorId: string, groupId: string) {
  const handles = [...new Set([...content.matchAll(/(?:^|[^a-zA-Z0-9_.-])@([a-zA-Z0-9_.-]{2,32})/g)]
    .map((match) => normalizedHandle(match[1])))];
  if (!handles.length) return;
  const users = await (async () => {
    if (await isDatabaseAvailable()) {
      return prisma.user.findMany({
        where: { status: 'ACTIVE', id: { not: actorId }, profile: { username: { in: handles, mode: 'insensitive' } } },
        select: { id: true, profile: { select: { username: true } } },
      });
    }
    return fallbackStore.list().filter((user) => {
      if (user.id === actorId || user.status !== 'ACTIVE') return false;
      const username = socialStore.state.profiles.find((profile) => profile.userId === user.id)?.username ?? user.username;
      return Boolean(username && handles.includes(normalizedHandle(username)));
    });
  })();
  const memberIds = new Set(await (async () => {
    if (await isDatabaseAvailable()) {
    return (await prisma.discussionGroupMembership.findMany({ where: { groupId, userId: { in: users.map(({ id }) => id) } }, select: { userId: true } }))
      .map(({ userId }) => userId);
    }
    return socialStore.state.discussionMemberships.filter((member) => member.groupId === groupId).map((member) => member.userId);
  })());
  await Promise.all(users.filter(({ id }) => memberIds.has(id)).map(({ id }) => createNotification(
    id, actorId, 'mention', 'Someone mentioned you in a group discussion.', { link: `/discussion-groups/${groupId}` },
  )));
}

async function formatPost(post: any, viewerId: string) {
  const db = await isDatabaseAvailable();
  if (db) {
    const [myReaction, commentCount, reactions, reactionUsers] = await Promise.all([
      prisma.discussionGroupPostReaction.findUnique({ where: { postId_userId: { postId: post.id, userId: viewerId } }, select: { type: true } }),
      prisma.discussionGroupComment.count({ where: { postId: post.id } }),
      prisma.discussionGroupPostReaction.groupBy({ by: ['type'], where: { postId: post.id }, _count: { _all: true } }),
      prisma.discussionGroupPostReaction.findMany({
        where: { postId: post.id },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { type: true, user: { select: { id: true, name: true, profile: { select: { displayName: true, avatarUrl: true } } } } },
      }),
    ]);
    const sharedFrom = post.sharedFrom;
    const sharedPost = post.sharedPost;
    const sharedDiscussionPost = sharedFrom?.group?.privacy === 'PUBLIC' && sharedFrom.group.visibility === 'VISIBLE' ? {
      id: sharedFrom.id,
      groupId: sharedFrom.groupId,
      content: sharedFrom.content,
      author: sharedFrom.author,
      media: sharedFrom.media,
    } : null;
    return {
      ...post,
      sharedFrom: undefined,
      sharedPost: sharedPost?.visibility === 'PUBLIC' && !sharedPost.moderationHiddenAt ? {
        id: sharedPost.id,
        content: sharedPost.content,
        imageUrl: sharedPost.imageUrl,
        author: sharedPost.author,
      } : sharedDiscussionPost,
      sharedDiscussionPost,
      poll: post.poll ? {
        ...post.poll,
        myVote: post.poll.options.find((option: { votes?: Array<{ id: string }> }) => (option.votes?.length ?? 0) > 0)?.id ?? null,
      } : null,
      myReaction: myReaction?.type ?? null,
      commentCount,
      reactionCounts: Object.fromEntries(reactions.map((reaction) => [reaction.type, reaction._count._all])),
      reactionUsers,
    };
  }
  const sharedFrom = socialStore.state.discussionPosts.find((entry) => entry.id === post.sharedFromId);
  const sharedPost = socialStore.state.posts.find((entry) => entry.id === post.sharedPostId);
  const sharedGroup = sharedFrom && socialStore.state.discussionGroups.find((group) => group.id === sharedFrom.groupId);
  const sharedDiscussionPost = sharedFrom && sharedGroup?.privacy === 'PUBLIC' && sharedGroup.visibility === 'VISIBLE'
    ? {
      id: sharedFrom.id,
      groupId: sharedFrom.groupId,
      content: sharedFrom.content,
      author: safeUserSummary(sharedFrom.authorId),
      media: socialStore.state.discussionPostMedia.filter((entry) => entry.postId === sharedFrom.id).sort((a, b) => a.position - b.position),
    }
    : null;
  const media = socialStore.state.discussionPostMedia.filter((entry) => entry.postId === post.id).sort((a, b) => a.position - b.position);
  const poll = socialStore.state.discussionPolls.find((entry) => entry.postId === post.id);
  const options: Array<{ id: string; pollId: string; text: string; position: number; createdAt: string; votes: number }> = poll
    ? socialStore.state.discussionPollOptions.filter((option) => option.pollId === poll.id).map((option) => ({
      id: option.id,
      pollId: option.pollId,
      text: option.text,
      position: option.position,
      createdAt: option.createdAt,
      votes: socialStore.state.discussionPollVotes.filter((vote) => vote.optionId === option.id).length,
    }))
    : [];
  const reactions = socialStore.state.discussionPostReactions.filter((reaction) => reaction.postId === post.id);
  return {
    ...post,
    sharedPost: sharedPost?.visibility === 'PUBLIC' && !sharedPost.moderationHiddenAt
      ? { id: sharedPost.id, content: sharedPost.content, imageUrl: sharedPost.imageUrl, author: safeUserSummary(sharedPost.authorId) }
      : sharedDiscussionPost,
    media,
    sharedDiscussionPost,
    poll: poll ? { ...poll, options, myVote: socialStore.state.discussionPollVotes.find((vote) => vote.userId === viewerId && options.some((option) => option.id === vote.optionId))?.optionId ?? null } : null,
    myReaction: reactions.find((reaction) => reaction.userId === viewerId)?.type ?? null,
    reactionCounts: Object.fromEntries(['LIKE', 'LOVE', 'LAUGH', 'SAD', 'ANGRY'].map((type) => [type, reactions.filter((reaction) => reaction.type === type).length])),
    reactionUsers: reactions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5).map((reaction) => ({
      type: reaction.type,
      user: safeUserSummary(reaction.userId),
    })),
    commentCount: socialStore.state.discussionComments.filter((comment) => comment.postId === post.id).length,
  };
}

router.get('/discussion-groups', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const category = typeof req.query.category === 'string' ? req.query.category.trim().slice(0, 60) : '';
  const filter = typeof req.query.filter === 'string' ? req.query.filter : 'discover';
  const take = Math.min(50, Math.max(1, Number(req.query.limit) || 30));
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
  if (await isDatabaseAvailable()) {
    const suggestedCategories = filter === 'suggested'
      ? [...new Set((await prisma.discussionGroup.findMany({
        where: { visibility: 'VISIBLE', memberships: { some: { userId } } },
        select: { category: true },
      })).map((group) => group.category))]
      : [];
    const groups = await prisma.discussionGroup.findMany({
      where: {
        bans: { none: { userId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } },
        ...(category ? { category: { equals: category, mode: 'insensitive' as const } } : {}),
        ...(filter === 'joined' ? { memberships: { some: { userId } } } : {}),
        ...(filter === 'managed' ? { memberships: { some: { userId, role: { in: ['OWNER', 'ADMIN', 'MODERATOR'] } } } } : {}),
        ...(filter === 'suggested' ? { memberships: { none: { userId } } } : {}),
        AND: [
          ...(query ? [{ OR: [{ name: { contains: query, mode: 'insensitive' as const } }, { description: { contains: query, mode: 'insensitive' as const } }] }] : []),
          { OR: [{ visibility: 'VISIBLE' }, { memberships: { some: { userId } } }] },
          ...(filter === 'suggested' && suggestedCategories.length ? [{ category: { in: suggestedCategories } }] : []),
        ],
      },
      include: { _count: { select: { memberships: true } }, memberships: { where: { userId }, select: { role: true } } },
      orderBy: filter === 'popular' || filter === 'suggested'
        ? [{ memberships: { _count: 'desc' } }, { createdAt: 'desc' }]
        : { createdAt: 'desc' },
      take: take + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    const hasMore = groups.length > take;
    const page = groups.slice(0, take);
    return res.json({
      groups: page.map(({ _count, memberships, ...group }) => ({
        ...group, memberCount: _count.memberships, joined: memberships.length > 0, myRole: memberships[0]?.role ?? null,
      })),
      nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
    });
  }
  const suggestedCategories = filter === 'suggested'
    ? new Set(socialStore.state.discussionGroups
      .filter((group) => group.visibility === 'VISIBLE' && socialStore.state.discussionMemberships.some((entry) => entry.groupId === group.id && entry.userId === userId))
      .map((group) => group.category))
    : null;
  let groups = socialStore.state.discussionGroups.filter((group) => {
    const member = socialStore.state.discussionMemberships.find((entry) => entry.groupId === group.id && entry.userId === userId);
    if (socialStore.state.discussionBans.some((ban) => ban.groupId === group.id && ban.userId === userId
      && (!ban.expiresAt || new Date(ban.expiresAt).getTime() > Date.now()))) return false;
    if (group.visibility !== 'VISIBLE' && !member) return false;
    if (filter === 'joined' && !member) return false;
    if (filter === 'managed' && (!member || !managerRoles.includes(member.role))) return false;
    if (filter === 'suggested' && (member || (suggestedCategories?.size && !suggestedCategories.has(group.category)))) return false;
    if (category && group.category.toLowerCase() !== category.toLowerCase()) return false;
    return !query || `${group.name} ${group.description}`.toLowerCase().includes(query.toLowerCase());
  }).sort((a, b) => filter === 'popular' || filter === 'suggested'
    ? socialStore.state.discussionMemberships.filter((entry) => entry.groupId === b.id).length - socialStore.state.discussionMemberships.filter((entry) => entry.groupId === a.id).length || b.createdAt.localeCompare(a.createdAt)
    : b.createdAt.localeCompare(a.createdAt));
  if (cursor) groups = groups.slice(Math.max(0, groups.findIndex((group) => group.id === cursor) + 1));
  const page = groups.slice(0, take);
  return res.json({
    groups: page.map((group) => {
      const membership = socialStore.state.discussionMemberships.find((entry) => entry.groupId === group.id && entry.userId === userId);
      return { ...group, memberCount: socialStore.state.discussionMemberships.filter((entry) => entry.groupId === group.id).length, joined: Boolean(membership), myRole: membership?.role ?? null };
    }),
    nextCursor: groups.length > take ? page.at(-1)?.id ?? null : null,
  });
});

router.post('/discussion-groups', requireAuth, async (req, res) => {
  const payload = groupSchema.parse(req.body ?? {});
  const data = {
    name: payload.name,
    description: payload.description ?? '',
    category: payload.category ?? 'General',
    avatarUrl: payload.avatarUrl ?? null,
    coverUrl: payload.coverUrl ?? null,
    privacy: payload.privacy ?? 'PUBLIC',
    visibility: payload.visibility ?? 'VISIBLE',
    membershipApproval: payload.privacy === 'PRIVATE' || (payload.membershipApproval ?? false),
    postApproval: payload.postApproval ?? false,
    rules: payload.rules ?? [],
  };
  for (const url of [data.avatarUrl, data.coverUrl]) {
    if (url && !(await uploadedMediaBelongsTo(url, req.user!.id, env.NODE_ENV))) {
      return res.status(400).json({ message: 'Group images must be uploaded by you or use a secure HTTPS URL.' });
    }
  }
  if (await isDatabaseAvailable()) {
    const group = await prisma.discussionGroup.create({
      data: { ...data, ownerId: req.user!.id, memberships: { create: { userId: req.user!.id, role: 'OWNER' } } },
      include: { _count: { select: { memberships: true } } },
    });
    return res.status(201).json({ group: { ...group, memberCount: group._count.memberships, joined: true, myRole: 'OWNER', _count: undefined } });
  }
  const now = nowIso();
  const group = { id: makeId('dg'), ownerId: req.user!.id, ...data, createdAt: now, updatedAt: now };
  socialStore.state.discussionGroups.push(group);
  socialStore.state.discussionMemberships.push({
    id: makeId('dg_member'), groupId: group.id, userId: req.user!.id, role: 'OWNER', joinedAt: now,
    postingRestrictedUntil: null, suspendedUntil: null,
  });
  return res.status(201).json({ group: { ...group, memberCount: 1, joined: true, myRole: 'OWNER' } });
});

router.get('/discussion-groups/invitations', requireAuth, async (req, res) => {
  if (await isDatabaseAvailable()) {
    const invitations = await prisma.discussionGroupInvitation.findMany({
      where: { inviteeId: req.user!.id, status: 'PENDING' },
      include: { group: { select: { id: true, name: true, avatarUrl: true, privacy: true } }, inviter: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ invitations });
  }
  return res.json({ invitations: socialStore.state.discussionInvitations.filter((invite) => invite.inviteeId === req.user!.id && invite.status === 'PENDING').map((invite) => ({
    ...invite, group: socialStore.state.discussionGroups.find((group) => group.id === invite.groupId) ?? null, inviter: safeUserSummary(invite.inviterId),
  })) });
});

router.post('/discussion-groups/:id/invitations', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const inviteeId = z.object({ userId: z.string().min(1) }).parse(req.body ?? {}).userId;
  const group = await findGroup(groupId);
  if (!group) return res.status(404).json({ message: 'Discussion group not found.' });
  if (!(await canManage(groupId, req.user!.id))) return res.status(403).json({ message: 'Only group administrators may invite people.' });
  if (inviteeId === req.user!.id || await findMembership(groupId, inviteeId)) return res.status(409).json({ message: 'That user is already a group member.' });
  if (await activeBan(groupId, inviteeId)) return res.status(403).json({ message: 'That user is banned from this group.' });
  const invitee = await (async () => await isDatabaseAvailable()
    ? prisma.user.findUnique({ where: { id: inviteeId }, select: { id: true } })
    : findUserById(inviteeId))();
  if (!invitee) return res.status(404).json({ message: 'User not found.' });
  if (await isDatabaseAvailable()) {
    const invitation = await prisma.discussionGroupInvitation.upsert({
      where: { groupId_inviteeId: { groupId, inviteeId } },
      create: { groupId, inviteeId, inviterId: req.user!.id },
      update: { status: 'PENDING', inviterId: req.user!.id, createdAt: new Date(), respondedAt: null },
    });
    await createNotification(inviteeId, req.user!.id, 'discussion_group_invitation', `You were invited to join ${group.name}.`, { link: '/discussion-groups' });
    return res.status(201).json({ invitation });
  }
  const previous = socialStore.state.discussionInvitations.find((entry) => entry.groupId === groupId && entry.inviteeId === inviteeId);
  const invitation = previous
    ? Object.assign(previous, { inviterId: req.user!.id, status: 'PENDING' as const, createdAt: nowIso(), respondedAt: null })
    : { id: makeId('dg_invite'), groupId, inviteeId, inviterId: req.user!.id, status: 'PENDING' as const, createdAt: nowIso(), respondedAt: null };
  if (!previous) socialStore.state.discussionInvitations.push(invitation);
  await createNotification(inviteeId, req.user!.id, 'discussion_group_invitation', `You were invited to join ${group.name}.`, { link: '/discussion-groups' });
  return res.status(201).json({ invitation });
});

router.post('/discussion-groups/invitations/:invitationId/respond', requireAuth, async (req, res) => {
  const invitationId = String(req.params.invitationId);
  const { accept } = z.object({ accept: z.boolean() }).parse(req.body ?? {});
  if (await isDatabaseAvailable()) {
    const invitation = await prisma.discussionGroupInvitation.findFirst({ where: { id: invitationId, inviteeId: req.user!.id, status: 'PENDING' }, include: { group: true } });
    if (!invitation) return res.status(404).json({ message: 'Invitation not found.' });
    if (await activeBan(invitation.groupId, req.user!.id)) return res.status(403).json({ message: 'You are banned from this group.' });
    await prisma.$transaction(async (tx) => {
      await tx.discussionGroupInvitation.update({ where: { id: invitationId }, data: { status: accept ? 'ACCEPTED' : 'REJECTED', respondedAt: new Date() } });
      if (accept) await tx.discussionGroupMembership.upsert({
        where: { groupId_userId: { groupId: invitation.groupId, userId: req.user!.id } },
        create: { groupId: invitation.groupId, userId: req.user!.id },
        update: {},
      });
    });
    return res.json({ accepted: accept });
  }
  const invitation = socialStore.state.discussionInvitations.find((entry) => entry.id === invitationId && entry.inviteeId === req.user!.id && entry.status === 'PENDING');
  if (!invitation) return res.status(404).json({ message: 'Invitation not found.' });
  if (await activeBan(invitation.groupId, req.user!.id)) return res.status(403).json({ message: 'You are banned from this group.' });
  invitation.status = accept ? 'ACCEPTED' : 'REJECTED';
  invitation.respondedAt = nowIso();
  if (accept) socialStore.state.discussionMemberships.push({
    id: makeId('dg_member'), groupId: invitation.groupId, userId: req.user!.id, role: 'MEMBER', joinedAt: nowIso(),
    postingRestrictedUntil: null, suspendedUntil: null,
  });
  return res.json({ accepted: accept });
});

router.get('/discussion-groups/:id/members', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const { group } = await getVisibleGroup(groupId, req.user!.id);
  if (!group) return res.status(404).json({ message: 'Discussion group not found.' });
  const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const take = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  if (await isDatabaseAvailable()) {
    const members = await prisma.discussionGroupMembership.findMany({
      where: {
        groupId,
        ...(query ? { user: { OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { profile: { displayName: { contains: query, mode: 'insensitive' } } },
          { profile: { username: { contains: query, mode: 'insensitive' } } },
        ] } } : {}),
      },
      include: { user: { select: { id: true, name: true, profile: { select: { displayName: true, avatarUrl: true, username: true } } } } },
      orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
      take,
    });
    return res.json({ members });
  }
  const members = socialStore.state.discussionMemberships.filter((entry) => entry.groupId === groupId).map((entry) => {
    const user = findUserById(entry.userId);
    const profile = socialStore.state.profiles.find((item) => item.userId === entry.userId);
    return { ...entry, user: user ? { id: user.id, name: user.name, profile: profile ? { displayName: profile.displayName, avatarUrl: profile.avatarUrl, username: profile.username } : null } : null };
  }).filter((entry) => !query || `${entry.user?.name ?? ''} ${entry.user?.profile?.displayName ?? ''} ${entry.user?.profile?.username ?? ''}`.toLowerCase().includes(query.toLowerCase()))
    .sort((left, right) => left.role.localeCompare(right.role) || left.joinedAt.localeCompare(right.joinedAt))
    .slice(0, take);
  return res.json({ members });
});

router.get('/discussion-groups/:id', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const { group, member } = await getVisibleGroup(groupId, req.user!.id);
  if (!group) return res.status(404).json({ message: 'Discussion group not found.' });
  const pageSize = Math.min(30, Math.max(1, Number(req.query.limit) || 20));
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
  const targetPostId = typeof req.query.postId === 'string' ? req.query.postId.slice(0, 128) : '';
  const sortByNewest = req.query.sort === 'newest';
  if (await isDatabaseAvailable()) {
    const [posts, memberCount] = await Promise.all([
      prisma.discussionGroupPost.findMany({
        where: { groupId, status: 'APPROVED', ...(targetPostId ? { id: targetPostId } : {}) },
        include: {
          author: { select: { id: true, name: true, profile: { select: { displayName: true, avatarUrl: true } } } },
          media: { orderBy: { position: 'asc' } },
          sharedFrom: {
            include: {
              group: { select: { id: true, privacy: true, visibility: true } },
              author: { select: { id: true, name: true, profile: { select: { displayName: true, avatarUrl: true } } } },
              media: { orderBy: { position: 'asc' } },
            },
          },
          poll: { include: { options: { include: { _count: { select: { votes: true } }, votes: { where: { userId: req.user!.id }, select: { id: true } } }, orderBy: { position: 'asc' } } } },
        },
        orderBy: sortByNewest
          ? [{ createdAt: 'desc' }]
          : [{ isFeatured: 'desc' }, { isPinned: 'desc' }, { createdAt: 'desc' }],
        take: targetPostId ? 1 : pageSize + 1,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      }),
      prisma.discussionGroupMembership.count({ where: { groupId } }),
    ]);
    const hasMore = posts.length > pageSize;
    const page = await Promise.all(posts.slice(0, pageSize).map((post) => formatPost(post, req.user!.id)));
    const members = member ? await prisma.discussionGroupMembership.findMany({
      where: { groupId },
      include: { user: { select: { id: true, name: true, profile: { select: { displayName: true, avatarUrl: true, username: true } } } } },
      orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
      take: 100,
    }) : [];
    return res.json({
      group: { ...group, joined: Boolean(member), myRole: member?.role ?? null, memberCount, members, posts: page },
      nextCursor: hasMore ? posts[pageSize - 1]?.id ?? null : null,
    });
  }
  const posts = socialStore.state.discussionPosts
    .filter((post) => post.groupId === groupId && post.status === 'APPROVED' && (!targetPostId || post.id === targetPostId))
    .sort((a, b) => sortByNewest
      ? b.createdAt.localeCompare(a.createdAt)
      : Number(b.isFeatured) - Number(a.isFeatured) || Number(b.isPinned) - Number(a.isPinned) || b.createdAt.localeCompare(a.createdAt));
  const offset = cursor ? Math.max(0, posts.findIndex((post) => post.id === cursor) + 1) : 0;
  const page = await Promise.all(posts.slice(offset, offset + pageSize).map((post) => formatPost(post, req.user!.id)));
  const members = member ? socialStore.state.discussionMemberships.filter((entry) => entry.groupId === groupId).map((entry) => {
    const user = findUserById(entry.userId);
    const profile = socialStore.state.profiles.find((item) => item.userId === user?.id);
    return { ...entry, user: user ? { id: user.id, name: user.name, profile: profile ? { displayName: profile.displayName, avatarUrl: profile.avatarUrl, username: profile.username } : null } : null };
  }) : [];
  return res.json({
    group: { ...group, joined: Boolean(member), myRole: member?.role ?? null, memberCount: socialStore.state.discussionMemberships.filter((entry) => entry.groupId === groupId).length, members, posts: page },
    nextCursor: offset + pageSize < posts.length ? posts[offset + pageSize - 1]?.id ?? null : null,
  });
});

router.patch('/discussion-groups/:id', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const payload = groupSchema.partial().refine((value) => Object.keys(value).length > 0).parse(req.body ?? {});
  const group = await findGroup(groupId);
  if (!group) return res.status(404).json({ message: 'Discussion group not found.' });
  if (!(await canAdmin(groupId, req.user!.id))) return res.status(403).json({ message: 'Only the owner or group administrators can edit group settings.' });
  for (const [url, previousUrl] of [[payload.avatarUrl, group.avatarUrl], [payload.coverUrl, group.coverUrl]] as const) {
    if (url && url !== previousUrl && !(await uploadedMediaBelongsTo(url, req.user!.id, env.NODE_ENV))) {
      return res.status(400).json({ message: 'Group images must be uploaded by you or use a secure HTTPS URL.' });
    }
  }
  const data = {
    ...payload,
    ...(payload.privacy === 'PRIVATE' ? { membershipApproval: true } : {}),
    updatedAt: new Date(),
  };
  if (await isDatabaseAvailable()) return res.json({ group: await prisma.discussionGroup.update({ where: { id: groupId }, data }) });
  Object.assign(group, payload, payload.privacy === 'PRIVATE' ? { membershipApproval: true } : {}, { updatedAt: nowIso() });
  return res.json({ group });
});

router.delete('/discussion-groups/:id', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const group = await findGroup(groupId);
  if (!group) return res.status(404).json({ message: 'Discussion group not found.' });
  if (group.ownerId !== req.user!.id) return res.status(403).json({ message: 'Only the group owner can delete this group.' });
  if (req.body?.confirmName !== group.name) return res.status(400).json({ message: 'Enter the exact group name to confirm deletion.' });
  if (await isDatabaseAvailable()) await prisma.discussionGroup.delete({ where: { id: groupId } });
  else {
    socialStore.state.discussionGroups = socialStore.state.discussionGroups.filter((entry) => entry.id !== groupId);
    socialStore.state.discussionMemberships = socialStore.state.discussionMemberships.filter((entry) => entry.groupId !== groupId);
    socialStore.state.discussionRequests = socialStore.state.discussionRequests.filter((entry) => entry.groupId !== groupId);
    socialStore.state.discussionInvitations = socialStore.state.discussionInvitations.filter((entry) => entry.groupId !== groupId);
    const postIds = socialStore.state.discussionPosts.filter((post) => post.groupId === groupId).map((post) => post.id);
    socialStore.state.discussionBans = socialStore.state.discussionBans.filter((entry) => entry.groupId !== groupId);
    socialStore.state.discussionActions = socialStore.state.discussionActions.filter((entry) => entry.groupId !== groupId);
    removeFallbackDiscussionPosts(new Set(postIds));
  }
  return res.json({ deleted: true });
});

router.post('/discussion-groups/:id/join', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const group = await findGroup(groupId);
  if (!group) return res.status(404).json({ message: 'Discussion group not found.' });
  if (await findMembership(groupId, req.user!.id)) return res.status(409).json({ message: 'You are already a group member.' });
  if (group.visibility === 'HIDDEN') return res.status(404).json({ message: 'Discussion group not found.' });
  if (await activeBan(groupId, req.user!.id)) return res.status(403).json({ message: 'You are banned from this group.' });
  const needsApproval = group.privacy === 'PRIVATE' || group.membershipApproval;
  if (await isDatabaseAvailable()) {
    if (needsApproval) {
      const request = await prisma.discussionGroupMembershipRequest.upsert({
        where: { groupId_userId: { groupId, userId: req.user!.id } },
        create: { groupId, userId: req.user!.id },
        update: { status: 'PENDING', createdAt: new Date() },
      });
      await createNotification(group.ownerId, req.user!.id, 'discussion_group_membership_request', `${req.user!.name} requested to join ${group.name}.`, { link: '/discussion-groups' });
      return res.status(202).json({ requested: true, request });
    }
    const membership = await prisma.discussionGroupMembership.create({ data: { groupId, userId: req.user!.id } });
    return res.status(201).json({ joined: true, membership });
  }
  if (needsApproval) {
    const existing = socialStore.state.discussionRequests.find((entry) => entry.groupId === groupId && entry.userId === req.user!.id);
    const request = existing
      ? Object.assign(existing, { status: 'PENDING' as const, createdAt: nowIso(), updatedAt: nowIso() })
      : { id: makeId('dg_request'), groupId, userId: req.user!.id, status: 'PENDING' as const, createdAt: nowIso(), updatedAt: nowIso() };
    if (!existing) socialStore.state.discussionRequests.push(request);
    await createNotification(group.ownerId, req.user!.id, 'discussion_group_membership_request', `${req.user!.name} requested to join ${group.name}.`, { link: '/discussion-groups' });
    return res.status(202).json({ requested: true, request });
  }
  const membership = { id: makeId('dg_member'), groupId, userId: req.user!.id, role: 'MEMBER' as const, joinedAt: nowIso(), postingRestrictedUntil: null, suspendedUntil: null };
  socialStore.state.discussionMemberships.push(membership);
  return res.status(201).json({ joined: true, membership });
});

router.post('/discussion-groups/:id/leave', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const member = await findMembership(groupId, req.user!.id);
  if (!member) return res.status(404).json({ message: 'Group membership not found.' });
  if (member.role === 'OWNER') return res.status(409).json({ message: 'Transfer ownership before leaving the group.' });
  if (await isDatabaseAvailable()) await prisma.discussionGroupMembership.delete({ where: { groupId_userId: { groupId, userId: req.user!.id } } });
  else socialStore.state.discussionMemberships = socialStore.state.discussionMemberships.filter((entry) => entry.id !== member.id);
  return res.json({ left: true });
});

router.get('/discussion-groups/:id/requests', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  if (!(await canManage(groupId, req.user!.id))) return res.status(403).json({ message: 'Only group moderators can manage membership requests.' });
  if (await isDatabaseAvailable()) {
    const requests = await prisma.discussionGroupMembershipRequest.findMany({
      where: { groupId, status: 'PENDING' },
      include: { user: { select: { id: true, name: true, profile: { select: { avatarUrl: true, username: true } } } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return res.json({ requests });
  }
  return res.json({ requests: socialStore.state.discussionRequests.filter((entry) => entry.groupId === groupId && entry.status === 'PENDING').map((entry) => ({ ...entry, user: safeUserSummary(entry.userId) })) });
});

router.post('/discussion-groups/:id/requests/:requestId/decision', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const requestId = String(req.params.requestId);
  const { approve } = z.object({ approve: z.boolean() }).parse(req.body ?? {});
  if (!(await canManage(groupId, req.user!.id))) return res.status(403).json({ message: 'Only group moderators can decide membership requests.' });
  if (await isDatabaseAvailable()) {
    const request = await prisma.discussionGroupMembershipRequest.findFirst({ where: { id: requestId, groupId, status: 'PENDING' } });
    if (!request) return res.status(404).json({ message: 'Pending request not found.' });
    if (approve && await activeBan(groupId, request.userId)) return res.status(409).json({ message: 'Banned users cannot be approved for membership.' });
    await prisma.$transaction(async (tx) => {
      await tx.discussionGroupMembershipRequest.update({ where: { id: requestId }, data: { status: approve ? 'APPROVED' : 'REJECTED' } });
      if (approve) await tx.discussionGroupMembership.upsert({
        where: { groupId_userId: { groupId, userId: request.userId } },
        create: { groupId, userId: request.userId },
        update: {},
      });
    });
    await createNotification(request.userId, req.user!.id, approve ? 'discussion_group_membership_approved' : 'discussion_group_membership_rejected',
      approve ? 'Your request to join the group was approved.' : 'Your request to join the group was declined.', { link: '/discussion-groups' });
    return res.json({ approved: approve });
  }
  const request = socialStore.state.discussionRequests.find((entry) => entry.id === requestId && entry.groupId === groupId && entry.status === 'PENDING');
  if (!request) return res.status(404).json({ message: 'Pending request not found.' });
  if (approve && await activeBan(groupId, request.userId)) return res.status(409).json({ message: 'Banned users cannot be approved for membership.' });
  request.status = approve ? 'APPROVED' : 'REJECTED';
  request.updatedAt = nowIso();
  if (approve) socialStore.state.discussionMemberships.push({
    id: makeId('dg_member'), groupId, userId: request.userId, role: 'MEMBER', joinedAt: nowIso(), postingRestrictedUntil: null, suspendedUntil: null,
  });
  await createNotification(request.userId, req.user!.id, approve ? 'discussion_group_membership_approved' : 'discussion_group_membership_rejected',
    approve ? 'Your request to join the group was approved.' : 'Your request to join the group was declined.', { link: '/discussion-groups' });
  return res.json({ approved: approve });
});

router.patch('/discussion-groups/:id/members/:userId', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const targetId = String(req.params.userId);
  const action = memberActionSchema.parse(req.body ?? {});
  const actor = await findMembership(groupId, req.user!.id);
  const target = await findMembership(groupId, targetId);
  if (!actor || !target && action.action !== 'unban') return res.status(404).json({ message: 'Group member not found.' });
  if (!target && action.action === 'unban') {
    const userExists = await (async () => await isDatabaseAvailable()
      ? prisma.user.findUnique({ where: { id: targetId }, select: { id: true } })
      : findUserById(targetId))();
    if (!userExists) return res.status(404).json({ message: 'User not found.' });
  }
  if (target && (target.role === 'OWNER'
    || actor.role === 'MODERATOR' && target.role !== 'MEMBER'
    || actor.role === 'ADMIN' && target.role === 'ADMIN'
    || actor.userId === targetId && action.action === 'role')) {
    return res.status(403).json({ message: 'You cannot manage a member with equal or higher permissions.' });
  }
  if (action.action === 'role' && !adminRoles.includes(actor.role)) return res.status(403).json({ message: 'Only the owner or an administrator can assign admin or moderator roles.' });
  if (action.action !== 'role' && !managerRoles.includes(actor.role)) return res.status(403).json({ message: 'Only group moderators can moderate members.' });
  const until = 'until' in action && action.until ? new Date(action.until) : null;
  if (action.action === 'ban' || action.action === 'unban') {
    if (await isDatabaseAvailable()) {
      if (action.action === 'ban') await prisma.discussionGroupBan.upsert({
        where: { groupId_userId: { groupId, userId: targetId } },
        create: { groupId, userId: targetId, issuerId: req.user!.id, reason: action.reason ?? null, expiresAt: until },
        update: { issuerId: req.user!.id, reason: action.reason ?? null, expiresAt: until },
      });
      else await prisma.discussionGroupBan.deleteMany({ where: { groupId, userId: targetId } });
    } else {
      const existing = socialStore.state.discussionBans.find((ban) => ban.groupId === groupId && ban.userId === targetId);
      if (action.action === 'ban') {
        const ban = { id: existing?.id ?? makeId('dg_ban'), groupId, userId: targetId, issuerId: req.user!.id, reason: action.reason ?? null, expiresAt: until?.toISOString() ?? null, createdAt: nowIso() };
        if (existing) Object.assign(existing, ban); else socialStore.state.discussionBans.push(ban);
      } else if (existing) socialStore.state.discussionBans = socialStore.state.discussionBans.filter((ban) => ban !== existing);
    }
    if (action.action === 'ban' && target) {
      if (await isDatabaseAvailable()) {
        await prisma.$transaction([
          prisma.discussionGroupMembership.deleteMany({ where: { groupId, userId: targetId } }),
          prisma.discussionGroupMembershipRequest.updateMany({ where: { groupId, userId: targetId, status: 'PENDING' }, data: { status: 'REJECTED' } }),
          prisma.discussionGroupInvitation.updateMany({ where: { groupId, inviteeId: targetId, status: 'PENDING' }, data: { status: 'REJECTED', respondedAt: new Date() } }),
        ]);
      } else {
        socialStore.state.discussionMemberships = socialStore.state.discussionMemberships.filter((entry) => !(entry.groupId === groupId && entry.userId === targetId));
        socialStore.state.discussionRequests = socialStore.state.discussionRequests.map((entry) =>
          entry.groupId === groupId && entry.userId === targetId && entry.status === 'PENDING'
            ? { ...entry, status: 'REJECTED', updatedAt: nowIso() }
            : entry);
        socialStore.state.discussionInvitations = socialStore.state.discussionInvitations.map((entry) =>
          entry.groupId === groupId && entry.inviteeId === targetId && entry.status === 'PENDING'
            ? { ...entry, status: 'REJECTED', respondedAt: nowIso() }
            : entry);
      }
    }
    await addAction(groupId, req.user!.id, action.action, targetId, action.action === 'ban' ? action.reason : null);
    await notifyMembershipChange(groupId, req.user!.id, targetId, action.action === 'ban' ? 'banned' : 'unbanned');
    return res.json({ action: action.action, userId: targetId });
  }
  if (!target) return res.status(404).json({ message: 'Group member not found.' });
  const field = action.action === 'role' ? { role: action.role }
    : action.action === 'restrict' ? { postingRestrictedUntil: until }
      : { suspendedUntil: until };
  if (await isDatabaseAvailable()) {
    const membership = await prisma.discussionGroupMembership.update({ where: { groupId_userId: { groupId, userId: targetId } }, data: field });
    await addAction(groupId, req.user!.id, action.action, targetId, until?.toISOString() ?? null);
    await notifyMembershipChange(groupId, req.user!.id, targetId, action.action === 'role' ? 'updated your role' : action.action === 'restrict' ? 'restricted posting' : 'suspended');
    return res.json({ membership });
  }
  Object.assign(target, field);
  await addAction(groupId, req.user!.id, action.action, targetId, until?.toISOString() ?? null);
  await notifyMembershipChange(groupId, req.user!.id, targetId, action.action === 'role' ? 'updated your role' : action.action === 'restrict' ? 'restricted posting' : 'suspended');
  return res.json({ membership: target });
});

router.delete('/discussion-groups/:id/members/:userId', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const targetId = String(req.params.userId);
  const actor = await findMembership(groupId, req.user!.id);
  const target = await findMembership(groupId, targetId);
  if (!actor || !target) return res.status(404).json({ message: 'Group member not found.' });
  if (!managerRoles.includes(actor.role)) return res.status(403).json({ message: 'Only group moderators can remove members.' });
  if (target.role === 'OWNER') return res.status(409).json({ message: 'The group owner cannot be removed.' });
  if (actor.role === 'MODERATOR' && target.role !== 'MEMBER' || actor.role === 'ADMIN' && target.role === 'ADMIN') {
    return res.status(403).json({ message: 'You cannot remove a member with equal or higher permissions.' });
  }
  if (await isDatabaseAvailable()) await prisma.discussionGroupMembership.delete({ where: { groupId_userId: { groupId, userId: targetId } } });
  else socialStore.state.discussionMemberships = socialStore.state.discussionMemberships.filter((entry) => entry.id !== target.id);
  await addAction(groupId, req.user!.id, 'remove_member', targetId);
  await notifyMembershipChange(groupId, req.user!.id, targetId, 'removed');
  return res.json({ removed: targetId });
});

router.post('/discussion-groups/:id/posts', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const payload = postSchema.parse(req.body ?? {});
  const { group } = await getVisibleGroup(groupId, req.user!.id);
  if (!group) return res.status(404).json({ message: 'Discussion group not found.' });
  const member = await requireActiveMember(groupId, req.user!.id);
  if (!member) return res.status(403).json({ message: 'Only active members can post in this group.' });
  if (await activeBan(groupId, req.user!.id)) return res.status(403).json({ message: 'You are banned from this group.' });
  if (member.postingRestrictedUntil && new Date(member.postingRestrictedUntil).getTime() > Date.now()) return res.status(403).json({ message: 'Your posting ability is temporarily restricted.' });
  if (group.postApproval && !managerRoles.includes(member.role) && payload.type !== 'ANNOUNCEMENT') {
    // Member posts remain pending until an administrator approves them.
  } else if (payload.type === 'ANNOUNCEMENT' && !managerRoles.includes(member.role)) {
    return res.status(403).json({ message: 'Only group moderators may publish announcements.' });
  }
  if (payload.type === 'LINK' && !payload.linkUrl) return res.status(400).json({ message: 'Link posts require a valid URL.' });
  if (payload.type === 'POLL' && !payload.pollOptions) return res.status(400).json({ message: 'Poll posts require at least two options.' });
  if (payload.type === 'VIDEO' && !payload.media.some((media) => media.type === 'VIDEO')) return res.status(400).json({ message: 'Video posts must include an uploaded video.' });
  if (payload.type === 'IMAGE' && !payload.media.some((media) => media.type === 'IMAGE')) return res.status(400).json({ message: 'Image posts must include at least one image.' });
  if (!(await validateMediaOwnership(payload.media, req.user!.id))) return res.status(400).json({ message: 'Post media must be uploaded by you.' });
  if (await isDatabaseAvailable()) {
    const post = await prisma.discussionGroupPost.create({
      data: {
        groupId,
        authorId: req.user!.id,
        type: payload.type,
        content: payload.content,
        linkUrl: payload.linkUrl ?? null,
        status: group.postApproval && !managerRoles.includes(member.role) ? 'PENDING' : 'APPROVED',
        media: { create: payload.media.map((media, position) => ({ mediaUrl: media.url, mediaType: media.type, position })) },
        ...(payload.pollOptions ? { poll: { create: { options: { create: payload.pollOptions.map((text, position) => ({ text, position })) } } } } : {}),
      },
      include: { author: { select: { id: true, name: true, profile: { select: { displayName: true, avatarUrl: true } } } }, media: true, poll: { include: { options: true } } },
    });
    if (post.status === 'APPROVED') {
      const recipients = await prisma.discussionGroupMembership.findMany({
        where: { groupId, userId: { not: req.user!.id } },
        select: { userId: true },
      });
      await Promise.all(recipients.map(({ userId }) => createNotification(
        userId, req.user!.id, 'discussion_group_post', `${group.name} has a new post.`, { link: `/discussion-groups/${groupId}` },
      )));
    }
    if (post.status === 'APPROVED') await notifyDiscussionMentions(payload.content, req.user!.id, groupId);
    if (post.status === 'APPROVED') await emitDiscussionFeedUpdate(groupId, group);
    return res.status(201).json({ post: await formatPost(post, req.user!.id) });
  }
  const now = nowIso();
  const post = {
    id: makeId('dg_post'), groupId, authorId: req.user!.id, type: payload.type, content: payload.content,
    linkUrl: payload.linkUrl ?? null, status: group.postApproval && !managerRoles.includes(member.role) ? 'PENDING' : 'APPROVED',
    isPinned: false, isFeatured: false, createdAt: now, updatedAt: now, author: safeUserSummary(req.user!.id),
  };
  socialStore.state.discussionPosts.push(post);
  payload.media.forEach((media, position) => socialStore.state.discussionPostMedia.push({
    id: makeId('dg_media'), postId: post.id, mediaUrl: media.url, mediaType: media.type, position, createdAt: now,
  }));
  if (payload.pollOptions) {
    const poll = { id: makeId('dg_poll'), postId: post.id, createdAt: now };
    socialStore.state.discussionPolls.push(poll);
    payload.pollOptions.forEach((text, position) => socialStore.state.discussionPollOptions.push({ id: makeId('dg_option'), pollId: poll.id, text, position, createdAt: now }));
  }
  const recipients = socialStore.state.discussionMemberships.filter((entry) => entry.groupId === groupId && entry.userId !== req.user!.id);
  await Promise.all(recipients.map((recipient) => createNotification(recipient.userId, req.user!.id, 'discussion_group_post', `${group.name} has a new post.`, { link: `/discussion-groups/${groupId}` })));
  if (post.status === 'APPROVED') await notifyDiscussionMentions(payload.content, req.user!.id, groupId);
  if (post.status === 'APPROVED') await emitDiscussionFeedUpdate(groupId, group);
  return res.status(201).json({ post: await formatPost(post, req.user!.id) });
});

router.get('/discussion-groups/:id/admin', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  if (!(await canManage(groupId, req.user!.id))) return res.status(403).json({ message: 'Only group moderators can access management.' });
  if (await isDatabaseAvailable()) {
    const [requests, pendingPosts, reports, actions, bans] = await Promise.all([
      prisma.discussionGroupMembershipRequest.findMany({ where: { groupId, status: 'PENDING' }, include: { user: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } }),
      prisma.discussionGroupPost.findMany({ where: { groupId, status: 'PENDING' }, include: { author: { select: { id: true, name: true } }, media: true }, orderBy: { createdAt: 'asc' } }),
      prisma.discussionGroupReport.findMany({ where: { groupId, status: 'OPEN' }, include: { reporter: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } }),
      prisma.discussionGroupModerationAction.findMany({ where: { groupId }, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.discussionGroupBan.findMany({ where: { groupId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, include: { user: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' } }),
    ]);
    return res.json({ requests, pendingPosts, reports, actions, bans });
  }
  const pendingPostIds = new Set(socialStore.state.discussionPosts.filter((post) => post.groupId === groupId && post.status === 'PENDING').map((post) => post.id));
  return res.json({
    requests: socialStore.state.discussionRequests.filter((entry) => entry.groupId === groupId && entry.status === 'PENDING').map((entry) => ({ ...entry, user: safeUserSummary(entry.userId) })),
    pendingPosts: socialStore.state.discussionPosts.filter((post) => pendingPostIds.has(post.id)),
    reports: socialStore.state.discussionReports.filter((report) => report.groupId === groupId && report.status === 'OPEN'),
    actions: socialStore.state.discussionActions.filter((entry) => entry.groupId === groupId).slice(-50).reverse(),
    bans: socialStore.state.discussionBans.filter((ban) => ban.groupId === groupId && (!ban.expiresAt || new Date(ban.expiresAt).getTime() > Date.now())).map((ban) => ({ ...ban, user: safeUserSummary(ban.userId) })),
  });
});

router.post('/discussion-groups/:id/posts/:postId/decision', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const postId = String(req.params.postId);
  const { approve } = z.object({ approve: z.boolean() }).parse(req.body ?? {});
  if (!(await canManage(groupId, req.user!.id))) return res.status(403).json({ message: 'Only group moderators can approve posts.' });
  if (await isDatabaseAvailable()) {
    const post = await prisma.discussionGroupPost.findFirst({ where: { id: postId, groupId, status: 'PENDING' } });
    if (!post) return res.status(404).json({ message: 'Pending post not found.' });
    const updated = await prisma.discussionGroupPost.update({ where: { id: postId }, data: { status: approve ? 'APPROVED' : 'REJECTED' } });
    if (approve) {
      await createNotification(post.authorId, req.user!.id, 'discussion_group_post_approved', 'Your group post was approved.', { link: `/discussion-groups/${groupId}` });
      await notifyDiscussionMentions(post.content, post.authorId, groupId);
      const group = await findGroup(groupId);
      if (group) await emitDiscussionFeedUpdate(groupId, group);
    }
    await addAction(groupId, req.user!.id, approve ? 'approve_post' : 'reject_post', post.authorId, postId);
    return res.json({ post: updated });
  }
  const post = socialStore.state.discussionPosts.find((entry) => entry.id === postId && entry.groupId === groupId && entry.status === 'PENDING');
  if (!post) return res.status(404).json({ message: 'Pending post not found.' });
  post.status = approve ? 'APPROVED' : 'REJECTED';
  post.updatedAt = nowIso();
  await addAction(groupId, req.user!.id, approve ? 'approve_post' : 'reject_post', post.authorId, postId);
  if (approve) {
    await createNotification(post.authorId, req.user!.id, 'discussion_group_post_approved', 'Your group post was approved.', { link: `/discussion-groups/${groupId}` });
    await notifyDiscussionMentions(post.content, post.authorId, groupId);
    const group = await findGroup(groupId);
    if (group) await emitDiscussionFeedUpdate(groupId, group);
  }
  return res.json({ post });
});

router.patch('/discussion-groups/:id/posts/:postId', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const postId = String(req.params.postId);
  const payload = postEditSchema.parse(req.body ?? {});
  const member = await findMembership(groupId, req.user!.id);
  if (!member) return res.status(403).json({ message: 'Group membership is required.' });
  if (!managerRoles.includes(member.role) && member.suspendedUntil && new Date(member.suspendedUntil).getTime() > Date.now()) return res.status(403).json({ message: 'Your group membership is temporarily suspended.' });
  if (await isDatabaseAvailable()) {
    const post = await prisma.discussionGroupPost.findFirst({
      where: { id: postId, groupId },
      include: {
        media: true,
        poll: { include: { options: { include: { _count: { select: { votes: true } } } } } },
      },
    });
    if (!post) return res.status(404).json({ message: 'Post not found.' });
    if (post.authorId !== req.user!.id && !managerRoles.includes(member.role)) return res.status(403).json({ message: 'You cannot edit this post.' });
    const type = payload.type ?? post.type;
    const content = payload.content ?? post.content;
    const linkUrl = payload.linkUrl === undefined ? post.linkUrl : payload.linkUrl;
    const media = payload.media ?? post.media.map((item) => ({ url: item.mediaUrl, type: item.mediaType as 'IMAGE' | 'VIDEO' }));
    const pollOptions = payload.pollOptions ?? (post.poll?.options.map((option) => option.text));
    if (type === 'ANNOUNCEMENT' && !managerRoles.includes(member.role)) return res.status(403).json({ message: 'Only group moderators may publish announcements.' });
    if (!content && !media.length && !linkUrl && !(type === 'POLL' && pollOptions?.length)) return res.status(400).json({ message: 'A post must include text, media, a link, or a poll.' });
    if (type === 'LINK' && !linkUrl) return res.status(400).json({ message: 'Link posts require a valid URL.' });
    if (type === 'IMAGE' && !media.some((item) => item.type === 'IMAGE')) return res.status(400).json({ message: 'Image posts must include at least one image.' });
    if (type === 'VIDEO' && !media.some((item) => item.type === 'VIDEO')) return res.status(400).json({ message: 'Video posts must include an uploaded video.' });
    if (type === 'POLL' && (!pollOptions || pollOptions.length < 2)) return res.status(400).json({ message: 'Poll posts require at least two options.' });
    const oldMediaUrls = new Set(post.media.map((item) => item.mediaUrl));
    if (!(await validateMediaOwnership(media.filter((item) => !oldMediaUrls.has(item.url)), req.user!.id))) {
      return res.status(400).json({ message: 'New post media must be uploaded by you.' });
    }
    const pollHasVotes = post.poll?.options.some((option) => option._count.votes > 0) ?? false;
    const pollChanged = Boolean(post.poll && (type !== 'POLL'
      || payload.pollOptions && JSON.stringify(payload.pollOptions) !== JSON.stringify(post.poll.options.map((option) => option.text))));
    if (pollHasVotes && pollChanged) return res.status(409).json({ message: 'A poll cannot be changed after members have voted.' });
    const updated = await prisma.$transaction(async (tx) => {
      await tx.discussionGroupPost.update({
        where: { id: postId },
        data: { type, content, linkUrl },
      });
      if (payload.media) {
        await tx.discussionGroupPostMedia.deleteMany({ where: { postId } });
        if (media.length) await tx.discussionGroupPostMedia.createMany({
          data: media.map((item, position) => ({ postId, mediaUrl: item.url, mediaType: item.type, position })),
        });
      }
      if (post.poll && type !== 'POLL') {
        await tx.discussionGroupPoll.delete({ where: { postId } });
      } else if (type === 'POLL' && !post.poll) {
        await tx.discussionGroupPoll.create({
          data: { postId, options: { create: pollOptions!.map((text, position) => ({ text, position })) } },
        });
      } else if (type === 'POLL' && payload.pollOptions) {
        await tx.discussionGroupPollOption.deleteMany({ where: { pollId: post.poll!.id } });
        await tx.discussionGroupPollOption.createMany({
          data: payload.pollOptions.map((text, position) => ({ pollId: post.poll!.id, text, position })),
        });
      }
      return tx.discussionGroupPost.findUniqueOrThrow({
        where: { id: postId },
        include: {
          author: { select: { id: true, name: true, profile: { select: { displayName: true, avatarUrl: true } } } },
          media: { orderBy: { position: 'asc' } },
          sharedFrom: {
            include: {
              group: { select: { id: true, privacy: true, visibility: true } },
              author: { select: { id: true, name: true, profile: { select: { displayName: true, avatarUrl: true } } } },
              media: { orderBy: { position: 'asc' } },
            },
          },
          poll: { include: { options: { include: { _count: { select: { votes: true } }, votes: { where: { userId: req.user!.id }, select: { id: true } } }, orderBy: { position: 'asc' } } } },
        },
      });
    });
    if (updated.status === 'APPROVED') await notifyDiscussionMentions(content, req.user!.id, groupId);
    return res.json({ post: await formatPost(updated, req.user!.id) });
  }
  const post = socialStore.state.discussionPosts.find((entry) => entry.id === postId && entry.groupId === groupId);
  if (!post) return res.status(404).json({ message: 'Post not found.' });
  if (post.authorId !== req.user!.id && !managerRoles.includes(member.role)) return res.status(403).json({ message: 'You cannot edit this post.' });
  const type = payload.type ?? post.type;
  const content = payload.content ?? post.content;
  const linkUrl = payload.linkUrl === undefined ? post.linkUrl : payload.linkUrl;
  const oldMedia = socialStore.state.discussionPostMedia.filter((item) => item.postId === postId);
  const media = payload.media ?? oldMedia.map((item) => ({ url: item.mediaUrl, type: item.mediaType as 'IMAGE' | 'VIDEO' }));
  const poll = socialStore.state.discussionPolls.find((entry) => entry.postId === postId);
  const options = poll ? socialStore.state.discussionPollOptions.filter((option) => option.pollId === poll.id) : [];
  const pollOptions = payload.pollOptions ?? options.map((option) => option.text);
  if (type === 'ANNOUNCEMENT' && !managerRoles.includes(member.role)) return res.status(403).json({ message: 'Only group moderators may publish announcements.' });
  if (!content && !media.length && !linkUrl && !(type === 'POLL' && pollOptions.length)) return res.status(400).json({ message: 'A post must include text, media, a link, or a poll.' });
  if (type === 'LINK' && !linkUrl) return res.status(400).json({ message: 'Link posts require a valid URL.' });
  if (type === 'IMAGE' && !media.some((item) => item.type === 'IMAGE')) return res.status(400).json({ message: 'Image posts must include at least one image.' });
  if (type === 'VIDEO' && !media.some((item) => item.type === 'VIDEO')) return res.status(400).json({ message: 'Video posts must include an uploaded video.' });
  if (type === 'POLL' && pollOptions.length < 2) return res.status(400).json({ message: 'Poll posts require at least two options.' });
  const oldMediaUrls = new Set(oldMedia.map((item) => item.mediaUrl));
  if (!(await validateMediaOwnership(media.filter((item) => !oldMediaUrls.has(item.url)), req.user!.id))) {
    return res.status(400).json({ message: 'New post media must be uploaded by you.' });
  }
  const pollHasVotes = options.some((option) => socialStore.state.discussionPollVotes.some((vote) => vote.optionId === option.id));
  const pollChanged = Boolean(poll && (type !== 'POLL'
    || payload.pollOptions && JSON.stringify(payload.pollOptions) !== JSON.stringify(options.map((option) => option.text))));
  if (pollHasVotes && pollChanged) return res.status(409).json({ message: 'A poll cannot be changed after members have voted.' });
  Object.assign(post, { type, content, linkUrl, updatedAt: nowIso() });
  if (payload.media) {
    socialStore.state.discussionPostMedia = socialStore.state.discussionPostMedia.filter((item) => item.postId !== postId);
    media.forEach((item, position) => socialStore.state.discussionPostMedia.push({
      id: makeId('dg_media'), postId, mediaUrl: item.url, mediaType: item.type, position, createdAt: nowIso(),
    }));
  }
  if (poll && type !== 'POLL') {
    const optionIds = new Set(options.map((option) => option.id));
    socialStore.state.discussionPollVotes = socialStore.state.discussionPollVotes.filter((vote) => !optionIds.has(vote.optionId));
    socialStore.state.discussionPollOptions = socialStore.state.discussionPollOptions.filter((option) => option.pollId !== poll.id);
    socialStore.state.discussionPolls = socialStore.state.discussionPolls.filter((entry) => entry.id !== poll.id);
  } else if (type === 'POLL' && !poll) {
    const newPoll = { id: makeId('dg_poll'), postId, createdAt: nowIso() };
    socialStore.state.discussionPolls.push(newPoll);
    pollOptions.forEach((text, position) => socialStore.state.discussionPollOptions.push({
      id: makeId('dg_option'), pollId: newPoll.id, text, position, createdAt: nowIso(),
    }));
  } else if (type === 'POLL' && payload.pollOptions) {
    socialStore.state.discussionPollOptions = socialStore.state.discussionPollOptions.filter((option) => option.pollId !== poll!.id);
    pollOptions.forEach((text, position) => socialStore.state.discussionPollOptions.push({
      id: makeId('dg_option'), pollId: poll!.id, text, position, createdAt: nowIso(),
    }));
  }
  if (post.status === 'APPROVED') await notifyDiscussionMentions(content, req.user!.id, groupId);
  return res.json({ post });
});

router.delete('/discussion-groups/:id/posts/:postId', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const postId = String(req.params.postId);
  const member = await findMembership(groupId, req.user!.id);
  if (!member) return res.status(403).json({ message: 'Group membership is required.' });
  if (!managerRoles.includes(member.role) && member.suspendedUntil && new Date(member.suspendedUntil).getTime() > Date.now()) return res.status(403).json({ message: 'Your group membership is temporarily suspended.' });
  if (await isDatabaseAvailable()) {
    const post = await prisma.discussionGroupPost.findFirst({ where: { id: postId, groupId }, select: { authorId: true } });
    if (!post) return res.status(404).json({ message: 'Post not found.' });
    if (post.authorId !== req.user!.id && !managerRoles.includes(member.role)) return res.status(403).json({ message: 'You cannot delete this post.' });
    await prisma.discussionGroupPost.delete({ where: { id: postId } });
    return res.json({ deleted: true });
  }
  const post = socialStore.state.discussionPosts.find((entry) => entry.id === postId && entry.groupId === groupId);
  if (!post) return res.status(404).json({ message: 'Post not found.' });
  if (post.authorId !== req.user!.id && !managerRoles.includes(member.role)) return res.status(403).json({ message: 'You cannot delete this post.' });
  removeFallbackDiscussionPosts(new Set([postId]));
  return res.json({ deleted: true });
});

router.patch('/discussion-groups/:id/posts/:postId/pin', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const postId = String(req.params.postId);
  const { pinned } = z.object({ pinned: z.boolean() }).parse(req.body ?? {});
  if (!(await canManage(groupId, req.user!.id))) return res.status(403).json({ message: 'Only group moderators can pin posts.' });
  if (await isDatabaseAvailable()) {
    const result = await prisma.discussionGroupPost.updateMany({ where: { id: postId, groupId, status: 'APPROVED' }, data: { isPinned: pinned } });
    if (!result.count) return res.status(404).json({ message: 'Post not found.' });
    await addAction(groupId, req.user!.id, pinned ? 'pin_post' : 'unpin_post', null, postId);
    return res.json({ pinned });
  }
  const post = socialStore.state.discussionPosts.find((entry) => entry.id === postId && entry.groupId === groupId && entry.status === 'APPROVED');
  if (!post) return res.status(404).json({ message: 'Post not found.' });
  post.isPinned = pinned;
  await addAction(groupId, req.user!.id, pinned ? 'pin_post' : 'unpin_post', null, postId);
  return res.json({ pinned });
});

router.patch('/discussion-groups/:id/posts/:postId/feature', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const postId = String(req.params.postId);
  const { featured } = z.object({ featured: z.boolean() }).parse(req.body ?? {});
  if (!(await canManage(groupId, req.user!.id))) return res.status(403).json({ message: 'Only group moderators can feature posts.' });
  if (await isDatabaseAvailable()) {
    const result = await prisma.discussionGroupPost.updateMany({
      where: { id: postId, groupId, status: 'APPROVED' },
      data: { isFeatured: featured },
    });
    if (!result.count) return res.status(404).json({ message: 'Post not found.' });
  } else {
    const post = socialStore.state.discussionPosts.find((entry) => entry.id === postId && entry.groupId === groupId && entry.status === 'APPROVED');
    if (!post) return res.status(404).json({ message: 'Post not found.' });
    post.isFeatured = featured;
  }
  await addAction(groupId, req.user!.id, featured ? 'feature_post' : 'unfeature_post', null, postId);
  return res.json({ featured });
});

router.post('/discussion-groups/:id/posts/:postId/share', requireAuth, async (req, res) => {
  const sourceGroupId = String(req.params.id);
  const sourcePostId = String(req.params.postId);
  const { targetGroupId, content } = z.object({
    targetGroupId: z.string().min(1),
    content: z.string().trim().max(2000).default(''),
  }).parse(req.body ?? {});
  const sourceGroup = await findGroup(sourceGroupId);
  const targetGroup = await findGroup(targetGroupId);
  if (!sourceGroup || !targetGroup) return res.status(404).json({ message: 'Discussion group not found.' });
  if (sourceGroup.privacy !== 'PUBLIC' || sourceGroup.visibility !== 'VISIBLE') {
    return res.status(403).json({ message: 'Only posts from visible public groups can be shared.' });
  }
  if (!await requireActiveMember(sourceGroupId, req.user!.id)) {
    return res.status(403).json({ message: 'You must be an active member of the source group to share this post.' });
  }
  if (sourceGroupId === targetGroupId) return res.status(400).json({ message: 'Choose a different group for the shared post.' });
  const targetMembership = await requireActiveMember(targetGroupId, req.user!.id);
  if (!targetMembership) return res.status(403).json({ message: 'You must be an active member of the destination group.' });
  if (await activeBan(sourceGroupId, req.user!.id) || await activeBan(targetGroupId, req.user!.id)) {
    return res.status(403).json({ message: 'Banned users cannot share posts.' });
  }
  if (targetMembership.postingRestrictedUntil && new Date(targetMembership.postingRestrictedUntil).getTime() > Date.now()) {
    return res.status(403).json({ message: 'Your posting ability is temporarily restricted.' });
  }
  const sourcePost = await (async () => await isDatabaseAvailable()
    ? prisma.discussionGroupPost.findFirst({ where: { id: sourcePostId, groupId: sourceGroupId, status: 'APPROVED' }, select: { id: true } })
    : socialStore.state.discussionPosts.find((post) => post.id === sourcePostId && post.groupId === sourceGroupId && post.status === 'APPROVED'))();
  if (!sourcePost) return res.status(404).json({ message: 'Post not found.' });
  const postStatus = targetGroup.postApproval && !managerRoles.includes(targetMembership.role) ? 'PENDING' : 'APPROVED';
  if (await isDatabaseAvailable()) {
    const post = await prisma.discussionGroupPost.create({
      data: { groupId: targetGroupId, authorId: req.user!.id, type: 'TEXT', content, status: postStatus, sharedFromId: sourcePostId },
      include: {
        author: { select: { id: true, name: true, profile: { select: { displayName: true, avatarUrl: true } } } },
        sharedFrom: {
          include: {
            group: { select: { id: true, privacy: true, visibility: true } },
            author: { select: { id: true, name: true, profile: { select: { displayName: true, avatarUrl: true } } } },
            media: { orderBy: { position: 'asc' } },
          },
        },
      },
    });

    if (postStatus === 'APPROVED') {
      const recipients = await prisma.discussionGroupMembership.findMany({ where: { groupId: targetGroupId, userId: { not: req.user!.id } }, select: { userId: true } });
      await Promise.all(recipients.map(({ userId }) => createNotification(
        userId, req.user!.id, 'discussion_group_share', `${targetGroup.name} has a shared post.`, { link: `/discussion-groups/${targetGroupId}` },
      )));
      await emitDiscussionFeedUpdate(targetGroupId, targetGroup);
    }
    if (post.status === 'APPROVED') await notifyDiscussionMentions(content, req.user!.id, targetGroupId);
    return res.status(201).json({ post: await formatPost(post, req.user!.id) });
  }
  const now = nowIso();
  const post = {
    id: makeId('dg_post'), groupId: targetGroupId, authorId: req.user!.id, type: 'TEXT', content,
    linkUrl: null, status: postStatus, isPinned: false, isFeatured: false, sharedFromId: sourcePostId,
    createdAt: now, updatedAt: now, author: safeUserSummary(req.user!.id),
  };
  socialStore.state.discussionPosts.push(post);
  if (postStatus === 'APPROVED') {
    const recipients = socialStore.state.discussionMemberships.filter((entry) => entry.groupId === targetGroupId && entry.userId !== req.user!.id);
    await Promise.all(recipients.map((recipient) => createNotification(
      recipient.userId, req.user!.id, 'discussion_group_share', `${targetGroup.name} has a shared post.`, { link: `/discussion-groups/${targetGroupId}` },
    )));
    await emitDiscussionFeedUpdate(targetGroupId, targetGroup);
  }
  if (post.status === 'APPROVED') await notifyDiscussionMentions(content, req.user!.id, targetGroupId);
  return res.status(201).json({ post: await formatPost(post, req.user!.id) });
});

router.post('/discussion-groups/:id/posts/:postId/share-count', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const postId = String(req.params.postId);
  const { requestId } = z.object({ requestId: z.string().uuid() }).parse(req.body ?? {});
  if (await isDatabaseAvailable()) {
    const post = await prisma.discussionGroupPost.findFirst({
      where: { id: postId, groupId, status: 'APPROVED', group: { privacy: 'PUBLIC', visibility: 'VISIBLE' } },
      select: { id: true },
    });
    if (!post) return res.status(404).json({ message: 'This group post cannot be shared externally.' });
    await prisma.discussionGroupPostShare.createMany({ data: [{ postId, userId: req.user!.id, requestId }], skipDuplicates: true });
    return res.json({
      shares: await prisma.discussionGroupPostShare.count({ where: { postId } })
        + await prisma.discussionGroupPost.count({ where: { sharedFromId: postId, status: 'APPROVED' } }),
    });
  }
  const post = socialStore.state.discussionPosts.find((entry) => entry.id === postId && entry.groupId === groupId && entry.status === 'APPROVED');
  const group = post && await findGroup(groupId);
  if (!post || group?.privacy !== 'PUBLIC' || group.visibility !== 'VISIBLE') {
    return res.status(404).json({ message: 'This group post cannot be shared externally.' });
  }
  if (!socialStore.state.discussionPostShares.some((entry) => entry.requestId === requestId)) {
    socialStore.state.discussionPostShares.push({ id: makeId('dg_share'), postId, userId: req.user!.id, requestId, createdAt: nowIso() });
  }
  return res.json({
    shares: socialStore.state.discussionPostShares.filter((entry) => entry.postId === postId).length
      + socialStore.state.discussionPosts.filter((entry) => entry.sharedFromId === postId && entry.status === 'APPROVED').length,
  });
});

router.post('/discussion-groups/:id/share', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const { postId, content = '' } = z.object({
    postId: z.string().min(1).max(128),
    content: z.string().trim().max(2000).default(''),
  }).parse(req.body ?? {});
  const group = await findGroup(groupId);
  if (!group) return res.status(404).json({ message: 'Discussion group not found.' });
  const member = await requireActiveMember(groupId, req.user!.id);
  if (!member) return res.status(403).json({ message: 'Only active members can share posts to this group.' });
  if (await activeBan(groupId, req.user!.id)) return res.status(403).json({ message: 'You are banned from this group.' });
  if (member.postingRestrictedUntil && new Date(member.postingRestrictedUntil).getTime() > Date.now()) {
    return res.status(403).json({ message: 'Your posting ability is temporarily restricted.' });
  }
  const db = await isDatabaseAvailable();
  const source = db
    ? await prisma.post.findUnique({ where: { id: postId }, select: { id: true, visibility: true, moderationHiddenAt: true } })
    : socialStore.state.posts.find((entry) => entry.id === postId) ?? null;
  if (!source || source.visibility !== 'PUBLIC' || source.moderationHiddenAt) {
    return res.status(404).json({ message: 'This post cannot be shared to a group.' });
  }
  const status = group.postApproval && !managerRoles.includes(member.role) ? 'PENDING' : 'APPROVED';
  if (db) {
    const post = await prisma.discussionGroupPost.create({
      data: { groupId, authorId: req.user!.id, type: 'TEXT', content, status, sharedPostId: source.id },
      include: {
        author: { select: { id: true, name: true, profile: { select: { displayName: true, avatarUrl: true } } } },
        sharedPost: { include: { author: { select: { id: true, name: true, profile: { select: { displayName: true, username: true, avatarUrl: true } } } } } },
        media: true,
      },
    });
    if (status === 'APPROVED') await emitDiscussionFeedUpdate(groupId, group);
    return res.status(201).json({ post: await formatPost(post, req.user!.id) });
  }
  const post = {
    id: makeId('dg_post'), groupId, authorId: req.user!.id, type: 'TEXT', content, linkUrl: null, status,
    isPinned: false, isFeatured: false, sharedFromId: null, sharedPostId: source.id,
    createdAt: nowIso(), updatedAt: nowIso(), author: safeUserSummary(req.user!.id),
  };
  socialStore.state.discussionPosts.push(post);
  if (status === 'APPROVED') await emitDiscussionFeedUpdate(groupId, group);
  return res.status(201).json({ post: await formatPost(post, req.user!.id) });
});

router.post('/discussion-groups/:id/posts/:postId/reactions', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const postId = String(req.params.postId);
  const { type } = reactionSchema.parse(req.body ?? {});
  if (!(await requireActiveMember(groupId, req.user!.id))) return res.status(403).json({ message: 'Only active group members can react.' });
  if (await isDatabaseAvailable()) {
    const post = await prisma.discussionGroupPost.findFirst({ where: { id: postId, groupId, status: 'APPROVED' }, select: { id: true } });
    if (!post) return res.status(404).json({ message: 'Post not found.' });
    const reaction = await prisma.discussionGroupPostReaction.upsert({
      where: { postId_userId: { postId, userId: req.user!.id } },
      create: { postId, userId: req.user!.id, type },
      update: { type },
    });
    return res.json({ reaction });
  }
  const post = socialStore.state.discussionPosts.find((entry) => entry.id === postId && entry.groupId === groupId && entry.status === 'APPROVED');
  if (!post) return res.status(404).json({ message: 'Post not found.' });
  const reaction = socialStore.state.discussionPostReactions.find((entry) => entry.postId === postId && entry.userId === req.user!.id);
  if (reaction) Object.assign(reaction, { type }); else socialStore.state.discussionPostReactions.push({ id: makeId('dg_reaction'), postId, userId: req.user!.id, type, createdAt: nowIso() });
  return res.json({ reaction: reaction ?? socialStore.state.discussionPostReactions.at(-1) });
});

router.delete('/discussion-groups/:id/posts/:postId/reactions', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const postId = String(req.params.postId);
  if (!(await requireActiveMember(groupId, req.user!.id))) return res.status(403).json({ message: 'Only active group members can react.' });
  if (await isDatabaseAvailable()) await prisma.discussionGroupPostReaction.deleteMany({ where: { postId, userId: req.user!.id, post: { groupId } } });
  else if (socialStore.state.discussionPosts.some((post) => post.id === postId && post.groupId === groupId)) {
    socialStore.state.discussionPostReactions = socialStore.state.discussionPostReactions.filter((entry) => !(entry.postId === postId && entry.userId === req.user!.id));
  } else return res.status(404).json({ message: 'Post not found.' });
  return res.json({ removed: true });
});

router.get('/discussion-groups/:id/posts/:postId/reactions', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const postId = String(req.params.postId);
  const { group } = await getVisibleGroup(groupId, req.user!.id);
  if (!group) return res.status(404).json({ message: 'Discussion group not found.' });
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30));
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
  if (await isDatabaseAvailable()) {
    const post = await prisma.discussionGroupPost.findFirst({ where: { id: postId, groupId, status: 'APPROVED' }, select: { id: true } });
    if (!post) return res.status(404).json({ message: 'Post not found.' });
    if (cursor && !(await prisma.discussionGroupPostReaction.findFirst({ where: { id: cursor, postId }, select: { id: true } }))) {
      return res.status(400).json({ message: 'Reaction cursor is invalid.' });
    }
    const records = await prisma.discussionGroupPostReaction.findMany({
      where: { postId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, type: true, createdAt: true, user: { select: { id: true, name: true, profile: { select: { displayName: true, avatarUrl: true } } } } },
    });
    const hasMore = records.length > limit;
    const reactions = records.slice(0, limit);
    return res.json({ reactions, nextCursor: hasMore ? reactions.at(-1)?.id ?? null : null });
  }
  if (!socialStore.state.discussionPosts.some((post) => post.id === postId && post.groupId === groupId && post.status === 'APPROVED')) {
    return res.status(404).json({ message: 'Post not found.' });
  }
  const records = socialStore.state.discussionPostReactions.filter((reaction) => reaction.postId === postId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const cursorIndex = cursor ? records.findIndex((reaction) => reaction.id === cursor) : -1;
  if (cursor && cursorIndex < 0) return res.status(400).json({ message: 'Reaction cursor is invalid.' });
  const offset = cursor ? cursorIndex + 1 : 0;
  const page = records.slice(offset, offset + limit + 1);
  const hasMore = page.length > limit;
  const reactions = page.slice(0, limit).map((reaction) => ({ ...reaction, user: safeUserSummary(reaction.userId) }));
  return res.json({ reactions, nextCursor: hasMore ? page[limit - 1]?.id ?? null : null });
});

router.get('/discussion-groups/:id/posts/:postId/comments', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const postId = String(req.params.postId);
  const { group, member } = await getVisibleGroup(groupId, req.user!.id);
  if (!group) return res.status(404).json({ message: 'Discussion group not found.' });
  const postExists = await (async () => await isDatabaseAvailable()
    ? prisma.discussionGroupPost.findFirst({ where: { id: postId, groupId, status: 'APPROVED' }, select: { id: true } })
    : socialStore.state.discussionPosts.find((post) => post.id === postId && post.groupId === groupId && post.status === 'APPROVED'))();
  if (!postExists) return res.status(404).json({ message: 'Post not found.' });
  const parentId = typeof req.query.parentId === 'string' ? req.query.parentId : undefined;
  if (parentId) {
    const parentExists = await (async () => await isDatabaseAvailable()
      ? prisma.discussionGroupComment.findFirst({ where: { id: parentId, postId }, select: { id: true } })
      : socialStore.state.discussionComments.find((comment) => comment.id === parentId && comment.postId === postId))();
    if (!parentExists) return res.status(404).json({ message: 'Parent comment not found.' });
  }
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30));
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
  if (await isDatabaseAvailable()) {
    if (cursor && !(await prisma.discussionGroupComment.findFirst({ where: { id: cursor, postId, parentId: parentId ?? null }, select: { id: true } }))) {
      return res.status(400).json({ message: 'Comment cursor is invalid.' });
    }
    const records = await prisma.discussionGroupComment.findMany({
      where: { postId, parentId: parentId ?? null },
      include: {
        author: { select: { id: true, name: true, profile: { select: { displayName: true, avatarUrl: true } } } },
        _count: { select: { replies: true, reactions: true } },
        reactions: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          include: { user: { select: { id: true, name: true, profile: { select: { displayName: true, avatarUrl: true } } } } },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = records.length > limit;
    const comments = records.slice(0, limit);
    return res.json({ comments, canComment: Boolean(member), nextCursor: hasMore ? records[limit - 1]?.id ?? null : null });
  }
  const records = socialStore.state.discussionComments.filter((comment) => comment.postId === postId && (comment.parentId ?? null) === (parentId ?? null))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const cursorIndex = cursor ? records.findIndex((comment) => comment.id === cursor) : -1;
  if (cursor && cursorIndex < 0) return res.status(400).json({ message: 'Comment cursor is invalid.' });
  const offset = cursor ? cursorIndex + 1 : 0;
  const page = records.slice(offset, offset + limit + 1);
  const hasMore = page.length > limit;
  const nextCursor = hasMore ? String(page[limit - 1]?.['id'] ?? '') || null : null;
  const comments = page.slice(0, limit).map((comment) => ({
      ...comment, author: safeUserSummary(comment.authorId),
      replyCount: socialStore.state.discussionComments.filter((reply) => reply.parentId === comment.id).length,
      reactions: socialStore.state.discussionCommentReactions.filter((reaction) => reaction.commentId === comment.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5)
        .map((reaction) => ({ ...reaction, user: safeUserSummary(reaction.userId) })),
    }));
  return res.json({ comments, canComment: Boolean(member), nextCursor });
});

router.post('/discussion-groups/:id/posts/:postId/comments', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const postId = String(req.params.postId);
  const payload = contentSchema.parse(req.body ?? {});
  const member = await requireActiveMember(groupId, req.user!.id);
  if (!member) return res.status(403).json({ message: 'Only active group members can comment.' });
  if (member.postingRestrictedUntil && new Date(member.postingRestrictedUntil).getTime() > Date.now()) return res.status(403).json({ message: 'Your posting ability is temporarily restricted.' });
  if (await isDatabaseAvailable()) {
    const post = await prisma.discussionGroupPost.findFirst({ where: { id: postId, groupId, status: 'APPROVED' }, select: { authorId: true } });
    if (!post) return res.status(404).json({ message: 'Post not found.' });
    const parent = payload.parentId
      ? await prisma.discussionGroupComment.findFirst({ where: { id: payload.parentId, postId }, select: { authorId: true } })
      : null;
    if (payload.parentId && !parent) return res.status(404).json({ message: 'Parent comment not found.' });
    const comment = await prisma.discussionGroupComment.create({ data: { postId, authorId: req.user!.id, content: payload.content, parentId: payload.parentId ?? null }, include: { author: { select: { id: true, name: true, profile: { select: { displayName: true, avatarUrl: true } } } } } });
    if (post.authorId !== req.user!.id) await createNotification(post.authorId, req.user!.id, payload.parentId ? 'discussion_group_reply' : 'discussion_group_comment', payload.parentId ? 'Someone replied to your group discussion.' : 'Someone commented on your group post.', { link: `/discussion-groups/${groupId}` });
    if (parent && parent.authorId !== req.user!.id && parent.authorId !== post.authorId) {
      await createNotification(parent.authorId, req.user!.id, 'discussion_group_reply', 'Someone replied to your group comment.', { link: `/discussion-groups/${groupId}` });
    }
    await notifyDiscussionMentions(payload.content, req.user!.id, groupId);
    return res.status(201).json({ comment });
  }
  const post = socialStore.state.discussionPosts.find((entry) => entry.id === postId && entry.groupId === groupId && entry.status === 'APPROVED');
  if (!post) return res.status(404).json({ message: 'Post not found.' });
  if (payload.parentId && !socialStore.state.discussionComments.some((entry) => entry.id === payload.parentId && entry.postId === postId)) return res.status(404).json({ message: 'Parent comment not found.' });
  const comment = { id: makeId('dg_comment'), postId, authorId: req.user!.id, parentId: payload.parentId ?? null, content: payload.content, createdAt: nowIso(), updatedAt: nowIso() };
  socialStore.state.discussionComments.push(comment);
  if (post.authorId !== req.user!.id) await createNotification(post.authorId, req.user!.id, payload.parentId ? 'discussion_group_reply' : 'discussion_group_comment', payload.parentId ? 'Someone replied to your group discussion.' : 'Someone commented on your group post.', { link: `/discussion-groups/${groupId}` });
  const parent = payload.parentId && socialStore.state.discussionComments.find((entry) => entry.id === payload.parentId);
  if (parent && parent.authorId !== req.user!.id && parent.authorId !== post.authorId) {
    await createNotification(parent.authorId, req.user!.id, 'discussion_group_reply', 'Someone replied to your group comment.', { link: `/discussion-groups/${groupId}` });
  }
  await notifyDiscussionMentions(payload.content, req.user!.id, groupId);
  return res.status(201).json({ comment: { ...comment, author: safeUserSummary(req.user!.id) } });
});

router.patch('/discussion-groups/:id/comments/:commentId', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const commentId = String(req.params.commentId);
  const { content } = z.object({ content: z.string().trim().min(1).max(2000) }).parse(req.body ?? {});
  const member = await findMembership(groupId, req.user!.id);
  if (!member) return res.status(403).json({ message: 'Group membership is required.' });
  if (!managerRoles.includes(member.role) && member.suspendedUntil && new Date(member.suspendedUntil).getTime() > Date.now()) return res.status(403).json({ message: 'Your group membership is temporarily suspended.' });
  if (await isDatabaseAvailable()) {
    const comment = await prisma.discussionGroupComment.findFirst({ where: { id: commentId, post: { groupId } } });
    if (!comment) return res.status(404).json({ message: 'Comment not found.' });
    if (comment.authorId !== req.user!.id && !managerRoles.includes(member.role)) return res.status(403).json({ message: 'You cannot edit this comment.' });
    const updated = await prisma.discussionGroupComment.update({ where: { id: commentId }, data: { content } });
    await notifyDiscussionMentions(content, req.user!.id, groupId);
    return res.json({ comment: updated });
  }
  const comment = socialStore.state.discussionComments.find((entry) => entry.id === commentId && socialStore.state.discussionPosts.some((post) => post.id === entry.postId && post.groupId === groupId));
  if (!comment) return res.status(404).json({ message: 'Comment not found.' });
  if (comment.authorId !== req.user!.id && !managerRoles.includes(member.role)) return res.status(403).json({ message: 'You cannot edit this comment.' });
  Object.assign(comment, { content, updatedAt: nowIso() });
  await notifyDiscussionMentions(content, req.user!.id, groupId);
  return res.json({ comment });
});

router.delete('/discussion-groups/:id/comments/:commentId', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const commentId = String(req.params.commentId);
  const member = await findMembership(groupId, req.user!.id);
  if (!member) return res.status(403).json({ message: 'Group membership is required.' });
  if (!managerRoles.includes(member.role) && member.suspendedUntil && new Date(member.suspendedUntil).getTime() > Date.now()) return res.status(403).json({ message: 'Your group membership is temporarily suspended.' });
  if (await isDatabaseAvailable()) {
    const comment = await prisma.discussionGroupComment.findFirst({ where: { id: commentId, post: { groupId } }, select: { authorId: true } });
    if (!comment) return res.status(404).json({ message: 'Comment not found.' });
    if (comment.authorId !== req.user!.id && !managerRoles.includes(member.role)) return res.status(403).json({ message: 'You cannot delete this comment.' });
    await prisma.discussionGroupComment.delete({ where: { id: commentId } });
  } else {
    const comment = socialStore.state.discussionComments.find((entry) => entry.id === commentId && socialStore.state.discussionPosts.some((post) => post.id === entry.postId && post.groupId === groupId));
    if (!comment) return res.status(404).json({ message: 'Comment not found.' });
    if (comment.authorId !== req.user!.id && !managerRoles.includes(member.role)) return res.status(403).json({ message: 'You cannot delete this comment.' });
    const ids = new Set([commentId]);
    while (true) {
      const children = socialStore.state.discussionComments.filter((entry) => entry.parentId && ids.has(entry.parentId));
      const before = ids.size;
      children.forEach((entry) => ids.add(entry.id));
      if (ids.size === before) break;
    }
    socialStore.state.discussionComments = socialStore.state.discussionComments.filter((entry) => !ids.has(entry.id));
    socialStore.state.discussionCommentReactions = socialStore.state.discussionCommentReactions.filter((entry) => !ids.has(entry.commentId));
  }
  return res.json({ deleted: true });
});

router.post('/discussion-groups/:id/comments/:commentId/reactions', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const commentId = String(req.params.commentId);
  const { type } = reactionSchema.parse(req.body ?? {});
  if (!(await requireActiveMember(groupId, req.user!.id))) return res.status(403).json({ message: 'Only active group members can react.' });
  if (await isDatabaseAvailable()) {
    const comment = await prisma.discussionGroupComment.findFirst({ where: { id: commentId, post: { groupId } }, select: { id: true } });
    if (!comment) return res.status(404).json({ message: 'Comment not found.' });
    const reaction = await prisma.discussionGroupCommentReaction.upsert({
      where: { commentId_userId: { commentId, userId: req.user!.id } },
      create: { commentId, userId: req.user!.id, type },
      update: { type },
    });
    return res.json({ reaction });
  }
  const comment = socialStore.state.discussionComments.find((entry) => entry.id === commentId && socialStore.state.discussionPosts.some((post) => post.id === entry.postId && post.groupId === groupId));
  if (!comment) return res.status(404).json({ message: 'Comment not found.' });
  const reaction = socialStore.state.discussionCommentReactions.find((entry) => entry.commentId === commentId && entry.userId === req.user!.id);
  if (reaction) Object.assign(reaction, { type });
  else socialStore.state.discussionCommentReactions.push({ id: makeId('dg_comment_reaction'), commentId, userId: req.user!.id, type, createdAt: nowIso() });
  return res.json({ reaction: reaction ?? socialStore.state.discussionCommentReactions.at(-1) });
});

router.delete('/discussion-groups/:id/comments/:commentId/reactions', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const commentId = String(req.params.commentId);
  if (!(await requireActiveMember(groupId, req.user!.id))) return res.status(403).json({ message: 'Only active group members can react.' });
  if (await isDatabaseAvailable()) {
    await prisma.discussionGroupCommentReaction.deleteMany({ where: { commentId, userId: req.user!.id, comment: { post: { groupId } } } });
  } else {
    const comment = socialStore.state.discussionComments.find((entry) => entry.id === commentId
      && socialStore.state.discussionPosts.some((post) => post.id === entry.postId && post.groupId === groupId));
    if (!comment) return res.status(404).json({ message: 'Comment not found.' });
    socialStore.state.discussionCommentReactions = socialStore.state.discussionCommentReactions.filter((entry) => !(entry.commentId === commentId && entry.userId === req.user!.id));
  }
  return res.json({ removed: true });
});

router.post('/discussion-groups/:id/polls/:pollId/vote', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const pollId = String(req.params.pollId);
  const { optionId } = z.object({ optionId: z.string().min(1) }).parse(req.body ?? {});
  if (!(await requireActiveMember(groupId, req.user!.id))) return res.status(403).json({ message: 'Only active group members can vote.' });
  if (await isDatabaseAvailable()) {
    const option = await prisma.discussionGroupPollOption.findFirst({ where: { id: optionId, pollId, poll: { post: { groupId, status: 'APPROVED' } } }, select: { id: true } });
    if (!option) return res.status(404).json({ message: 'Poll option not found.' });
    await prisma.$transaction(async (tx) => {
      await tx.discussionGroupPollVote.deleteMany({ where: { userId: req.user!.id, option: { pollId } } });
      await tx.discussionGroupPollVote.create({ data: { optionId, userId: req.user!.id } });
    });
    return res.json({ voted: true });
  }
  const option = socialStore.state.discussionPollOptions.find((entry) => entry.id === optionId && entry.pollId === pollId);
  const poll = socialStore.state.discussionPolls.find((entry) => entry.id === pollId);
  if (!option || !poll || !socialStore.state.discussionPosts.some((post) => post.id === poll.postId && post.groupId === groupId && post.status === 'APPROVED')) return res.status(404).json({ message: 'Poll option not found.' });
  const oldVotes = socialStore.state.discussionPollVotes.filter((vote) => vote.userId === req.user!.id && socialStore.state.discussionPollOptions.some((candidate) => candidate.id === vote.optionId && candidate.pollId === pollId));
  socialStore.state.discussionPollVotes = socialStore.state.discussionPollVotes.filter((vote) => !oldVotes.includes(vote));
  socialStore.state.discussionPollVotes.push({ id: makeId('dg_vote'), optionId, userId: req.user!.id, createdAt: nowIso() });
  return res.json({ voted: true });
});

router.post('/discussion-groups/:id/posts/:postId/report', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const postId = String(req.params.postId);
  const payload = reportSchema.parse(req.body ?? {});
  const { group } = await getVisibleGroup(groupId, req.user!.id);
  if (!group) return res.status(404).json({ message: 'Discussion group not found.' });
  if (await isDatabaseAvailable()) {
    const post = await prisma.discussionGroupPost.findFirst({ where: { id: postId, groupId }, select: { id: true } });
    if (!post) return res.status(404).json({ message: 'Post not found.' });
    const report = await prisma.discussionGroupReport.create({ data: { groupId, postId, reporterId: req.user!.id, ...payload } });
    return res.status(201).json({ report });
  }
  const post = socialStore.state.discussionPosts.find((entry) => entry.id === postId && entry.groupId === groupId);
  if (!post) return res.status(404).json({ message: 'Post not found.' });
  const report = { id: makeId('dg_report'), groupId, postId, reporterId: req.user!.id, ...payload, status: 'OPEN', createdAt: nowIso() };
  socialStore.state.discussionReports.push(report);
  return res.status(201).json({ report });
});

router.post('/discussion-groups/:id/reports/:reportId/decision', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const reportId = String(req.params.reportId);
  const { status } = z.object({ status: z.enum(['RESOLVED', 'REJECTED']) }).parse(req.body ?? {});
  if (!(await canManage(groupId, req.user!.id))) return res.status(403).json({ message: 'Only group moderators can review reports.' });
  if (await isDatabaseAvailable()) {
    const report = await prisma.discussionGroupReport.updateMany({ where: { id: reportId, groupId, status: 'OPEN' }, data: { status } });
    if (!report.count) return res.status(404).json({ message: 'Open report not found.' });
  } else {
    const report = socialStore.state.discussionReports.find((entry) => entry.id === reportId && entry.groupId === groupId && entry.status === 'OPEN');
    if (!report) return res.status(404).json({ message: 'Open report not found.' });
    report.status = status;
  }
  await addAction(groupId, req.user!.id, status === 'RESOLVED' ? 'resolve_report' : 'dismiss_report', null, reportId);
  return res.json({ status });
});

router.post('/discussion-groups/:id/comments/:commentId/report', requireAuth, async (req, res) => {
  const groupId = String(req.params.id);
  const commentId = String(req.params.commentId);
  const payload = reportSchema.parse(req.body ?? {});
  const { group } = await getVisibleGroup(groupId, req.user!.id);
  if (!group) return res.status(404).json({ message: 'Discussion group not found.' });
  if (await isDatabaseAvailable()) {
    const comment = await prisma.discussionGroupComment.findFirst({ where: { id: commentId, post: { groupId } }, select: { id: true } });
    if (!comment) return res.status(404).json({ message: 'Comment not found.' });
    const report = await prisma.discussionGroupReport.create({ data: { groupId, commentId, reporterId: req.user!.id, ...payload } });
    return res.status(201).json({ report });
  }
  const comment = socialStore.state.discussionComments.find((entry) => entry.id === commentId
    && socialStore.state.discussionPosts.some((post) => post.id === entry.postId && post.groupId === groupId));
  if (!comment) return res.status(404).json({ message: 'Comment not found.' });
  const report = { id: makeId('dg_report'), groupId, commentId, reporterId: req.user!.id, ...payload, status: 'OPEN', createdAt: nowIso() };
  socialStore.state.discussionReports.push(report);
  return res.status(201).json({ report });
});

export const discussionGroupsRouter = router;
