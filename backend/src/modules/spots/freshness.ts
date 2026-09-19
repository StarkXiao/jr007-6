import {
  FRESHNESS_RECOVERY_CONFIRMS,
  FRESHNESS_RECOVERY_SCORE,
  FRESHNESS_RECENT_WINDOW_MS,
  FRESHNESS_STALE_SCORE,
  STALE_REPORT_THRESHOLD,
} from "../../config/constants";
import { prisma, toJsonValue } from "../../db/prisma";
import { env } from "../../config/env";
import { computeFreshness } from "../../services/moderation/credit";

/** 复核任务 autoCheck 中使用的原因码，队列列表与任务详情据此识别“过期复查” */
export const STALE_REPORTED_ISSUE = { code: "STALE_REPORTED", message: "多位用户反馈信息已过期" } as const;
export const STALE_SWEEP_ISSUE = { code: "STALE_SWEEP", message: "长时间无人确认，信息可能已过期" } as const;

export interface FreshnessSignals {
  /** 本轮（freshnessResetAt 之后）准确确认数 */
  confirmCount: number;
  /** 本轮过期上报数 */
  staleReportCount: number;
  lastConfirmedAt: Date | null;
  publishedAt: Date | null;
  /** 近期（90 天）准确确认数，用于众包翻案 */
  recentConfirmCount: number;
  isStale: boolean;
  now?: Date;
}

export interface FreshnessState {
  score: number;
  markStale: boolean;
  /** 众包复核让条目恢复可信：摘除过期标记、旧账清零 */
  recovered: boolean;
}

/**
 * 纯函数：给定本轮信号，计算分数与状态迁移。
 *
 * - 降权：分数随时间衰减；过期上报达阈值，或分数跌破阈值且本轮无人确认 → 打标
 * - 翻案：已打标的条目在近期获得足够多的准确确认、且分数回升 → 摘牌
 */
export function evaluateFreshnessState(signals: FreshnessSignals): FreshnessState {
  const score = computeFreshness({
    confirmCount: signals.confirmCount,
    staleReportCount: signals.staleReportCount,
    lastConfirmedAt: signals.lastConfirmedAt,
    publishedAt: signals.publishedAt,
    now: signals.now,
  });

  if (!signals.isStale) {
    const markStale =
      signals.staleReportCount >= STALE_REPORT_THRESHOLD ||
      (score < FRESHNESS_STALE_SCORE && signals.confirmCount === 0);
    return { score, markStale, recovered: false };
  }

  const recovered =
    signals.recentConfirmCount >= FRESHNESS_RECOVERY_CONFIRMS && score >= FRESHNESS_RECOVERY_SCORE;
  return { score, markStale: !recovered, recovered };
}

export interface SpotFreshnessRow {
  id: bigint;
  uuid: string;
  ownerId: bigint;
  status: string;
  freshnessScore: number;
  isStale: boolean;
  freshnessResetAt: Date | null;
  publishedAt: Date | null;
  confirmations: Array<{ isAccurate: boolean; createdAt: Date }>;
}

/**
 * 按“本轮”（freshnessResetAt 之后）的确认记录重算单个条目，
 * 必要时打标 / 翻案，并返回状态迁移结果供调用方决定通知与队列动作。
 *
 * 不创建审核任务——回灌队列由 enqueueStaleRecheck 单独负责，
 * 这样人工复查与定时巡检两条触发路径都能复用本函数。
 */
export async function recalculateSpotFreshness(
  spot: Pick<SpotFreshnessRow, "id" | "freshnessResetAt" | "publishedAt" | "isStale">,
  now: Date = new Date(),
): Promise<FreshnessState & { confirmCount: number; staleReportCount: number; lastConfirmedAt: Date | null }> {
  const resetAt = spot.freshnessResetAt ?? null;
  const windowStart = new Date(now.getTime() - FRESHNESS_RECENT_WINDOW_MS);

  const rows = await prisma.spotConfirmation.findMany({
    where: {
      spotId: spot.id,
      ...(resetAt ? { createdAt: { gt: resetAt } } : {}),
    },
    select: { isAccurate: true, createdAt: true },
  });

  const accurate = rows.filter((row) => row.isAccurate);
  const confirmCount = accurate.length;
  const staleReportCount = rows.length - accurate.length;
  const lastConfirmedAt = accurate
    .map((row) => row.createdAt)
    .reduce<Date | null>((latest, at) => (latest && latest > at ? latest : at), null);
  const recentConfirmCount = accurate.filter((row) => row.createdAt >= windowStart).length;

  const state = evaluateFreshnessState({
    confirmCount,
    staleReportCount,
    lastConfirmedAt,
    publishedAt: spot.publishedAt,
    recentConfirmCount,
    isStale: spot.isStale,
    now,
  });

  // 翻案：本轮统计基准移到当前，旧的过期上报不再参与分数
  const recoveredResetAt = state.recovered ? now : spot.freshnessResetAt;

  await prisma.spot.update({
    where: { id: spot.id },
    data: {
      freshnessScore: state.score,
      confirmCount,
      staleReportCount,
      isStale: state.markStale,
      freshnessResetAt: recoveredResetAt,
    },
  });

  return { ...state, confirmCount, staleReportCount, lastConfirmedAt };
}

/**
 * 为长期无人确认 / 多人上报过期的条目回灌一个人工复查任务。
 *
 * 只入队一次：该条目已有未决策的过期复查任务时直接复用。
 * 这类任务带独立类型 kind=stale_recheck，审核台可以与新提交审核区分展示。
 */
export async function enqueueStaleRecheck(
  spot: Pick<SpotFreshnessRow, "id">,
  issue: typeof STALE_REPORTED_ISSUE | typeof STALE_SWEEP_ISSUE,
  priority: number,
): Promise<bigint | null> {
  const revision = await prisma.spotRevision.findFirst({
    where: { spotId: spot.id },
    orderBy: { revisionNo: "desc" },
    select: { id: true },
  });
  if (!revision) return null;

  const openTask = await prisma.reviewTask.findFirst({
    where: { spotId: spot.id, kind: "stale_recheck", decidedAt: null },
    select: { id: true },
  });
  if (openTask) return openTask.id;

  const task = await prisma.reviewTask.create({
    data: {
      spotId: spot.id,
      revisionId: revision.id,
      kind: "stale_recheck",
      status: "pending",
      priority,
      autoCheck: toJsonValue({ issues: [issue] }),
      slaDueAt: new Date(Date.now() + env.REVIEW_SLA_HOURS * 3600000),
    },
    select: { id: true },
  });

  return task.id;
}
