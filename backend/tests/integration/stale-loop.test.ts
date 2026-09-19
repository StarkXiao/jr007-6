import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { initStorage } from "../../src/services/storage";
import { staleSweep } from "../../src/jobs";

// 众包复核闭环（《项目文档.md》5.6 / A9）：
// 上报过期 → 打标回灌队列 → 人工复查确认摘牌；
// 长期无人确认 → 每日巡检自动降权打标；
// 多人近期确认 → 众包翻案自动摘牌。
//
// 跑在真实数据库与 Redis 上（docker compose up -d postgres redis）。
let app: Express;
let ownerToken = "";
let moderatorToken = "";
const userUuids: string[] = [];
const tokens: Record<string, string> = {};

const suffix = Date.now().toString(36);
const password = "Str0ngPass1";

async function registerAndLogin(label: string, role: "user" | "moderator" = "user") {
  const email = `${label}-${suffix}@example.com`;
  await request(app)
    .post("/api/v1/auth/register")
    .send({ email, password, nickname: `${label}${suffix.slice(-4)}` })
    .expect(201);
  const login = await request(app).post("/api/v1/auth/login").send({ account: email, password }).expect(200);
  const me = await request(app)
    .get("/api/v1/auth/me")
    .set("Authorization", `Bearer ${login.body.data.accessToken}`)
    .expect(200);
  userUuids.push(me.body.data.user.uuid);
  tokens[label] = login.body.data.accessToken;
  if (role === "moderator") {
    await prisma.user.update({ where: { email }, data: { role: "moderator" } });
    const relogin = await request(app).post("/api/v1/auth/login").send({ account: email, password }).expect(200);
    tokens[label] = relogin.body.data.accessToken;
  }
}

