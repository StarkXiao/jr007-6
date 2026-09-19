import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { initStorage } from "../../src/services/storage";
import { staleSweep } from "../../src/jobs";

// 众包复核闭环（真实数据库 + Redis）：
// 过期上报打标 → stale_recheck 任务回灌队列 → 人工复查解除降权；
// 以及长期无人确认被 staleSweep 自动降权回灌。
let app: Express;
let ownerToken = "";
let moderatorToken = "";
let ownerUuid = "";
let moderatorUuid = "";
const helperUuids: string[] = [];
const helperTokens: string[] = [];

const suffix = Date.now().toString(36);
const password = "Str0ngPass1";
const ownerEmail = `fresh-owner-${suffix}@example.com`;
const moderatorEmail = `fresh-mod-${suffix}@example.com`;

async function login(account: string): Promise<string> {
  const response = await request(app).post("/api/v1/auth/login").send({ account, password }).expect(200);
  return response.body.data.accessToken;
}

beforeAll(async () => {
  await initStorage();
  app = createApp();

  await request(app)
    .post("/api/v1/auth/register")
    .send({ email: ownerEmail, password, nickname: `新鲜度作者${suffix.slice(-4)}` })
    .expect(201);
  await request(app)
    .post("/api/v1/auth/register")
    .send({ email: moderatorEmail, password, nickname: `新鲜度审核${suffix.slice(-4)}` })
    .expect(201);
  await prisma.user.update({ where: { email: moderatorEmail }, data: { role: "moderator" } });

  ownerToken = await login(ownerEmail);
  moderatorToken = await login(moderatorEmail);
  const me = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${ownerToken}`).expect(200);
  ownerUuid = me.body.data.user.uuid;
  moderatorUuid = (
    await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${moderatorToken}`).expect(200)
  ).body.data.user.uuid;

  // 三个众包用户，用于过期上报 / 复活确认
  for (let i = 0; i < 3; i += 1) {
    const email = `fresh-helper-${suffix}-${i}@example.com`;
    await request(app)
      .post("/api/v1/auth/register")
      .send({ email, password, nickname: `复核路人${i}` })
      .expect(201);
    helperTokens.push(await login(email));
    const helperMe = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${helperTokens[i]}`)
      .expect(200);
    helperUuids.push(helperMe.body.data.user.uuid);
  }
}, 60000);

afterAll(async () => {
  const users = [ownerUuid, moderatorUuid, ...helperUuids].filter(Boolean);
  const records = await prisma.user.findMany({ where: { uuid: { in: users } }, select: { id: true } });
  const ids = records.map((record) => record.id);
  if (ids.length > 0) {
    await prisma.spotConfirmation.deleteMany({ where: { userId: { in: ids } } });
    await prisma.spot.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.$disconnect();
}, 60000);

async function createPublishedSpot(title: string): Promise<string> {
  const created = await request(app)
    .post("/api/v1/spots")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({
      categoryCode: "bench",
      title,
      attributes: { has_backrest: true, condition: "good", count: 1 },
      lat: 30.2 + Math.random() * 0.01,
      lng: 120.6 + Math.random() * 0.01,
      fuzzEnabled: true,
      fuzzRadiusM: 100,
      mediaUuids: [],
    })
    .expect(201);
  const uuid = created.body.data.uuid;

  const submitted = await request(app)
    .post(`/api/v1/spots/${uuid}/submit`)
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
    .send({ reason: "测试发布" })
    .expect(200);

  return uuid;
}

describe("众包过期上报 → 人工复查", () => {
  it("3 次过期反馈后打标并生成 stale_recheck 任务，人工复查后解除降权", async () => {
    const uuid = await createPublishedSpot(`过期上报长椅${suffix.slice(-4)}`);
    const spotId = (await prisma.spot.findUniqueOrThrow({ where: { uuid } })).id;

    // 三个不同用户上报过期
    for (let i = 0; i < 3; i += 1) {
      await request(app)
        .post(`/api/v1/spots/${uuid}/confirm`)
        .set("Authorization", `Bearer ${helperTokens[i]}`)
        .send({ isAccurate: false })
        .expect(200);
    }

    const flagged = await prisma.spot.findUniqueOrThrow({ where: { uuid } });
    expect(flagged.isStale).toBe(true);
    expect(flagged.staleReportCount).toBe(3);

    const recheckTask = await prisma.reviewTask.findFirstOrThrow({
      where: { spotId, kind: "stale_recheck", decidedAt: null },
    });
    expect(recheckTask.status).toBe("pending");

    // 队列接口能按 kind 筛出复核任务
    const queue = await request(app)
      .get("/api/v1/moderation/queue?kind=stale_recheck")
      .set("Authorization", `Bearer ${moderatorToken}`)
      .expect(200);
    expect(queue.body.data.items.some((item: { id: string }) => item.id === recheckTask.id.toString())).toBe(true);

    // 任务详情带复核上下文
    await request(app)
      .post(`/api/v1/moderation/tasks/${recheckTask.id}/claim`)
      .set("Authorization", `Bearer ${moderatorToken}`)
      .expect(200);
    const detail = await request(app)
      .get(`/api/v1/moderation/tasks/${recheckTask.id}`)
      .set("Authorization", `Bearer ${moderatorToken}`)
      .expect(200);
    expect(detail.body.data.kind).toBe("stale_recheck");
    expect(detail.body.data.recheck).not.toBeNull();
    expect(detail.body.data.spot.freshness.isStale).toBe(true);

    // 人工复查通过：解除 stale，过期上报清零，分数回升
    await request(app)
      .post(`/api/v1/moderation/tasks/${recheckTask.id}/approve`)
      .set("Authorization", `Bearer ${moderatorToken}`)
      .send({ reason: "现场核实，长椅仍在" })
      .expect(200);

    const restored = await prisma.spot.findUniqueOrThrow({ where: { uuid } });
    expect(restored.isStale).toBe(false);
    expect(restored.staleReportCount).toBe(0);
    expect(restored.freshnessScore).toBeGreaterThanOrEqual(60);
  }, 60000);
});

describe("staleSweep 时间衰减巡检", () => {
  it("长期无人确认的条目被自动降权并回灌复核队列", async () => {
    const uuid = await createPublishedSpot(`无人确认长椅${suffix.slice(-4)}`);
    const spotId = (await prisma.spot.findUniqueOrThrow({ where: { uuid } })).id;

    // 把发布时间拨到 200 天前，模拟长期无人确认
    await prisma.spot.update({
      where: { id: spotId },
      data: { publishedAt: new Date(Date.now() - 200 * 86400000) },
    });

    const result = await staleSweep();
    expect(result.markedStale).toBeGreaterThanOrEqual(1);

    const flagged = await prisma.spot.findUniqueOrThrow({ where: { uuid } });
    expect(flagged.isStale).toBe(true);
    expect(flagged.freshnessScore).toBeLessThan(50);

    const task = await prisma.reviewTask.findFirstOrThrow({
      where: { spotId, kind: "stale_recheck", decidedAt: null },
    });
    expect(task.status).toBe("pending");

    // 再跑一次巡检不应重复投单
    const second = await staleSweep();
    const openCount = await prisma.reviewTask.count({ where: { spotId, kind: "stale_recheck", decidedAt: null } });
    expect(openCount).toBe(1);
    expect(second.markedStale).toBe(0);
  }, 60000);
});

describe("众包自愈", () => {
  it("近期多人准确确认后自动解除 stale 并关闭复核任务", async () => {
    const uuid = await createPublishedSpot(`复活长椅${suffix.slice(-4)}`);
    const spotId = (await prisma.spot.findUniqueOrThrow({ where: { uuid } })).id;

    // 直接构造 stale 状态和一个未决复核任务
    const revision = await prisma.spotRevision.findFirstOrThrow({
      where: { spotId },
      orderBy: { revisionNo: "desc" },
      select: { id: true },
    });
    await prisma.spot.update({ where: { id: spotId }, data: { isStale: true, staleReportCount: 3 } });
    const task = await prisma.reviewTask.create({
      data: {
        spotId,
        revisionId: revision.id,
        kind: "stale_recheck",
        status: "pending",
        slaDueAt: new Date(Date.now() + 48 * 3600000),
      },
    });

    // 两个不同用户确认仍然准确
    const confirm1 = await request(app)
      .post(`/api/v1/spots/${uuid}/confirm`)
      .set("Authorization", `Bearer ${helperTokens[0]}`)
      .send({ isAccurate: true })
      .expect(200);
    // 只有一人确认时还不解除
    expect(confirm1.body.data.isStale).toBe(true);

    const confirm2 = await request(app)
      .post(`/api/v1/spots/${uuid}/confirm`)
      .set("Authorization", `Bearer ${helperTokens[1]}`)
      .send({ isAccurate: true })
      .expect(200);
    expect(confirm2.body.data.revived).toBe(true);
    expect(confirm2.body.data.isStale).toBe(false);

    const restored = await prisma.spot.findUniqueOrThrow({ where: { uuid } });
    expect(restored.isStale).toBe(false);

    const closedTask = await prisma.reviewTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(closedTask.status).toBe("approved");
    expect(closedTask.decidedAt).not.toBeNull();
  }, 60000);
});
