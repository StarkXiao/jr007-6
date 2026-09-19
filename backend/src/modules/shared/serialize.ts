import type { SpotStatus, PrivacyStatus } from "@prisma/client";
import type { ImageVariant } from "../../config/constants";

export const IMAGE_VARIANT_NAMES: ImageVariant[] = ["thumb", "grid", "full"];

export interface MediaLike {
  uuid: string;
  width: number;
  height: number;
  privacyStatus: PrivacyStatus;
  variantVersion: number;
}

export type MediaVariantUrls = Record<ImageVariant, string>;

/**
 * 变体地址带 ?v=版本号。
 * 隐私修复后版本号自增，可立即击穿浏览器与 CDN 缓存——
 * 这一点很关键：已下架的敏感图片不能因为缓存继续被看到。
 */
export function mediaVariantUrls(asset: Pick<MediaLike, "uuid" | "variantVersion">): MediaVariantUrls {
  const build = (variant: ImageVariant) => `/api/v1/media/${asset.uuid}/${variant}?v=${asset.variantVersion}`;
  return {
    thumb: build("thumb"),
    grid: build("grid"),
    full: build("full"),
  };
}

export function serializeMedia(asset: MediaLike) {
  return {
    uuid: asset.uuid,
    width: asset.width,
    height: asset.height,
    privacyStatus: asset.privacyStatus,
    variantVersion: asset.variantVersion,
    variants: mediaVariantUrls(asset),
  };
}

export interface CategoryLike {
  code: string;
  name: string;
  icon: string;
  color: string;
  description?: string | null;
}

export function serializeCategory(category: CategoryLike) {
  return {
    code: category.code,
    name: category.name,
    icon: category.icon,
    color: category.color,
    description: category.description ?? null,
  };
}

export interface SpotLike {
  uuid: string;
  title: string;
  description: string | null;
  status: SpotStatus;
  attributes: unknown;
  exactLat: number;
  exactLng: number;
  publicLat: number | null;
  publicLng: number | null;
  fuzzEnabled: boolean;
  fuzzRadiusM: number;
  addressText: string | null;
  freshnessScore: number;
  confirmCount: number;
  staleReportCount: number;
  isStale: boolean;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  category: CategoryLike;
  // 昵称不唯一，判断"是不是我提交的"必须靠 uuid
  owner?: { uuid?: string; nickname: string } | null;
  media?: MediaLike[];
  lastConfirmedAt?: Date | null;
  counts?: { comments?: number; favorites?: number };
}

export interface SpotSerializeOptions {
  /** 作者本人或审核角色才能拿到精确坐标 */
  includeExact?: boolean;
  favorite?: boolean;
  distanceMeters?: number;
}

export function serializeSpot(spot: SpotLike, options: SpotSerializeOptions = {}) {
  const lat = options.includeExact ? spot.exactLat : (spot.publicLat ?? spot.exactLat);
  const lng = options.includeExact ? spot.exactLng : (spot.publicLng ?? spot.exactLng);

  const payload: Record<string, unknown> = {
    uuid: spot.uuid,
    title: spot.title,
    description: spot.description,
    status: spot.status,
    category: serializeCategory(spot.category),
    attributes: spot.attributes ?? {},
    location: {
      lat,
      lng,
      fuzzed: !options.includeExact && spot.fuzzEnabled && spot.fuzzRadiusM > 0,
      radiusMeters: spot.fuzzRadiusM,
      addressText: spot.addressText,
      precise: Boolean(options.includeExact),
    },
    media: (spot.media ?? []).map(serializeMedia),
    freshness: {
      score: spot.freshnessScore,
      confirmCount: spot.confirmCount,
      staleReportCount: spot.staleReportCount,
      isStale: spot.isStale,
      lastConfirmedAt: spot.lastConfirmedAt ?? null,
    },
    stats: {
      commentCount: spot.counts?.comments ?? 0,
      favoriteCount: spot.counts?.favorites ?? 0,
    },
    author: spot.owner ? { uuid: spot.owner.uuid ?? null, nickname: spot.owner.nickname } : null,
    publishedAt: spot.publishedAt,
    createdAt: spot.createdAt,
    updatedAt: spot.updatedAt,
  };

  if (options.favorite !== undefined) payload.favorite = options.favorite;
  if (options.distanceMeters !== undefined) {
    payload.distanceMeters = Math.round(options.distanceMeters);
  }

  return payload;
}

export interface CommentLike {
  id: bigint;
  body: string;
  status: string;
  edited: boolean;
  createdAt: Date;
  updatedAt: Date;
  parentId: bigint | null;
  user: { uuid: string; nickname: string } | null;
}

export function serializeComment(comment: CommentLike) {
  return {
    id: comment.id,
    body: comment.body,
    status: comment.status,
    edited: comment.edited,
    parentId: comment.parentId,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    // 注销用户统一显示为匿名，避免通过昵称反查身份
    author: comment.user ? { uuid: comment.user.uuid, nickname: comment.user.nickname } : null,
  };
}

export function serializeNotification(notification: {
  id: bigint;
  type: string;
  title: string;
  body: string | null;
  payload: unknown;
  readAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    payload: notification.payload ?? {},
    read: notification.readAt !== null,
    createdAt: notification.createdAt,
  };
}
