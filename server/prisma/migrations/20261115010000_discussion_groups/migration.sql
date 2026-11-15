CREATE TYPE "DiscussionGroupPrivacy" AS ENUM ('PUBLIC', 'PRIVATE');
CREATE TYPE "DiscussionGroupVisibility" AS ENUM ('VISIBLE', 'HIDDEN');
CREATE TYPE "DiscussionGroupRole" AS ENUM ('OWNER', 'ADMIN', 'MODERATOR', 'MEMBER');
CREATE TYPE "DiscussionGroupRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "DiscussionGroupPostStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "DiscussionGroupPostType" AS ENUM ('TEXT', 'IMAGE', 'VIDEO', 'LINK', 'POLL', 'QUESTION', 'ANNOUNCEMENT');

CREATE TABLE "DiscussionGroup" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT 'General',
    "avatarUrl" TEXT,
    "coverUrl" TEXT,
    "privacy" "DiscussionGroupPrivacy" NOT NULL DEFAULT 'PUBLIC',
    "visibility" "DiscussionGroupVisibility" NOT NULL DEFAULT 'VISIBLE',
    "membershipApproval" BOOLEAN NOT NULL DEFAULT false,
    "postApproval" BOOLEAN NOT NULL DEFAULT false,
    "rules" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DiscussionGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscussionGroupMembership" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "DiscussionGroupRole" NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postingRestrictedUntil" TIMESTAMP(3),
    "suspendedUntil" TIMESTAMP(3),
    CONSTRAINT "DiscussionGroupMembership_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscussionGroupMembershipRequest" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "DiscussionGroupRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DiscussionGroupMembershipRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscussionGroupInvitation" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "inviterId" TEXT NOT NULL,
    "inviteeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    CONSTRAINT "DiscussionGroupInvitation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscussionGroupPost" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "type" "DiscussionGroupPostType" NOT NULL DEFAULT 'TEXT',
    "content" TEXT NOT NULL DEFAULT '',
    "linkUrl" TEXT,
    "status" "DiscussionGroupPostStatus" NOT NULL DEFAULT 'APPROVED',
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "sharedFromId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DiscussionGroupPost_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscussionGroupPostMedia" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "mediaUrl" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscussionGroupPostMedia_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscussionGroupComment" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "parentId" TEXT,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DiscussionGroupComment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscussionGroupPostReaction" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "ReactionType" NOT NULL DEFAULT 'LIKE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscussionGroupPostReaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscussionGroupCommentReaction" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "ReactionType" NOT NULL DEFAULT 'LIKE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscussionGroupCommentReaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscussionGroupPoll" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscussionGroupPoll_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscussionGroupPollOption" (
    "id" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscussionGroupPollOption_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscussionGroupPollVote" (
    "id" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscussionGroupPollVote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscussionGroupBan" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "issuerId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscussionGroupBan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscussionGroupReport" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "postId" TEXT,
    "commentId" TEXT,
    "category" "ReportCategory" NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscussionGroupReport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscussionGroupModerationAction" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "targetId" TEXT,
    "action" TEXT NOT NULL,
    "details" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscussionGroupModerationAction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DiscussionGroupMembership_groupId_userId_key" ON "DiscussionGroupMembership"("groupId", "userId");
CREATE UNIQUE INDEX "DiscussionGroupMembershipRequest_groupId_userId_key" ON "DiscussionGroupMembershipRequest"("groupId", "userId");
CREATE UNIQUE INDEX "DiscussionGroupInvitation_groupId_inviteeId_key" ON "DiscussionGroupInvitation"("groupId", "inviteeId");
CREATE UNIQUE INDEX "DiscussionGroupPostReaction_postId_userId_key" ON "DiscussionGroupPostReaction"("postId", "userId");
CREATE UNIQUE INDEX "DiscussionGroupCommentReaction_commentId_userId_key" ON "DiscussionGroupCommentReaction"("commentId", "userId");
CREATE UNIQUE INDEX "DiscussionGroupPoll_postId_key" ON "DiscussionGroupPoll"("postId");
CREATE UNIQUE INDEX "DiscussionGroupPollVote_optionId_userId_key" ON "DiscussionGroupPollVote"("optionId", "userId");
CREATE UNIQUE INDEX "DiscussionGroupBan_groupId_userId_key" ON "DiscussionGroupBan"("groupId", "userId");
CREATE INDEX "DiscussionGroup_ownerId_idx" ON "DiscussionGroup"("ownerId");
CREATE INDEX "DiscussionGroup_privacy_visibility_createdAt_idx" ON "DiscussionGroup"("privacy", "visibility", "createdAt");
CREATE INDEX "DiscussionGroup_category_createdAt_idx" ON "DiscussionGroup"("category", "createdAt");
CREATE INDEX "DiscussionGroup_name_idx" ON "DiscussionGroup"("name");
CREATE INDEX "DiscussionGroupMembership_groupId_role_joinedAt_idx" ON "DiscussionGroupMembership"("groupId", "role", "joinedAt");
CREATE INDEX "DiscussionGroupMembership_userId_joinedAt_idx" ON "DiscussionGroupMembership"("userId", "joinedAt");
CREATE INDEX "DiscussionGroupMembershipRequest_groupId_status_createdAt_idx" ON "DiscussionGroupMembershipRequest"("groupId", "status", "createdAt");
CREATE INDEX "DiscussionGroupMembershipRequest_userId_status_idx" ON "DiscussionGroupMembershipRequest"("userId", "status");
CREATE INDEX "DiscussionGroupInvitation_inviteeId_status_createdAt_idx" ON "DiscussionGroupInvitation"("inviteeId", "status", "createdAt");
CREATE INDEX "DiscussionGroupInvitation_groupId_status_createdAt_idx" ON "DiscussionGroupInvitation"("groupId", "status", "createdAt");
CREATE INDEX "DiscussionGroupPost_groupId_status_isPinned_createdAt_idx" ON "DiscussionGroupPost"("groupId", "status", "isPinned", "createdAt");
CREATE INDEX "DiscussionGroupPost_authorId_createdAt_idx" ON "DiscussionGroupPost"("authorId", "createdAt");
CREATE INDEX "DiscussionGroupPost_sharedFromId_idx" ON "DiscussionGroupPost"("sharedFromId");
CREATE INDEX "DiscussionGroupPostMedia_postId_position_idx" ON "DiscussionGroupPostMedia"("postId", "position");
CREATE INDEX "DiscussionGroupComment_postId_createdAt_idx" ON "DiscussionGroupComment"("postId", "createdAt");
CREATE INDEX "DiscussionGroupComment_parentId_createdAt_idx" ON "DiscussionGroupComment"("parentId", "createdAt");
CREATE INDEX "DiscussionGroupComment_authorId_idx" ON "DiscussionGroupComment"("authorId");
CREATE INDEX "DiscussionGroupPostReaction_userId_createdAt_idx" ON "DiscussionGroupPostReaction"("userId", "createdAt");
CREATE INDEX "DiscussionGroupCommentReaction_userId_createdAt_idx" ON "DiscussionGroupCommentReaction"("userId", "createdAt");
CREATE INDEX "DiscussionGroupPollOption_pollId_position_idx" ON "DiscussionGroupPollOption"("pollId", "position");
CREATE INDEX "DiscussionGroupPollVote_userId_createdAt_idx" ON "DiscussionGroupPollVote"("userId", "createdAt");
CREATE INDEX "DiscussionGroupBan_groupId_expiresAt_idx" ON "DiscussionGroupBan"("groupId", "expiresAt");
CREATE INDEX "DiscussionGroupReport_groupId_status_createdAt_idx" ON "DiscussionGroupReport"("groupId", "status", "createdAt");
CREATE INDEX "DiscussionGroupReport_reporterId_createdAt_idx" ON "DiscussionGroupReport"("reporterId", "createdAt");
CREATE INDEX "DiscussionGroupModerationAction_groupId_createdAt_idx" ON "DiscussionGroupModerationAction"("groupId", "createdAt");
CREATE INDEX "DiscussionGroupModerationAction_targetId_createdAt_idx" ON "DiscussionGroupModerationAction"("targetId", "createdAt");

ALTER TABLE "DiscussionGroup" ADD CONSTRAINT "DiscussionGroup_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupMembership" ADD CONSTRAINT "DiscussionGroupMembership_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "DiscussionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupMembership" ADD CONSTRAINT "DiscussionGroupMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupMembershipRequest" ADD CONSTRAINT "DiscussionGroupMembershipRequest_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "DiscussionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupMembershipRequest" ADD CONSTRAINT "DiscussionGroupMembershipRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupInvitation" ADD CONSTRAINT "DiscussionGroupInvitation_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "DiscussionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupInvitation" ADD CONSTRAINT "DiscussionGroupInvitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupInvitation" ADD CONSTRAINT "DiscussionGroupInvitation_inviteeId_fkey" FOREIGN KEY ("inviteeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupPost" ADD CONSTRAINT "DiscussionGroupPost_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "DiscussionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupPost" ADD CONSTRAINT "DiscussionGroupPost_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupPost" ADD CONSTRAINT "DiscussionGroupPost_sharedFromId_fkey" FOREIGN KEY ("sharedFromId") REFERENCES "DiscussionGroupPost"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupPostMedia" ADD CONSTRAINT "DiscussionGroupPostMedia_postId_fkey" FOREIGN KEY ("postId") REFERENCES "DiscussionGroupPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupComment" ADD CONSTRAINT "DiscussionGroupComment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "DiscussionGroupPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupComment" ADD CONSTRAINT "DiscussionGroupComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupComment" ADD CONSTRAINT "DiscussionGroupComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "DiscussionGroupComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupPostReaction" ADD CONSTRAINT "DiscussionGroupPostReaction_postId_fkey" FOREIGN KEY ("postId") REFERENCES "DiscussionGroupPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupPostReaction" ADD CONSTRAINT "DiscussionGroupPostReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupCommentReaction" ADD CONSTRAINT "DiscussionGroupCommentReaction_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "DiscussionGroupComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupCommentReaction" ADD CONSTRAINT "DiscussionGroupCommentReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupPoll" ADD CONSTRAINT "DiscussionGroupPoll_postId_fkey" FOREIGN KEY ("postId") REFERENCES "DiscussionGroupPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupPollOption" ADD CONSTRAINT "DiscussionGroupPollOption_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "DiscussionGroupPoll"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupPollVote" ADD CONSTRAINT "DiscussionGroupPollVote_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "DiscussionGroupPollOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupPollVote" ADD CONSTRAINT "DiscussionGroupPollVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupBan" ADD CONSTRAINT "DiscussionGroupBan_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "DiscussionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupBan" ADD CONSTRAINT "DiscussionGroupBan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupBan" ADD CONSTRAINT "DiscussionGroupBan_issuerId_fkey" FOREIGN KEY ("issuerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupReport" ADD CONSTRAINT "DiscussionGroupReport_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "DiscussionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupReport" ADD CONSTRAINT "DiscussionGroupReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupReport" ADD CONSTRAINT "DiscussionGroupReport_postId_fkey" FOREIGN KEY ("postId") REFERENCES "DiscussionGroupPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupReport" ADD CONSTRAINT "DiscussionGroupReport_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "DiscussionGroupComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupModerationAction" ADD CONSTRAINT "DiscussionGroupModerationAction_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "DiscussionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupModerationAction" ADD CONSTRAINT "DiscussionGroupModerationAction_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupModerationAction" ADD CONSTRAINT "DiscussionGroupModerationAction_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
