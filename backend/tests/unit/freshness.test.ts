import { describe, expect, it } from "vitest";
import { computeFreshness } from "../../src/services/moderation/credit";
import { shouldAutoStale } from "../../src/services/moderation/freshness";

const DAY = 86400000;

describe("新鲜度时间衰减", () => {
  it("刚发布、无确认时为基础分 50", () => {
    const now = new Date("2026-09-19T00:00:00Z");
    const score = computeFreshness({
      confirmCount: 0,
      staleReportCount: 0,
      lastConfirmedAt: null,
      publishedAt: now,
      now,
    });
    expect(score).toBe(50);
  });

  it("每次确认 +10，过期上报每次 -15", () => {
    const now = new Date("2026-09-19T00:00:00Z");
    expect(
      computeFreshness({
        confirmCount: 3,
        staleReportCount: 0,
        lastConfirmedAt: now,
        publishedAt: now,
        now,
      }),
    ).toBe(80);
    expect(
      computeFreshness({
        confirmCount: 3,
        staleReportCount: 2,
        lastConfirmedAt: now,
        publishedAt: now,
        now,
      }),
    ).toBe(50);
  });

  it("距上次确认每满 30 天扣 10 分，衰减锚定在最近一次确认而非发布时间", () => {
    const now = new Date("2026-09-19T00:00:00Z");
    const publishedAt = new Date(now.getTime() - 400 * DAY);
    const lastConfirmedAt = new Date(now.getTime() - 61 * DAY);

    // 发布已 400 天，但 61 天前刚被确认，衰减只按 61 天算 2 档
    const score = computeFreshness({
      confirmCount: 1,
      staleReportCount: 0,
      lastConfirmedAt,
      publishedAt,
      now,
    });
    expect(score).toBe(50 + 10 - 20);
  });

  it("分数被钳制在 0–100", () => {
    const now = new Date("2026-09-19T00:00:00Z");
    const ancient = new Date(now.getTime() - 1000 * DAY);
    expect(
      computeFreshness({
        confirmCount: 0,
        staleReportCount: 10,
        lastConfirmedAt: ancient,
        publishedAt: ancient,
        now,
      }),
    ).toBe(0);
    expect(
      computeFreshness({
        confirmCount: 20,
        staleReportCount: 0,
        lastConfirmedAt: now,
        publishedAt: now,
        now,
      }),
    ).toBe(100);
  });
});

describe("stale 自动判定", () => {
  const now = new Date("2026-09-19T00:00:00Z");

  it("过期上报达到阈值直接判 stale", () => {
    expect(
      shouldAutoStale(
        { confirmCount: 5, staleReportCount: 3, lastConfirmedAt: now, publishedAt: now },
        now,
      ),
    ).toBe(true);
  });

  it("距上次确认超过 180 天即判 stale，即使历史上有人确认过", () => {
    const lastConfirmedAt = new Date(now.getTime() - 181 * DAY);
    expect(
      shouldAutoStale(
        { confirmCount: 4, staleReportCount: 0, lastConfirmedAt, publishedAt: new Date(now.getTime() - 300 * DAY) },
        now,
      ),
    ).toBe(true);
  });

  it("无任何确认且从未发布（锚点缺失）视为 stale", () => {
    expect(
      shouldAutoStale({ confirmCount: 0, staleReportCount: 0, lastConfirmedAt: null, publishedAt: null }, now),
    ).toBe(true);
  });

  it("近期被确认过的条目保持新鲜", () => {
    const lastConfirmedAt = new Date(now.getTime() - 10 * DAY);
    expect(
      shouldAutoStale(
        { confirmCount: 2, staleReportCount: 0, lastConfirmedAt, publishedAt: new Date(now.getTime() - 200 * DAY) },
        now,
      ),
    ).toBe(false);
  });

  it("179 天未确认尚不足 180 天阈值，不误判", () => {
    const lastConfirmedAt = new Date(now.getTime() - 179 * DAY);
    expect(
      shouldAutoStale(
        // 有 1 个确认使基础分足够高，绕开"0 确认 + 低分"分支，单独验证天数边界
        { confirmCount: 3, staleReportCount: 0, lastConfirmedAt, publishedAt: new Date(now.getTime() - 179 * DAY) },
        now,
      ),
    ).toBe(false);
  });
});
