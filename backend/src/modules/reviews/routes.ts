import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler";
import { ok } from "../../utils/serialize";
import { validate } from "../../middleware/validate";
import { requireAuth } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";
import { rateLimit } from "../../middleware/rateLimit";
import { bigintParam } from "../../utils/params";
import {
  approveTask,
  claimTask,
  decideAppeal,
  getTaskDetail,
  listAppeals,
  listQueue,
  moderationStats,
  rejectTask,
  releaseTask,
  requestChanges,
} from "./service";

export const moderationRouter = Router();

const taskIdParam = z.object({ id: z.coerce.bigint() });

const queueQuery = z.object({
  status: z
    .enum(["pending", "in_review", "approved", "changes_requested", "rejected", "auto_rejected", "appealed", "appeal_approved", "appeal_rejected"])
    .optional(),
  kind: z.enum(["submission", "stale_recheck"]).optional(),
  categoryCode: z.string().max(32).optional(),
  hasMedia: z.coerce.boolean().optional(),
  overdueOnly: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const reasonCodeEnum = z.enum([
  "INSUFFICIENT_DETAIL",
  "LOCATION_WRONG",
  "DUPLICATE",
  "PRIVACY_RISK",
  "ADVERTISING",
  "OFF_TOPIC",
  "INAPPROPRIATE",
  "PHOTO_QUALITY",
]);

moderationRouter.get(
  "/moderation/queue",
  requireAuth,
  requireRole("moderator"),
  validate({ query: queueQuery }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await listQueue(req.query as never)));
  }),
);

moderationRouter.get(
  "/moderation/stats",
  requireAuth,
  requireRole("moderator"),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await moderationStats()));
  }),
);

moderationRouter.post(
  "/moderation/tasks/:id/claim",
  requireAuth,
  requireRole("moderator"),
  validate({ params: taskIdParam }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await claimTask(bigintParam(req, "id"), req.user!)));
  }),
);

moderationRouter.post(
  "/moderation/tasks/:id/release",
  requireAuth,
  requireRole("moderator"),
  validate({ params: taskIdParam }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await releaseTask(bigintParam(req, "id"), req.user!)));
  }),
);

moderationRouter.get(
  "/moderation/tasks/:id",
  requireAuth,
  requireRole("moderator"),
  validate({ params: taskIdParam }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await getTaskDetail(bigintParam(req, "id"), req.user!)));
  }),
);

moderationRouter.post(
  "/moderation/tasks/:id/approve",
  requireAuth,
  requireRole("moderator"),
  rateLimit({ scope: "review-decide", limit: 300, windowSeconds: 3600 }),
  validate({
    params: taskIdParam,
    body: z.object({
      reason: z.string().max(300).optional(),
      overridePrivacy: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await approveTask(bigintParam(req, "id"), req.user!, req.body)));
  }),
);

moderationRouter.post(
  "/moderation/tasks/:id/request-changes",
  requireAuth,
  requireRole("moderator"),
  rateLimit({ scope: "review-decide", limit: 300, windowSeconds: 3600 }),
  validate({
    params: taskIdParam,
    body: z.object({
      reasonCode: reasonCodeEnum,
      reason: z.string().max(300).optional(),
      points: z.array(z.string().max(120)).max(10).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await requestChanges(bigintParam(req, "id"), req.user!, req.body)));
  }),
);

moderationRouter.post(
  "/moderation/tasks/:id/reject",
  requireAuth,
  requireRole("moderator"),
  rateLimit({ scope: "review-decide", limit: 300, windowSeconds: 3600 }),
  validate({
    params: taskIdParam,
    body: z.object({
      reasonCode: reasonCodeEnum,
      reason: z.string().max(300).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await rejectTask(bigintParam(req, "id"), req.user!, req.body)));
  }),
);

moderationRouter.get(
  "/moderation/appeals",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    res.json(ok(req, { items: await listAppeals() }));
  }),
);

moderationRouter.post(
  "/moderation/appeals/:id/decide",
  requireAuth,
  requireRole("admin"),
  validate({
    params: taskIdParam,
    body: z.object({
      decision: z.enum(["approve", "uphold"]),
      reason: z.string().trim().min(5, "请填写终审理由").max(300),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await decideAppeal(bigintParam(req, "id"), req.user!, req.body.decision, req.body.reason);
    res.json(ok(req, result));
  }),
);
