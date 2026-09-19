<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { api, mediaUrl } from "@/api/client";
import type { Spot } from "@/api/types";
import { useAuthStore } from "@/stores/auth";
import { useCatalogStore } from "@/stores/catalog";
import CommentSection from "@/components/CommentSection.vue";
import ReportDialog from "@/components/ReportDialog.vue";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const catalog = useCatalogStore();

const spot = ref<Spot | null>(null);
const loading = ref(true);
const busy = ref(false);
const reportVisible = ref(false);
const previewIndex = ref(0);
const previewVisible = ref(false);

const uuid = computed(() => String(route.params.uuid));

// 把 attributes 里的原始值翻译成人类可读的文案
function describe(key: string, value: unknown): { label: string; text: string } {
  const property = spot.value?.category.schema.properties[key];
  const label = property?.label ?? key;

  if (typeof value === "boolean") return { label, text: value ? "是" : "否" };
  if (typeof value === "number") {
    return { label, text: `${value}${property?.unit ?? ""}` };
  }
  if (Array.isArray(value)) {
    // 数组项用自己的标签映射，没有映射时才回退到原始值
    const text = value
      .map((item) => property?.items?.enumLabels?.[String(item)] ?? String(item))
      .join("、");
    return { label, text };
  }
  if (typeof value === "string" && property?.enumLabels?.[value]) {
    return { label, text: property.enumLabels[value] };
  }
  return { label, text: String(value ?? "") };
}

const attributeRows = computed(() => {
  if (!spot.value) return [];
  const schema = spot.value.category.schema;
  const order = Object.keys(schema.properties);

  return Object.entries(spot.value.attributes)
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .map(([key, value]) => describe(key, value));
});

async function load() {
  loading.value = true;
  try {
    spot.value = await api.get<Spot>(`/spots/${uuid.value}`);
  } catch (error) {
    ElMessage.error((error as Error).message);
    spot.value = null;
  } finally {
    loading.value = false;
  }
}

async function toggleFavorite() {
  if (!auth.isLoggedIn) {
    void router.push({ name: "login", query: { redirect: route.fullPath } });
    return;
  }
  if (!spot.value) return;

  busy.value = true;
  try {
    const next = !spot.value.favorite;
    if (next) {
      await api.post(`/spots/${uuid.value}/favorite`);
    } else {
      await api.del(`/spots/${uuid.value}/favorite`);
    }
    spot.value.favorite = next;
    ElMessage.success(next ? "已收藏" : "已取消收藏");
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    busy.value = false;
  }
}

async function confirmAccuracy(isAccurate: boolean) {
  if (!auth.isLoggedIn) {
    void router.push({ name: "login", query: { redirect: route.fullPath } });
    return;
  }

  busy.value = true;
  try {
    const result = await api.post<{
      confirmCount: number;
      isStale: boolean;
      recovered: boolean;
      addedReviewTask: boolean;
    }>(`/spots/${uuid.value}/confirm`, { isAccurate });

    ElMessage.success(
      isAccurate
        ? result.recovered
          ? "感谢实地复核！多位用户确认后，过期标记已自动解除"
          : "谢谢确认，这条信息会显示得更可信"
        : result.addedReviewTask
          ? "已记录你的反馈，这条信息会重新进入人工复核"
          : "已记录你的反馈",
    );
    await load();
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    busy.value = false;
  }
}

async function deleteSpot() {
  try {
    await ElMessageBox.confirm("删除后这条记录会从地图上移除，确定删除吗？", "删除记录", {
      confirmButtonText: "删除",
      cancelButtonText: "取消",
      type: "warning",
    });
    await api.del(`/spots/${uuid.value}`);
    ElMessage.success("已删除");
    void router.push({ name: "map" });
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(error.message);
  }
}

const isOwner = computed(
  () =>
    Boolean(auth.user?.uuid) &&
    Boolean(spot.value?.author?.uuid) &&
    spot.value?.author?.uuid === auth.user?.uuid,
);
const canAppeal = computed(() => spot.value?.status === "rejected" || spot.value?.status === "hidden");

async function appeal() {
  try {
    const { value } = await ElMessageBox.prompt(
      "请说明为什么你认为这条记录应当被接受（至少 10 个字）",
      "提出申诉",
      { inputValidator: (text) => (text && text.trim().length >= 10 ? true : "请至少写 10 个字") },
    );
    await api.post(`/spots/${uuid.value}/appeal`, { reason: value.trim() });
    ElMessage.success("申诉已提交，管理员会进行终审");
    await load();
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(error.message);
  }
}

onMounted(async () => {
  await catalog.load().catch(() => undefined);
  await load();
});
</script>

