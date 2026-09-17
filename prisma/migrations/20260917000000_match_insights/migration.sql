-- CreateTable
CREATE TABLE "match_insights" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "as_of" TIMESTAMP(3) NOT NULL,
    "research" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "sources" JSONB NOT NULL,
    "search_queries" JSONB,
    "home_goal_adjustment" DECIMAL(5,3) NOT NULL,
    "away_goal_adjustment" DECIMAL(5,3) NOT NULL,
    "result_lean" DECIMAL(5,3) NOT NULL,
    "confidence" DECIMAL(4,3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "match_insights_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "match_insights_match_id_key" ON "match_insights"("match_id");

-- CreateIndex
CREATE INDEX "match_insights_as_of_idx" ON "match_insights"("as_of");

-- AddForeignKey
ALTER TABLE "match_insights" ADD CONSTRAINT "match_insights_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
