import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { fallbackStore } from '../lib/fallbackStore.js';
import { socialStore } from '../lib/socialStore.js';
import { getMediaStorage } from '../lib/mediaStorage.js';

function cookie(response: { headers: Record<string, string | string[] | undefined> }) {
  const value = response.headers['set-cookie'];
  return Array.isArray(value) ? value.join('; ') : value ?? '';
}

async function register(name: string) {
  const email = `${name.toLowerCase()}@example.com`;
  const result = await request(app).post('/api/auth/register').send({ name, email, password: 'Password123', communityRulesAccepted: true });
  const login = await request(app).post('/api/auth/login').send({ email, password: 'Password123' });
  return { user: result.body.user, auth: cookie(login) };
}

function addUsername(userId: string, username: string) {
  socialStore.state.profiles.push({
    userId, displayName: null, username, bio: null, avatarUrl: null, coverUrl: null, website: null, location: null,
    updatedAt: new Date().toISOString(),
  });
}

describe('Discussion Groups', () => {
  beforeEach(() => {
    fallbackStore.clear();
    socialStore.clear();
  });

  it('creates, discovers, joins, and persists independent discussion posts and poll votes', async () => {
    const owner = await register('DiscussionOwner');
    const member = await register('DiscussionMember');
    const outsider = await register('DiscussionOutsider');
    const created = await request(app).post('/api/discussion-groups').set('Cookie', owner.auth).send({
      name: 'Local Gardeners', description: 'Share growing advice', category: 'Hobbies',
    });
    expect(created.status).toBe(201);
    expect(created.body.group.myRole).toBe('OWNER');

    const discovery = await request(app).get('/api/discussion-groups?q=growing').set('Cookie', outsider.auth);
    expect(discovery.body.groups.map((group: { id: string }) => group.id)).toContain(created.body.group.id);
    expect((await request(app).post(`/api/discussion-groups/${created.body.group.id}/join`).set('Cookie', member.auth)).status).toBe(201);
    const related = await request(app).post('/api/discussion-groups').set('Cookie', owner.auth).send({
      name: 'Balcony Gardeners', category: 'Hobbies',
    });
    const suggested = await request(app).get('/api/discussion-groups?filter=suggested').set('Cookie', member.auth);
    expect(suggested.body.groups.map((group: { id: string }) => group.id)).toEqual([related.body.group.id]);
    const popular = await request(app).get('/api/discussion-groups?filter=popular').set('Cookie', member.auth);
    expect(popular.body.groups[0].id).toBe(created.body.group.id);
    expect((await request(app).get('/api/discussion-groups?category=Hobbies').set('Cookie', outsider.auth)).body.groups).toHaveLength(2);

    const post = await request(app).post(`/api/discussion-groups/${created.body.group.id}/posts`).set('Cookie', member.auth).send({
      type: 'POLL', content: 'What should we plant next?', pollOptions: ['Tomatoes', 'Peppers'],
    });
    expect(post.status, JSON.stringify(post.body)).toBe(201);
    const pollId = socialStore.state.discussionPolls.find((poll) => poll.postId === post.body.post.id)?.id;
    const optionId = socialStore.state.discussionPollOptions.find((option) => option.pollId === pollId)?.id;
    expect((await request(app).post(`/api/discussion-groups/${created.body.group.id}/polls/${pollId}/vote`).set('Cookie', member.auth).send({ optionId })).status).toBe(200);
    expect((await request(app).patch(`/api/discussion-groups/${created.body.group.id}/posts/${post.body.post.id}`).set('Cookie', member.auth).send({
      pollOptions: ['Changing votes is not allowed', 'Second option'],
    })).status).toBe(409);
    expect((await request(app).post(`/api/discussion-groups/${created.body.group.id}/posts/${post.body.post.id}/reactions`).set('Cookie', member.auth).send({ type: 'LIKE' })).status).toBe(200);
    expect((await request(app).post(`/api/discussion-groups/${created.body.group.id}/posts/${post.body.post.id}/reactions`).set('Cookie', outsider.auth).send({ type: 'LIKE' })).status).toBe(403);

    const comment = await request(app).post(`/api/discussion-groups/${created.body.group.id}/posts/${post.body.post.id}/comments`).set('Cookie', member.auth).send({ content: 'Tomatoes are easy to grow.' });
    expect(comment.status).toBe(201);
    const reply = await request(app).post(`/api/discussion-groups/${created.body.group.id}/posts/${post.body.post.id}/comments`).set('Cookie', owner.auth).send({ content: 'Good idea!', parentId: comment.body.comment.id });
    expect(reply.status).toBe(201);

    const refreshed = await request(app).get(`/api/discussion-groups/${created.body.group.id}`).set('Cookie', outsider.auth);
    expect(refreshed.body.group.posts).toHaveLength(1);
    expect(refreshed.body.group.posts[0].commentCount).toBe(2);
    expect((await request(app).get(`/api/discussion-groups/${created.body.group.id}`).set('Cookie', member.auth)).body.group.posts[0].poll.myVote).toBe(optionId);
  }, 30_000);

  it('integrates public group posts into Home Feed and keeps interactions on the source post', async () => {
    const owner = await register('FeedGroupOwner');
    const member = await register('FeedGroupMember');
    const group = await request(app).post('/api/discussion-groups').set('Cookie', owner.auth).send({
      name: 'Feed Integration Group',
    });
    const post = await request(app).post(`/api/discussion-groups/${group.body.group.id}/posts`).set('Cookie', owner.auth).send({
      type: 'TEXT',
      content: 'A discussion visible in Home Feed.',
    });
    await request(app).post(`/api/discussion-groups/${group.body.group.id}/join`).set('Cookie', member.auth);

    const feed = await request(app).get('/api/posts?limit=50').set('Cookie', member.auth);
    const feedPost = feed.body.posts.find((entry: { id: string }) => entry.id === post.body.post.id);
    expect(feedPost).toMatchObject({
      id: post.body.post.id,
      content: 'A discussion visible in Home Feed.',
      author: { id: owner.user.id },
      groupOrigin: { id: group.body.group.id, name: 'Feed Integration Group', canInteract: true },
    });

    const reaction = await request(app).post(`/api/discussion-groups/${group.body.group.id}/posts/${post.body.post.id}/reactions`)
      .set('Cookie', member.auth).send({ type: 'LIKE' });
    const comment = await request(app).post(`/api/discussion-groups/${group.body.group.id}/posts/${post.body.post.id}/comments`)
      .set('Cookie', member.auth).send({ content: 'Comment on the original group post.' });
    expect(reaction.status).toBe(200);
    expect(comment.status).toBe(201);
    const refreshedFeed = await request(app).get('/api/posts?limit=50').set('Cookie', member.auth);
    expect(refreshedFeed.body.posts.find((entry: { id: string }) => entry.id === post.body.post.id)).toMatchObject({
      likes: 1,
      comments: 1,
    });

    const requestId = 'c0d3316b-600c-4bd0-9768-37eaf47c2e0a';
    const reshare = await request(app).post(`/api/posts/${post.body.post.id}/reshare`).set('Cookie', member.auth).send({
      commentary: 'A reshare of this group discussion.',
      requestId,
    });
    expect(reshare.status).toBe(201);
    expect(reshare.body.post).toMatchObject({
      content: 'A reshare of this group discussion.',
      sharedDiscussionPost: {
        id: post.body.post.id,
        group: { id: group.body.group.id, name: 'Feed Integration Group' },
        author: { id: owner.user.id },
      },
    });
    const duplicateReshare = await request(app).post(`/api/posts/${post.body.post.id}/reshare`).set('Cookie', member.auth).send({
      commentary: 'A reshare of this group discussion.',
      requestId,
    });
    expect(duplicateReshare.status).toBe(200);
    expect(duplicateReshare.body.duplicate).toBe(true);

    const story = await request(app).post('/api/stories').set('Cookie', member.auth).send({
      sharedDiscussionPostId: post.body.post.id,
    });
    expect(story.status).toBe(201);
    const stories = await request(app).get('/api/stories').set('Cookie', member.auth);
    expect(stories.body.stories.find((entry: { id: string }) => entry.id === story.body.story.id).sharedDiscussionPost).toMatchObject({
      id: post.body.post.id,
      author: { id: owner.user.id },
      group: { id: group.body.group.id },
    });

    const directLink = await request(app).get(`/api/discussion-groups/${group.body.group.id}?postId=${post.body.post.id}`)
      .set('Cookie', member.auth);
    expect(directLink.body.group.posts.map((entry: { id: string }) => entry.id)).toEqual([post.body.post.id]);
  }, 20_000);

  it('requires private membership approval and never returns private posts to nonmembers', async () => {
    const owner = await register('PrivateOwner');
    const requester = await register('PrivateRequester');
    const outsider = await register('PrivateOutsider');
    const created = await request(app).post('/api/discussion-groups').set('Cookie', owner.auth).send({
      name: 'Private Book Club', privacy: 'PRIVATE', membershipApproval: false,
    });
    const groupId = created.body.group.id;
    expect(created.body.group.membershipApproval).toBe(true);
    const stored = await getMediaStorage('test').putAttachment(Buffer.from('private group attachment'), 'image/png', 'png', owner.user.id);
    const privatePost = await request(app).post(`/api/discussion-groups/${groupId}/posts`).set('Cookie', owner.auth).send({
      type: 'IMAGE', content: 'Members-only reading notes.', media: [{ url: stored.publicUrl, type: 'IMAGE' }],
    });

    expect((await request(app).get(`/api/discussion-groups/${groupId}`).set('Cookie', outsider.auth)).status).toBe(404);
    expect((await request(app).get('/api/posts').set('Cookie', outsider.auth)).body.posts.map((post: { id: string }) => post.id)).not.toContain(privatePost.body.post.id);
    expect((await request(app).post(`/api/posts/${privatePost.body.post.id}/reshare`)
      .set('Cookie', outsider.auth)
      .send({ commentary: '', requestId: 'aa5f1caa-cdbc-4482-b493-32a84bfe4a87' })).status).toBe(404);
    expect((await request(app).get(`/api/media/files/${stored.key}`).set('Cookie', outsider.auth)).status).toBe(404);
    expect((await request(app).post(`/api/discussion-groups/${groupId}/join`).set('Cookie', requester.auth)).status).toBe(202);
    expect((await request(app).get(`/api/discussion-groups/${groupId}/requests`).set('Cookie', requester.auth)).status).toBe(403);

    const pending = await request(app).get(`/api/discussion-groups/${groupId}/requests`).set('Cookie', owner.auth);
    expect(pending.body.requests).toHaveLength(1);
    expect((await request(app).post(`/api/discussion-groups/${groupId}/requests/${pending.body.requests[0].id}/decision`).set('Cookie', owner.auth).send({ approve: true })).status).toBe(200);
    expect((await request(app).get(`/api/discussion-groups/${groupId}`).set('Cookie', requester.auth)).body.group.posts).toHaveLength(1);
    expect((await request(app).get(`/api/media/files/${stored.key}`).set('Cookie', requester.auth)).status).toBe(200);
    expect((await request(app).get(`/api/discussion-groups/${groupId}`).set('Cookie', outsider.auth)).status).toBe(404);
  }, 20_000);

  it('hides hidden groups and prevents nonmembers from writing to public feeds', async () => {
    const owner = await register('HiddenGroupOwner');
    const outsider = await register('HiddenGroupOutsider');
    const hidden = await request(app).post('/api/discussion-groups').set('Cookie', owner.auth).send({
      name: 'Hidden Study Group', visibility: 'HIDDEN',
    });
    const stored = await getMediaStorage('test').putAttachment(Buffer.from('hidden group attachment'), 'image/png', 'png', owner.user.id);
    const hiddenPost = await request(app).post(`/api/discussion-groups/${hidden.body.group.id}/posts`).set('Cookie', owner.auth).send({
      type: 'IMAGE', content: 'Hidden attachment.', media: [{ url: stored.publicUrl, type: 'IMAGE' }],
    });
    expect(hiddenPost.status).toBe(201);
    expect((await request(app).get('/api/discussion-groups?q=Hidden').set('Cookie', outsider.auth)).body.groups).toHaveLength(0);
    expect((await request(app).get(`/api/discussion-groups/${hidden.body.group.id}`).set('Cookie', outsider.auth)).status).toBe(404);
    expect((await request(app).get(`/api/media/files/${stored.key}`).set('Cookie', outsider.auth)).status).toBe(404);
    expect((await request(app).get(`/api/media/files/${stored.key}`).set('Cookie', owner.auth)).status).toBe(200);

    const publicGroup = await request(app).post('/api/discussion-groups').set('Cookie', owner.auth).send({ name: 'Open Study Group' });
    expect((await request(app).post(`/api/discussion-groups/${publicGroup.body.group.id}/posts`).set('Cookie', outsider.auth).send({ content: 'Unauthorized post.' })).status).toBe(403);
    expect((await request(app).patch(`/api/discussion-groups/${publicGroup.body.group.id}`).set('Cookie', outsider.auth).send({ name: 'Hijacked' })).status).toBe(403);
  });

  it('handles invitations, moderator roles, restrictions, bans, and unbans', async () => {
    const owner = await register('ModerationOwner');
    const invitee = await register('ModerationInvitee');
    const peer = await register('ModerationPeer');
    const created = await request(app).post('/api/discussion-groups').set('Cookie', owner.auth).send({ name: 'Moderation Test Group' });
    const groupId = created.body.group.id;
    await request(app).post(`/api/discussion-groups/${groupId}/join`).set('Cookie', peer.auth);

    expect((await request(app).post(`/api/discussion-groups/${groupId}/invitations`).set('Cookie', owner.auth).send({ userId: invitee.user.id })).status).toBe(201);
    const invitations = await request(app).get('/api/discussion-groups/invitations').set('Cookie', invitee.auth);
    expect(invitations.body.invitations).toHaveLength(1);
    expect((await request(app).post(`/api/discussion-groups/invitations/${invitations.body.invitations[0].id}/respond`).set('Cookie', invitee.auth).send({ accept: true })).status).toBe(200);

    expect((await request(app).patch(`/api/discussion-groups/${groupId}/members/${invitee.user.id}`).set('Cookie', owner.auth).send({ action: 'role', role: 'MODERATOR' })).status).toBe(200);
    expect((await request(app).post(`/api/discussion-groups/${groupId}/posts`).set('Cookie', invitee.auth).send({ type: 'ANNOUNCEMENT', content: 'Welcome!' })).status).toBe(201);
    expect((await request(app).patch(`/api/discussion-groups/${groupId}/members/${peer.user.id}`).set('Cookie', invitee.auth).send({ action: 'role', role: 'MODERATOR' })).status).toBe(403);
    const until = new Date(Date.now() + 60_000).toISOString();
    expect((await request(app).patch(`/api/discussion-groups/${groupId}/members/${invitee.user.id}`).set('Cookie', owner.auth).send({ action: 'restrict', until })).status).toBe(200);
    expect((await request(app).post(`/api/discussion-groups/${groupId}/posts`).set('Cookie', invitee.auth).send({ content: 'This should be blocked.' })).status).toBe(403);
    expect((await request(app).patch(`/api/discussion-groups/${groupId}/members/${invitee.user.id}`).set('Cookie', owner.auth).send({ action: 'ban', reason: 'Policy violation', until: null })).status).toBe(200);
    expect((await request(app).post(`/api/discussion-groups/${groupId}/join`).set('Cookie', invitee.auth)).status).toBe(403);
    expect((await request(app).patch(`/api/discussion-groups/${groupId}/members/${invitee.user.id}`).set('Cookie', owner.auth).send({ action: 'unban' })).status).toBe(200);
    expect((await request(app).post(`/api/discussion-groups/${groupId}/join`).set('Cookie', invitee.auth)).status).toBe(201);
  });

  it('supports group mentions, reaction identities, featured posts, full post edits, paged comments, replies, and sharing', async () => {
    const owner = await register('WorkflowOwner');
    const member = await register('WorkflowMember');
    const outsider = await register('WorkflowOutsider');
    addUsername(owner.user.id, 'workflowowner');
    addUsername(member.user.id, 'workflowmember');
    addUsername(outsider.user.id, 'workflowoutsider');

    const source = await request(app).post('/api/discussion-groups').set('Cookie', owner.auth).send({ name: 'Workflow Source' });
    const sourceId = source.body.group.id;
    await request(app).post(`/api/discussion-groups/${sourceId}/join`).set('Cookie', member.auth);
    const firstPost = await request(app).post(`/api/discussion-groups/${sourceId}/posts`).set('Cookie', member.auth).send({
      content: 'A note for @workflowowner and @workflowoutsider',
    });
    expect(firstPost.status).toBe(201);
    expect(socialStore.state.notifications.some((entry) => entry.recipientId === owner.user.id && entry.type === 'mention')).toBe(true);
    expect(socialStore.state.notifications.some((entry) => entry.recipientId === outsider.user.id && entry.type === 'mention')).toBe(false);
    expect(firstPost.body.post.author).not.toHaveProperty('passwordHash');

    expect((await request(app).post(`/api/discussion-groups/${sourceId}/posts/${firstPost.body.post.id}/reactions`).set('Cookie', owner.auth).send({ type: 'LOVE' })).status).toBe(200);
    const reactors = await request(app).get(`/api/discussion-groups/${sourceId}`).set('Cookie', member.auth);
    expect(reactors.body.group.posts[0].reactionUsers[0].user.id).toBe(owner.user.id);
    const reactorList = await request(app).get(`/api/discussion-groups/${sourceId}/posts/${firstPost.body.post.id}/reactions`).set('Cookie', member.auth);
    expect(reactorList.body.reactions[0].user.id).toBe(owner.user.id);

    expect((await request(app).patch(`/api/discussion-groups/${sourceId}/posts/${firstPost.body.post.id}/feature`).set('Cookie', owner.auth).send({ featured: true })).status).toBe(200);
    const recentPost = await request(app).post(`/api/discussion-groups/${sourceId}/posts`).set('Cookie', member.auth).send({ content: 'A newer post' });
    expect(recentPost.status).toBe(201);
    expect((await request(app).get(`/api/discussion-groups/${sourceId}`).set('Cookie', member.auth)).body.group.posts[0].id).toBe(firstPost.body.post.id);

    const edited = await request(app).patch(`/api/discussion-groups/${sourceId}/posts/${firstPost.body.post.id}`).set('Cookie', member.auth).send({
      content: 'Edited group post with @workflowowner',
    });
    expect(edited.status).toBe(200);
    expect(edited.body.post.content).toContain('Edited group post');

    const rootOne = await request(app).post(`/api/discussion-groups/${sourceId}/posts/${firstPost.body.post.id}/comments`).set('Cookie', member.auth).send({ content: 'First comment' });
    const rootTwo = await request(app).post(`/api/discussion-groups/${sourceId}/posts/${firstPost.body.post.id}/comments`).set('Cookie', member.auth).send({ content: 'Second comment' });
    await request(app).post(`/api/discussion-groups/${sourceId}/posts/${firstPost.body.post.id}/comments`).set('Cookie', owner.auth).send({ content: 'Third comment' });
    const firstPage = await request(app).get(`/api/discussion-groups/${sourceId}/posts/${firstPost.body.post.id}/comments?limit=1`).set('Cookie', member.auth);
    expect(firstPage.body.comments).toHaveLength(1);
    expect(firstPage.body.nextCursor).toBe(rootOne.body.comment.id);
    const secondPage = await request(app).get(`/api/discussion-groups/${sourceId}/posts/${firstPost.body.post.id}/comments?limit=1&cursor=${firstPage.body.nextCursor}`).set('Cookie', member.auth);
    expect(secondPage.body.comments[0].id).toBe(rootTwo.body.comment.id);
    const reply = await request(app).post(`/api/discussion-groups/${sourceId}/posts/${firstPost.body.post.id}/comments`).set('Cookie', owner.auth).send({
      content: 'A reply', parentId: rootOne.body.comment.id,
    });
    expect(reply.status).toBe(201);
    const replies = await request(app).get(`/api/discussion-groups/${sourceId}/posts/${firstPost.body.post.id}/comments?parentId=${rootOne.body.comment.id}`).set('Cookie', member.auth);
    expect(replies.body.comments[0].id).toBe(reply.body.comment.id);
    expect((await request(app).patch(`/api/discussion-groups/${sourceId}/comments/${rootOne.body.comment.id}`).set('Cookie', member.auth).send({ content: 'Edited comment' })).body.comment.content).toBe('Edited comment');
    expect((await request(app).delete(`/api/discussion-groups/${sourceId}/comments/${rootTwo.body.comment.id}`).set('Cookie', member.auth)).status).toBe(200);

    const destination = await request(app).post('/api/discussion-groups').set('Cookie', owner.auth).send({ name: 'Workflow Destination' });
    await request(app).post(`/api/discussion-groups/${destination.body.group.id}/join`).set('Cookie', member.auth);
    const shared = await request(app).post(`/api/discussion-groups/${sourceId}/posts/${firstPost.body.post.id}/share`).set('Cookie', member.auth).send({
      targetGroupId: destination.body.group.id, content: 'Sharing this for the destination group.',
    });
    expect(shared.status).toBe(201);
    const destinationFeed = await request(app).get(`/api/discussion-groups/${destination.body.group.id}`).set('Cookie', member.auth);
    expect(destinationFeed.body.group.posts[0].sharedPost.id).toBe(firstPost.body.post.id);
    expect(destinationFeed.body.group.posts[0].content).toContain('Sharing this');
  }, 30_000);

  it('prevents banned users from reading private group media and rejoining', async () => {
    const owner = await register('PrivacyBanOwner');
    const requester = await register('PrivacyBanRequester');
    const created = await request(app).post('/api/discussion-groups').set('Cookie', owner.auth).send({
      name: 'Banned Privacy Group', privacy: 'PRIVATE',
    });
    const groupId = created.body.group.id;
    const media = await getMediaStorage('test').putAttachment(Buffer.from('private group attachment'), 'image/png', 'png', owner.user.id);
    const post = await request(app).post(`/api/discussion-groups/${groupId}/posts`).set('Cookie', owner.auth).send({
      type: 'IMAGE', content: 'Private attachment.', media: [{ url: media.publicUrl, type: 'IMAGE' }],
    });
    expect(post.status, JSON.stringify(post.body)).toBe(201);
    await request(app).post(`/api/discussion-groups/${groupId}/join`).set('Cookie', requester.auth);
    const requestList = await request(app).get(`/api/discussion-groups/${groupId}/requests`).set('Cookie', owner.auth);
    const requestId = requestList.body.requests[0].id;
    expect((await request(app).post(`/api/discussion-groups/${groupId}/requests/${requestId}/decision`).set('Cookie', owner.auth).send({ approve: true })).status).toBe(200);
    expect((await request(app).patch(`/api/discussion-groups/${groupId}/members/${requester.user.id}`).set('Cookie', owner.auth).send({ action: 'ban', until: null })).status).toBe(200);
    expect((await request(app).get(`/api/discussion-groups/${groupId}`).set('Cookie', requester.auth)).status).toBe(404);
    expect((await request(app).get(`/api/media/files/${media.key}`).set('Cookie', requester.auth)).status).toBe(404);
    expect((await request(app).post(`/api/discussion-groups/${groupId}/join`).set('Cookie', requester.auth)).status).toBe(403);
    expect((await request(app).post(`/api/discussion-groups/${groupId}/posts`).set('Cookie', owner.auth).send({ content: 'More content' })).status).toBe(201);
  }, 20_000);
});