<template>
  <div class="page">
    <div v-loading="loading">
      <el-empty v-if="!loading && !spot" description="这条记录不存在，或还没有通过审核" />

      <template v-if="spot">
        <el-alert
          v-if="spot.status !== 'published'"
          type="warning"
          :closable="false"
          show-icon
          :title="`当前状态：${spot.status}`"
          description="只有你本人和审核员能看到这条尚未发布的内容。"
          style="margin-bottom: 16px"
        />

        <article class="card">
          <div class="detail-head">
            <div>
              <span class="category-chip" :style="{ background: spot.category.color }">
                {{ spot.category.name }}
              </span>
              <h1 class="detail-title">{{ spot.title }}</h1>
              <p class="muted" style="margin: 0">
                {{ spot.location.addressText || "地址未解析" }}
                <span v-if="spot.location.fuzzed"> · 位置已模糊（约 {{ spot.location.radiusMeters }} 米范围内）</span>
                <span v-else> · 精确位置</span>
              </p>
            </div>

            <div class="detail-actions">
              <el-button :loading="busy" @click="toggleFavorite">
                <el-icon style="margin-right: 4px">
                  <component :is="spot.favorite ? 'StarFilled' : 'Star'" />
                </el-icon>
                {{ spot.favorite ? "已收藏" : "收藏" }}
              </el-button>
              <el-button v-if="isOwner" @click="router.push({ name: 'spot-edit', params: { uuid } })">编辑</el-button>
              <el-button v-if="isOwner" type="danger" plain @click="deleteSpot">删除</el-button>
              <el-button v-if="auth.isLoggedIn && !isOwner" @click="reportVisible = true">举报</el-button>
            </div>
          </div>

          <p v-if="spot.description" class="detail-description">{{ spot.description }}</p>

          <div class="detail-meta">
            <span class="badge badge--ok">{{ spot.freshness.confirmCount }} 人确认仍然准确</span>
            <span class="badge">新鲜度 {{ spot.freshness.score }}</span>
            <span v-if="spot.freshness.isStale" class="badge badge--warn">信息可能已过期 · 待人工复查</span>
            <span v-if="spot.freshness.staleReportCount > 0" class="badge">
              {{ spot.freshness.staleReportCount }} 人反馈已过期
            </span>
            <span class="badge">{{ spot.stats.commentCount }} 条评论</span>
            <span class="badge">{{ spot.stats.favoriteCount }} 人收藏</span>
          </div>
        </article>

        <section v-if="attributeRows.length" class="card">
          <h3 style="margin: 0 0 12px; font-size: 16px">现场细节</h3>
          <dl class="detail-attributes">
            <template v-for="row in attributeRows" :key="row.label">
              <dt>{{ row.label }}</dt>
              <dd>{{ row.text }}</dd>
            </template>
          </dl>
        </section>

        <section v-if="spot.media.length" class="card">
          <h3 style="margin: 0 0 12px; font-size: 16px">现场照片</h3>
          <div class="photo-grid">
            <div
              v-for="(asset, index) in spot.media"
              :key="asset.uuid"
              class="photo-thumb"
              style="cursor: zoom-in"
              @click="((previewIndex = index), (previewVisible = true))"
            >
              <img :src="mediaUrl(asset.variants.grid)" :alt="`${spot.title} 的照片`" loading="lazy" />
            </div>
          </div>
          <p class="muted" style="margin: 8px 0 0">
            照片已清除拍摄位置等元数据，人脸与车牌区域已由审核员确认后打码。
          </p>
        </section>

        <section class="card">
          <h3 style="margin: 0 0 12px; font-size: 16px">这里现在还是这样吗？</h3>
          <div style="display: flex; gap: 10px; flex-wrap: wrap">
            <el-button type="primary" plain :loading="busy" @click="confirmAccuracy(true)">
              我确认信息仍然准确
            </el-button>
            <el-button :loading="busy" @click="confirmAccuracy(false)">情况已经变了</el-button>
          </div>
          <p class="muted" style="margin: 8px 0 0">
            同一个人 30 天内只能确认一次。多人反馈过期会自动回到人工复核队列；
            长期无人确认的条目会被时间衰减降权；近期有足够多人实地确认，过期标记也会自动解除。
          </p>
        </section>

        <section v-if="canAppeal" class="card">
          <h3 style="margin: 0 0 8px; font-size: 16px">这条记录被驳回了</h3>
          <p class="muted">如果你认为判断有误，可以在驳回后 7 天内提出申诉，由管理员终审。</p>
          <el-button type="warning" plain @click="appeal">提出申诉</el-button>
        </section>

        <section class="card">
          <CommentSection :spot-uuid="uuid" />
        </section>
      </template>
    </div>

    <ReportDialog v-model:visible="reportVisible" target-type="spot" :target-id="uuid" />

    <el-image-viewer
      v-if="previewVisible && spot"
      :url-list="spot.media.map((asset) => mediaUrl(asset.variants.full))"
      :initial-index="previewIndex"
      @close="previewVisible = false"
    />
  </div>
</template>

<style scoped>
.detail-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.detail-title {
  margin: 10px 0 6px;
  font-size: 22px;
}

.detail-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: flex-start;
}

.detail-description {
  margin: 16px 0 0;
  line-height: 1.7;
  white-space: pre-wrap;
}

.detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}

.detail-attributes {
  display: grid;
  grid-template-columns: 160px 1fr;
  gap: 10px 16px;
  margin: 0;
}

.detail-attributes dt {
  color: var(--color-text-soft);
  font-size: 14px;
}

.detail-attributes dd {
  margin: 0;
  font-size: 14px;
}

@media (max-width: 640px) {
  .detail-attributes {
    grid-template-columns: 1fr;
    gap: 2px 0;
  }

  .detail-attributes dd {
    margin-bottom: 8px;
  }
}
</style>