async function createPublishedSpot(title: string): Promise<{ spotUuid: string; taskId: string }> {
  const created = await request(app)
    .post("/api/v1/spots")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({
      categoryCode: "bench",
      title,
      description: "众包复核闭环集成测试",
      attributes: { has_backrest: true, condition: "good", count: 1 },
      lat: 30.2 + Math.random() * 0.01,
      lng: 120.6 + Math.random() * 0.01,
      fuzzEnabled: true,
      fuzzRadiusM: 100,
      mediaUuids: [],
    })
    .expect(201);

  const submitted = await request(app)
    .post(`/api/v1/spots/${created.body.data.uuid}/submit`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .expect(200);

  const taskId = submitted.body.data.taskId;
  await request(app)
    .post(`/api/v1/moderation/tasks/${taskId}/claim`)
    .set("Authorization", `Bearer ${moderatorToken}`)
    .expect(200);
  await request(app)
    .post(`/api/v1/moderation/tasks/${taskId}/approve`)
    .set("Authorization", `Bearer ${moderatorToken}`)
    .send({ reason: "测试放行" })
    .expect(200);

  return { spotUuid: created.body.data.uuid, taskId };
}

beforeAll(async () => {
  await initStorage();
  app = createApp();

  await registerAndLogin("owner");
  await registerAndLogin("mod", "moderator");
  await registerAndLogin("u1");
  await registerAndLogin("u2");
  await registerAndLogin("u3");

  ownerToken = tokens.owner;
  moderatorToken = tokens.mod;
}, 60000);

afterAll(async () => {
  const records = await prisma.user.findMany({ where: { uuid: { in: userUuids } }, select: { id: true } });
  const ids = records.map((record) => record.id);
  if (ids.length > 0) {
    await prisma.comment.deleteMany({ where: { userId: { in: ids } } });
    await prisma.report.deleteMany({ where: { reporterId: { in: ids } } });
    await prisma.spot.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.mediaAsset.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.$disconnect();
}, 60000);

describe("众包复核：上报过期 → 人工复查", () => {
  let spotUuid = "";
  let recheckTaskId = "";

  it("3 位用户上报过期后条目被打标并回灌复核队列", async () => {
    const created = await createPublishedSpot(`过期长椅${suffix.slice(-4)}`);
    spotUuid = created.spotUuid;

    for (const label of ["u1", "u2"]) {
      await request(app)
        .post(`/api/v1/spots/${spotUuid}/confirm`)
        .set("Authorization", `Bearer ${tokens[label]}`)
        .send({ isAccurate: false })
        .expect(200);
    }

    const before = await request(app).get(`/api/v1/spots/${spotUuid}`).expect(200);
    expect(before.body.data.freshness.isStale).toBe(false);

    const third = await request(app)
      .post(`/api/v1/spots/${spotUuid}/confirm`)
      .set("Authorization", `Bearer ${tokens.u3}`)
      .send({ isAccurate: false })
      .expect(200);

    expect(third.body.data.isStale).toBe(true);
    expect(third.body.data.addedReviewTask).toBe(true);

    // 回灌的任务带独立类型，审核台可单独筛选
    const queue = await request(app)
      .get("/api/v1/moderation/queue?kind=stale_recheck")
      .set("Authorization", `Bearer ${moderatorToken}`)
      .expect(200);
    const task = queue.body.data.items.find(
      (item: { spot: { uuid: string } }) => item.spot.uuid === spotUuid,
    );
    expect(task).toBeTruthy();
    expect(task.kind).toBe("stale_recheck");
    recheckTaskId = task.id;
  });

  it("同一批上报不会重复回灌复核任务", async () => {
    // 再上报一次（换个 30 天内没上报过的人）——任务已存在，只复用不入新队
    await registerAndLogin("u4");
    await request(app)
      .post(`/api/v1/spots/${spotUuid}/confirm`)
      .set("Authorization", `Bearer ${tokens.u4}`)
      .send({ isAccurate: false })
      .expect(200);

    const queue = await request(app)
      .get("/api/v1/moderation/queue?kind=stale_recheck&status=pending")
      .set("Authorization", `Bearer ${moderatorToken}`)
      .expect(200);
    const matches = queue.body.data.items.filter(
      (item: { spot: { uuid: string } }) => item.spot.uuid === spotUuid,
    );
    expect(matches).toHaveLength(1);
  });

  it("人工复查确认后摘牌、旧账清零，条目恢复正常", async () => {
    await request(app)
      .post(`/api/v1/moderation/tasks/${recheckTaskId}/claim`)
      .set("Authorization", `Bearer ${moderatorToken}`)
      .expect(200);
    await request(app)
      .post(`/api/v1/moderation/tasks/${recheckTaskId}/approve`)
      .set("Authorization", `Bearer ${moderatorToken}`)
      .send({ reason: "现场核实仍然存在" })
      .expect(200);

    const detail = await request(app).get(`/api/v1/spots/${spotUuid}`).expect(200);
    expect(detail.body.data.status).toBe("published");
    expect(detail.body.data.freshness.isStale).toBe(false);
    // 旧的过期上报已翻篇，新一轮统计从干净的基准开始
    expect(detail.body.data.freshness.staleReportCount ?? 0).toBe(0);
  });
});

describe("众包复核：时间衰减 → 自动降权 → 众包翻案", () => {
  let spotUuid = "";

  it("长期无人确认的条目被每日巡检打标", async () => {
    const created = await createPublishedSpot(`冷清长椅${suffix.slice(-4)}`);
    spotUuid = created.spotUuid;

    // 直接把发布时间拨到 100 天前：无确认、分数 50-30=20 < 30
    const spot = await prisma.spot.findUniqueOrThrow({ where: { uuid: spotUuid } });
    await prisma.spot.update({
      where: { id: spot.id },
      data: { publishedAt: new Date(Date.now() - 100 * 86400000) },
    });

    const result = await staleSweep();
    expect(result.markedStale).toBeGreaterThanOrEqual(1);

    const detail = await request(app).get(`/api/v1/spots/${spotUuid}`).expect(200);
    expect(detail.body.data.freshness.isStale).toBe(true);
    expect(detail.body.data.freshness.score).toBeLessThan(30);
  });

  it("近期 3 人实地确认后自动翻案摘牌", async () => {
    for (const label of ["u1", "u2", "u3"]) {
      await request(app)
        .post(`/api/v1/spots/${spotUuid}/confirm`)
        .set("Authorization", `Bearer ${tokens[label]}`)
        .send({ isAccurate: true })
        .expect(200);
    }

    const detail = await request(app).get(`/api/v1/spots/${spotUuid}`).expect(200);
    expect(detail.body.data.freshness.isStale).toBe(false);
    expect(detail.body.data.freshness.score).toBeGreaterThanOrEqual(60);
  });
});
