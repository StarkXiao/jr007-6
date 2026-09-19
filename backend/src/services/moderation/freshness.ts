import type { Prisma } from "@prisma/client";
import { env } from "../../config/env";
import {
  STALE_REPORT_THRESHOLD,
  STALE_SCORE_THRESHOLD,
  STALE_UNCONFIRMED_DAYS,
} from "../../config/constants";
import { prisma, toJsonValue } from "../../db/prisma";
import { computeFreshness } from "./credit";

const MS_PER_DAY = 86400000;

/** Prisma 交互式事务里的 client（没有 $transaction 等顶层方法） */
export type Tx = Prisma.TransactionClient;

export interface SpotFreshnessInputs {
  confirmCount: number;
  staleReportCount: number;
  lastConfirmedAt: Date | null;
  publishedAt: Date | null;
}

/** 汇总一条目的确认数据，新鲜度重算（确认接口、定时巡检、人工复查）共用 */
export async function loadFreshnessInputs(
  tx: Tx,
  spotId: bigint,
): Promise<SpotFreshnessInputs & { recentAccurateCount: number }> {
  const [spot, lastConfirmed, confirmCount, staleReportCount, recentAccurateCount] = await Promise.all([
    tx.spot.findUniqueOrThrow({
      where: { id: spotId },
      select: { publishedAt: true },
    }),
    tx.spotConfirmation.findFirst({
      where: { spotId, isAccurate: true },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    tx.spotConfirmation.count({ where: { spotId, isAccurate: true } }),
    tx.spotConfirmation.count({ where: { spotId, isAccurate: false } }),
    tx.spotConfirmation.count({
      where: { spotId, isAccurate: true, createdAt: { gte: new Date(Date.now() - 90 * MS_PER_DAY) } },
    }),
  ]);

  return {
    confirmCount,
    staleReportCount,
    lastConfirmedAt: lastConfirmed?.createdAt ?? null,
    publishedAt: spot.publishedAt,
    recentAccurateCount,
  };
}

/**
 * 巡检口径的 stale 判定，与文档第 9.4 节对应：
 * 1) 过期上报达到阈值（众包直接打标）；
 * 2) 长期无人确认——距上次确认（无确认按发布时间）超过 STALE_UNCONFIRMED_DAYS；
 * 3) 既无确认又因时间衰减跌破分数阈值。
 */
export function shouldAutoStale(
  inputs: SpotFreshnessInputs,
  now: Date = new Date(),
): boolean {
  if (inputs.staleReportCount >= STALE_REPORT_THRESHOLD) return true;

  const reference = inputs.lastConfirmedAt ?? inputs.publishedAt;
  const daysSinceReference = reference
    ? Math.floor((now.getTime() - reference.getTime()) / MS_PER_DAY)
    : Infinity;
  if (daysSinceReference >= STALE_UNCONFIRMED_DAYS) return true;

  const score = computeFreshness({ ...inputs, now });
  return score < STALE_SCORE_THRESHOLD && inputs.confirmCount === 0;
}

/**
 * 把待复核任务回灌审核队列。
 * 同一时间只允许有一个未决的复核任务，否则每天巡检都会重复投单。
 * 返回是否新建了任务。
 */
export async function enqueueStaleRecheck(
  tx: Tx,
  spot: { id: bigint; uuid: string },
  trigger: "STALE_REPORTED" | "STALE_SWEEP",
): Promise<boolean> {
  const openTask = await tx.reviewTask.findFirst({
    where: { spotId: spot.id, decidedAt: null },
    select: { id: true },
  });
  if (openTask) return false;

  const revision = await tx.spotRevision.findFirst({
    where: { spotId: spot.id },
    orderBy: { revisionNo: "desc" },
    select: { id: true },
  });
  if (!revision) return false;

  await tx.reviewTask.create({
    data: {
      spotId: spot.id,
      revisionId: revision.id,
      kind: "stale_recheck",
      status: "pending",
      priority: trigger === "STALE_REPORTED" ? 3 : 2,
      slaDueAt: new Date(Date.now() + env.REVIEW_SLA_HOURS * 3600000),
      autoCheck: toJsonValue({
        issues: [
          trigger === "STALE_REPORTED"
            ? { code: trigger, message: "多位用户反馈信息已过期" }
            : { code: trigger, message: "长时间无人确认，信息可能已过期" },
        ],
      }),
    },
  });

  return true;
}
