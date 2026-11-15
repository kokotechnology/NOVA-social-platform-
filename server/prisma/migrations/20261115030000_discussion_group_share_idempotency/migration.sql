ALTER TABLE "DiscussionGroupPost"
  ADD COLUMN "shareRequestId" TEXT;

CREATE UNIQUE INDEX "DiscussionGroupPost_shareRequestId_key"
  ON "DiscussionGroupPost"("shareRequestId");
