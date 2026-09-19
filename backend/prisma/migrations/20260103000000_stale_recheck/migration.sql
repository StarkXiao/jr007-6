-- 众包复核闭环：审核任务区分"新提交审核"与"新鲜度回灌的待复核"。
-- 长期无人确认的条目被 stale-sweep 打上 stale 标记后，以 stale_recheck
-- 任务回灌审核队列；人工复查通过后清除 stale 标记并重置新鲜度。

-- CreateEnum
CREATE TYPE "ReviewKind" AS ENUM ('submission', 'stale_recheck');

-- AlterTable
ALTER TABLE "review_tasks" ADD COLUMN "kind" "ReviewKind" NOT NULL DEFAULT 'submission';

-- 复核队列按类型筛选（审核台默认只看待领取任务，加 kind 复合在最前没有收益）
CREATE INDEX "idx_review_kind" ON "review_tasks"("kind", "status");

-- 新鲜度巡检按"最近确认时间"找长期无人确认的条目
CREATE INDEX "idx_spots_published_stale" ON "spots"("status", "is_stale", "published_at");
