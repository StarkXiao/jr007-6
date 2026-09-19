import { describe, expect, it } from "vitest";
import { evaluateFreshnessState } from "../../src/modules/spots/freshness";

// 覆盖《项目文档.md》要求的新鲜度闭环：
// 时间衰减降权 → 打标回灌队列 → 众包翻案摘牌。
const NOW = new Date("2026-09-19T00:00:00Z");
const DAY = 86400000;

describe("新鲜度状态迁移 evaluateFreshnessState", () => {
  it("刚发布无人确认：不打标，基础分 50", () => {
    const state = evaluateFreshnessState({
      confirmCount: 0,
      staleReportCount: 0,
      recentConfirmCount: 0,
      lastConfirmedAt: null,
      publishedAt: NOW,
      isStale: false,
      now: NOW,
    });
    expect(state).toMatchObject({ score: 50, markStale: false, recovered: false });
  });

  it("过期上报达到 3 次立即打标", () => {
    const state = evaluateFreshnessState({
      confirmCount: 1,
      staleReportCount: 3,
      recentConfirmCount: 1,
      lastConfirmedAt: new Date(NOW.getTime() - 10 * DAY),
      publishedAt: new Date(NOW.getTime() - 30 * DAY),
      isStale: false,
      now: NOW,
    });
    expect(state.markStale).toBe(true);
  });

  it("长期无人确认且分数跌破 30（发布约 90 天）自动降权打标", () => {
    const publishedAt = new Date(NOW.getTime() - 90 * DAY);
    const state = evaluateFreshnessState({
      confirmCount: 0,
      staleReportCount: 0,
      recentConfirmCount: 0,
      lastConfirmedAt: null,
      publishedAt,
      isStale: false,
      now: NOW,
    });
    expect(state.score).toBeLessThan(30);
    expect(state.markStale).toBe(true);
  });

  it("时间按 30 天阶梯衰减，每 30 天 -10", () => {
    const at = (days: number) =>
      evaluateFreshnessState({
        confirmCount: 0,
        staleReportCount: 0,
        recentConfirmCount: 0,
        lastConfirmedAt: null,
        publishedAt: new Date(NOW.getTime() - days * DAY),
        isStale: false,
        now: NOW,
      }).score;
    expect(at(29)).toBe(50);
    expect(at(31)).toBe(40);
    expect(at(100)).toBe(20);
  });

  it("已打标条目不会被单次确认轻易翻案", () => {
    const state = evaluateFreshnessState({
      confirmCount: 1,
      staleReportCount: 3,
      recentConfirmCount: 1,
      lastConfirmedAt: NOW,
      publishedAt: new Date(NOW.getTime() - 60 * DAY),
      isStale: true,
      now: NOW,
    });
    expect(state.recovered).toBe(false);
    expect(state.markStale).toBe(true);
  });

  it("近期 3 人确认但分数没回升（本轮仍有过期上报）→ 不摘牌", () => {
    const state = evaluateFreshnessState({
      confirmCount: 3,
      staleReportCount: 3,
      recentConfirmCount: 3,
      lastConfirmedAt: NOW,
      publishedAt: new Date(NOW.getTime() - 120 * DAY),
      isStale: true,
      now: NOW,
    });
    // 50 + 3×10 − 3×15 = 35，确认人数够了但可信度分数没回升
    expect(state.score).toBe(35);
    expect(state.recovered).toBe(false);
    expect(state.markStale).toBe(true);
  });

  it("近期 3 人确认且分数回到 60 以上 → 众包翻案摘牌", () => {
    const fresh = evaluateFreshnessState({
      confirmCount: 6,
      staleReportCount: 3,
      recentConfirmCount: 3,
      lastConfirmedAt: NOW,
      publishedAt: new Date(NOW.getTime() - 120 * DAY),
      isStale: true,
      now: NOW,
    });
    // 50 + 6×10 − 3×15 = 65
    expect(fresh.score).toBe(65);
    expect(fresh.recovered).toBe(true);
    expect(fresh.markStale).toBe(false);
  });

  it("超过 90 天窗口的老确认不计入翻案所需的近期确认", () => {
    const state = evaluateFreshnessState({
      confirmCount: 3,
      staleReportCount: 0,
      recentConfirmCount: 0,
      lastConfirmedAt: new Date(NOW.getTime() - 100 * DAY),
      publishedAt: new Date(NOW.getTime() - 200 * DAY),
      isStale: true,
      now: NOW,
    });
    expect(state.recovered).toBe(false);
    expect(state.markStale).toBe(true);
  });

  it("分数被钳制在 0–100", () => {
    const flooded = evaluateFreshnessState({
      confirmCount: 0,
      staleReportCount: 50,
      recentConfirmCount: 0,
      lastConfirmedAt: null,
      publishedAt: new Date(NOW.getTime() - 400 * DAY),
      isStale: false,
      now: NOW,
    });
    expect(flooded.score).toBe(0);

    const popular = evaluateFreshnessState({
      confirmCount: 50,
      staleReportCount: 0,
      recentConfirmCount: 50,
      lastConfirmedAt: NOW,
      publishedAt: NOW,
      isStale: false,
      now: NOW,
    });
    expect(popular.score).toBe(100);
  });
});
