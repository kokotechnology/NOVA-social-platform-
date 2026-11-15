ALTER TABLE "Post"
  ADD COLUMN "sharedPostId" TEXT,
  ADD COLUMN "sharedDiscussionPostId" TEXT,
  ADD COLUMN "sharedToUserId" TEXT,
  ADD COLUMN "shareRequestId" TEXT;

ALTER TABLE "Story"
  ADD COLUMN "sharedPostId" TEXT,
  ADD COLUMN "sharedDiscussionPostId" TEXT;

ALTER TABLE "DiscussionGroupPost"
  ADD COLUMN "sharedPostId" TEXT;

CREATE UNIQUE INDEX "Post_shareRequestId_key" ON "Post"("shareRequestId");
CREATE INDEX "Post_sharedToUserId_createdAt_idx" ON "Post"("sharedToUserId", "createdAt");
CREATE INDEX "Post_sharedPostId_idx" ON "Post"("sharedPostId");
CREATE INDEX "Post_sharedDiscussionPostId_idx" ON "Post"("sharedDiscussionPostId");
CREATE INDEX "Story_sharedPostId_idx" ON "Story"("sharedPostId");
CREATE INDEX "Story_sharedDiscussionPostId_idx" ON "Story"("sharedDiscussionPostId");
CREATE INDEX "DiscussionGroupPost_sharedPostId_idx" ON "DiscussionGroupPost"("sharedPostId");

CREATE TABLE "DiscussionGroupPostShare" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscussionGroupPostShare_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DiscussionGroupPostShare_requestId_key" ON "DiscussionGroupPostShare"("requestId");
CREATE INDEX "DiscussionGroupPostShare_postId_createdAt_idx" ON "DiscussionGroupPostShare"("postId", "createdAt");
CREATE INDEX "DiscussionGroupPostShare_userId_createdAt_idx" ON "DiscussionGroupPostShare"("userId", "createdAt");

ALTER TABLE "Post" ADD CONSTRAINT "Post_sharedPostId_fkey"
  FOREIGN KEY ("sharedPostId") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Post" ADD CONSTRAINT "Post_sharedDiscussionPostId_fkey"
  FOREIGN KEY ("sharedDiscussionPostId") REFERENCES "DiscussionGroupPost"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Post" ADD CONSTRAINT "Post_sharedToUserId_fkey"
  FOREIGN KEY ("sharedToUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Story" ADD CONSTRAINT "Story_sharedPostId_fkey"
  FOREIGN KEY ("sharedPostId") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Story" ADD CONSTRAINT "Story_sharedDiscussionPostId_fkey"
  FOREIGN KEY ("sharedDiscussionPostId") REFERENCES "DiscussionGroupPost"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupPost" ADD CONSTRAINT "DiscussionGroupPost_sharedPostId_fkey"
  FOREIGN KEY ("sharedPostId") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupPostShare" ADD CONSTRAINT "DiscussionGroupPostShare_postId_fkey"
  FOREIGN KEY ("postId") REFERENCES "DiscussionGroupPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionGroupPostShare" ADD CONSTRAINT "DiscussionGroupPostShare_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
