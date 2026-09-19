import { prisma } from "../db/prisma";
import { computeFreshness } from "../services/moderation/credit";
import { enqueueStaleRecheck, shouldAutoStale } from "../services/moderation/freshness";
import { purgeOriginal } from "../modules/media/service";
import { notify } from "../services/notify";
import { logger } from "../utils/logger";
import { redis } from "../db/redis";

const MS_PER_DAY = 86400000;
const OVERDUE_ALERT_KEY = "psdm:sla-alert-sent";
const OVERDUE_ALERT_TTL_SECONDS = 6 * 3600;

/**
 * SLA 巡检：每 15 分钟一次。
 * 超时的审核任务与举报工单会被提升优先级并提醒管理员——
 * 一个没有超时机制的审核队列，最终一定会积压到没人看。
 */
export async function slaSweep(): Promise<{ overdueTasks: number; overdueReports: number }> {
  const now = new Date();

  const overdueTasks = await prisma.reviewTask.findMany({
    where: { decidedAt: null, slaDueAt: { lt: now }, status: { in: ["pending", "in_review", "appealed"] } },
    select: { id: true, spotId: true, priority: true, slaDueAt: true },
    take: 200,
  });

  if (overdueTasks.length > 0) {
    await prisma.reviewTask.updateMany({
      where: { id: { in: overdueTasks.map((task) => task.id) } },
      data: { priority: { increment: 1 } },
    });
  }

  const overdueReports = await prisma.report.findMany({
    where: { status: { in: ["open", "in_review"] }, slaDueAt: { lt: now }, mergedInto: null },
    select: { id: true, reason: true, targetType: true, targetId: true },
    take: 200,
  });

  // 超时任务会持续存在，如果每 15 分钟都推一次通知，
  // 管理员很快就不再看了。这里用 Redis 做 6 小时节流。
  let shouldAlert = overdueTasks.length > 0 || overdueReports.length > 0;
  if (shouldAlert) {
    try {
      shouldAlert = (await redis.set(OVERDUE_ALERT_KEY, "1", "EX", OVERDUE_ALERT_TTL_SECONDS, "NX")) === "OK";
    } catch {
      // Redis 异常时退化为每次都提醒，宁可吵也不要漏
      shouldAlert = true;
    }
  }

  if (shouldAlert) {
    const admins = await prisma.user.findMany({
      where: { role: { in: ["admin", "moderator"] }, status: "active" },
      select: { id: true },
    });

    for (const admin of admins) {
      await notify({
        userId: admin.id,
        type: "report_result",
        title: "有工单已超过处理时限",
        body: `待处理超时：审核 ${overdueTasks.length} 条，举报 ${overdueReports.length} 条`,
        payload: { overdueTasks: overdueTasks.length, overdueReports: overdueReports.length },
      });
    }

    logger.warn(
      { overdueTasks: overdueTasks.length, overdueReports: overdueReports.length },
      "SLA 巡检发现超时工单",
    );
  }

  return { overdueTasks: overdueTasks.length, overdueReports: overdueReports.length };
}

/**
 * 新鲜度巡检：每天一次。
 * 重算分数、对长期无人确认的条目自动降权打标，并把它们以 stale_recheck
 * 任务回灌审核队列等待人工复查确认。
 */
export async function staleSweep(): Promise<{ recomputed: number; markedStale: number; requeued: number }> {
  const now = new Date();
  const spots = await prisma.spot.findMany({
    where: { status: "published", deletedAt: null },
    select: {
      id: true,
      uuid: true,
      ownerId: true,
      confirmCount: true,
      staleReportCount: true,
      isStale: true,
      publishedAt: true,
      confirmations: {
        where: { isAccurate: true },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { createdAt: true },
      },
    },
  });

  let markedStale = 0;
  let requeued = 0;

  for (const spot of spots) {
    const inputs = {
      confirmCount: spot.confirmCount,
      staleReportCount: spot.staleReportCount,
      lastConfirmedAt: spot.confirmations[0]?.createdAt ?? null,
      publishedAt: spot.publishedAt,
    };
    const freshnessScore = computeFreshness({ ...inputs, now });
    const shouldMarkStale = !spot.isStale && shouldAutoStale(inputs, now);

    await prisma.spot.update({
      where: { id: spot.id },
      data: { freshnessScore, isStale: spot.isStale || shouldMarkStale },
    });

    if (shouldMarkStale) {
      markedStale += 1;

      const enqueued = await prisma.$transaction((tx) => enqueueStaleRecheck(tx, { id: spot.id, uuid: spot.uuid }, "STALE_SWEEP"));
      if (enqueued) requeued += 1;

      await notify({
        userId: spot.ownerId,
        type: "spot_stale",
        title: "你记录的这条信息需要重新确认",
        body: "已经有一段时间没有人确认这条记录了，麻烦你有空时更新一下现场情况。",
        payload: { spotUuid: spot.uuid },
      });
    }
  }

  if (markedStale > 0) {
    logger.warn({ markedStale, requeued }, "新鲜度巡检对长期无人确认的条目降权并回灌复核队列");
  }

  return { recomputed: spots.length, markedStale, requeued };
}

/**
 * 原图清理：每天一次。
 * 超过保留期的原图被彻底删除，只留下已模糊化的公开版本——
 * 这是数据最小化承诺里最关键的一条。
 */
export async function purgeOriginalImages(): Promise<{ purged: number }> {
  const due = await prisma.mediaAsset.findMany({
    where: { purgeAfter: { lt: new Date() }, originalPath: { not: null } },
    select: { uuid: true },
    take: 500,
  });

  let purged = 0;
  for (const asset of due) {
    const done = await purgeOriginal(asset.uuid).catch((error) => {
      logger.warn({ err: (error as Error).message, uuid: asset.uuid }, "原图清理失败");
      return false;
    });
    if (done) purged += 1;
  }

  return { purged };
}

/** 日常清理：过期令牌、超期通知、失效的审核锁 */
export async function cleanup(): Promise<{
  tokens: number;
  notifications: number;
  locks: number;
  unmuted: number;
}> {
  const now = new Date();

  const [tokens, notifications, locks, unmuted] = await Promise.all([
    prisma.refreshToken.deleteMany({
      where: { OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: new Date(now.getTime() - 30 * MS_PER_DAY) } }] },
    }),
    prisma.notification.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - 90 * MS_PER_DAY) } },
    }),
    prisma.reviewTask.updateMany({
      where: { lockedUntil: { lt: now }, status: "in_review", decidedAt: null },
      data: { assignedTo: null, lockedUntil: null, status: "pending" },
    }),
    // 兜底解除到期禁言，避免权限状态长期不一致
    prisma.user.updateMany({
      where: { status: "muted", mutedUntil: { lt: now } },
      data: { status: "active", mutedUntil: null },
    }),
  ]);

  return {
    tokens: tokens.count,
    notifications: notifications.count,
    locks: locks.count,
    unmuted: unmuted.count,
  };
}
