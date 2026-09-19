-- 众包复核闭环：
-- 1. review_tasks 增加任务类型，区分「新提交审核」与「过期条目人工复查」；
-- 2. spots 增加新鲜度本轮统计起点 freshness_reset_at，
--    人工复查确认 / 众包翻案后旧账不再参与计分。
--
-- 本迁移手工编写：没有触碰 spots 上的三个手工索引
-- （idx_spots_title_trgm / idx_spots_attributes / idx_spots_geo_public）。

CREATE TYPE "ReviewTaskKind" AS ENUM ('submission', 'stale_recheck');

ALTER TABLE "review_tasks" ADD COLUMN "kind" "ReviewTaskKind" NOT NULL DEFAULT 'submission';

-- 存量的待办任务里，autoCheck 带 STALE_* 标记的是此前回灌的过期复核任务
UPDATE "review_tasks"
SET "kind" = 'stale_recheck'
WHERE "auto_check"::text LIKE '%STALE_REPORTED%'
   OR "auto_check"::text LIKE '%STALE_SWEEP%';

CREATE INDEX "idx_review_kind" ON "review_tasks" ("kind", "status");

ALTER TABLE "spots" ADD COLUMN "freshness_reset_at" TIMESTAMPTZ(6);
