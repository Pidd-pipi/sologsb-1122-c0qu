<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox, type UploadFile } from 'element-plus';
import { useMergeStore } from '../stores/mergeStore';
import { useFaceStore } from '../stores/faceStore';
import { useJointStore } from '../stores/jointStore';
import { useGradeStore } from '../stores/gradeStore';
import {
  packageToJson,
  parsePackageJson,
  readBaseSnapshot,
} from '../utils/merge';
import { db, ensureSeedData } from '../utils/db';
import type { WorkPackage } from '../types/package';

const mergeStore = useMergeStore();
const faceStore = useFaceStore();
const jointStore = useJointStore();
const gradeStore = useGradeStore();

const activeTab = ref('export');

// ---- 导出 ----
const exportGeologist = ref('');
const exportNote = ref('');
const exporting = ref(false);
const builtPackage = ref<WorkPackage | null>(null);

const baseSnapshotCount = computed(() => Object.keys(readBaseSnapshot()).length);

async function doExport() {
  exporting.value = true;
  try {
    const pkg = await mergeStore.buildPackage(exportGeologist.value, exportNote.value);
    builtPackage.value = pkg;
    if (pkg.ops.length === 0) {
      ElMessage.warning('当前没有相对基准快照的变更，作业包为空');
    } else {
      ElMessage.success(`已生成作业包 ${pkg.packageNo}，含 ${pkg.ops.length} 项操作`);
    }
  } catch (e) {
    ElMessage.error(`生成作业包失败：${(e as Error).message}`);
  } finally {
    exporting.value = false;
  }
}

function downloadPackage() {
  if (!builtPackage.value) return;
  const json = packageToJson(builtPackage.value);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${builtPackage.value.packageNo}.json`;
  a.click();
  URL.revokeObjectURL(url);
  ElMessage.success('作业包 JSON 已下载');
}

// ---- 导入 ----
const importText = ref('');
const importing = ref(false);
const mergeError = ref('');

async function parseAndPreview() {
  mergeError.value = '';
  if (!importText.value.trim()) {
    mergeError.value = '请粘贴作业包 JSON 或选择文件';
    return;
  }
  try {
    const pkg = parsePackageJson(importText.value);
    await mergeStore.runPreview(pkg);
    if (mergeStore.preview?.status === 'duplicate') {
      ElMessage.info('该作业包已导入过，未重复计数');
    } else if (mergeStore.preview?.status === 'stale') {
      ElMessage.warning('作业包存在过期掌子面，已拒绝合并，请确认受影响内容');
    } else if (mergeStore.preview?.status === 'conflicts') {
      ElMessage.warning('检测到冲突，请逐项选择保留方式');
    } else {
      ElMessage.success('预览完成：可直接合并');
    }
  } catch (e) {
    mergeError.value = `解析失败：${(e as Error).message}`;
  }
}

async function onFileChange(file: UploadFile) {
  if (!file.raw) return;
  const text = await file.raw.text();
  importText.value = text;
}

async function doMerge() {
  if (!mergeStore.pkg || !mergeStore.preview) return;
  importing.value = true;
  mergeError.value = '';
  try {
    const result = await mergeStore.apply();
    ElMessage.success(`合并完成，并入 ${result.applied.length} 项变更`);
    // 重新加载所有 store，保证台账/详情/涌水趋势/围岩级别读到同一份合并结果
    await Promise.all([faceStore.load(), jointStore.load(), gradeStore.load()]);
    mergeStore.resetPreview();
    importText.value = '';
  } catch (e) {
    mergeError.value = `合并失败，本机原记录已保留，可重试：${(e as Error).message}`;
    ElMessage.error('合并失败，已回滚，可重试');
  } finally {
    importing.value = false;
  }
}

function retryPreview() {
  if (mergeStore.pkg) void mergeStore.runPreview(mergeStore.pkg);
}

function displayVal(value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// ---- 重置演示数据（模拟全新设备） ----
async function resetDemo() {
  try {
    await ElMessageBox.confirm(
      '将清空本机全部掌子面/节理/级别/涌水记录与导入历史，并恢复为初始示范数据。可用于模拟另一台全新设备。是否继续？',
      '重置演示数据',
      { type: 'warning', confirmButtonText: '确认重置', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  await db.transaction('rw', db.faces, db.joints, db.grades, db.waters, db.imports, async () => {
    await Promise.all([
      db.faces.clear(),
      db.joints.clear(),
      db.grades.clear(),
      db.waters.clear(),
      db.imports.clear(),
    ]);
  });
  localStorage.removeItem('gbtunnelface:base-snapshot');
  // 重新灌入示范数据
  await ensureSeedData();
  await Promise.all([faceStore.load(), jointStore.load(), gradeStore.load()]);
  await mergeStore.captureBase();
  await mergeStore.loadImports();
  mergeStore.resetPreview();
  importText.value = '';
  ElMessage.success('已重置为初始示范数据，并采集基准快照');
}

onMounted(async () => {
  await mergeStore.loadImports();
  // 首次进入采集基准快照
  if (baseSnapshotCount.value === 0) {
    await mergeStore.captureBase();
  }
});
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>离线作业包合并</h2>
      <el-tag type="info" effect="plain">基准快照 {{ baseSnapshotCount }} 条</el-tag>
      <el-tag type="info" effect="plain">已导入 {{ mergeStore.imports.length }} 个包</el-tag>
      <div class="spacer" />
      <el-button @click="resetDemo">重置演示数据</el-button>
    </div>

    <el-alert
      type="info"
      :closable="false"
      title="两名地质员断网编录同一掌子面：各自导出作业包（含掌子面版本与操作顺序），回来后离线合并。不同对象直接并入；同一掌子面关键字段或同一节理组两边改过时列冲突让人选择；版本过期拒绝合并并指出受影响内容。"
      style="margin-bottom: 4px"
    />

    <el-tabs v-model="activeTab">
      <!-- ============ 导出 ============ -->
      <el-tab-pane label="导出作业包" name="export">
        <el-card shadow="never">
          <template #header><strong>生成离线作业包</strong></template>
          <el-alert
            type="info"
            :closable="false"
            title="作业包只包含相对基准快照的变更（新增/修改/删除），并携带各掌子面版本与操作顺序。导出后请妥善保存 JSON 文件。"
            style="margin-bottom: 12px"
          />
          <el-form label-width="100px" style="max-width: 520px">
            <el-form-item label="编录人">
              <el-input v-model="exportGeologist" placeholder="如 岑柏川" />
            </el-form-item>
            <el-form-item label="备注">
              <el-input v-model="exportNote" type="textarea" :rows="2" placeholder="可选" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :loading="exporting" @click="doExport">生成作业包</el-button>
              <el-button v-if="builtPackage" type="success" @click="downloadPackage">下载 JSON</el-button>
            </el-form-item>
          </el-form>

          <div v-if="builtPackage" class="pkg-summary">
            <el-descriptions :column="3" border size="small">
              <el-descriptions-item label="作业包编号">{{ builtPackage.packageNo }}</el-descriptions-item>
              <el-descriptions-item label="编录人">{{ builtPackage.geologist }}</el-descriptions-item>
              <el-descriptions-item label="操作数">{{ builtPackage.ops.length }} 项</el-descriptions-item>
            </el-descriptions>
            <el-table :data="builtPackage.ops" size="small" border style="margin-top: 10px">
              <el-table-column label="顺序" width="70">
                <template #default="{ row }">{{ row.seq }}</template>
              </el-table-column>
              <el-table-column label="类型" width="90">
                <template #default="{ row }">
                  <el-tag :type="row.kind === 'delete' ? 'danger' : 'success'" size="small">
                    {{ row.kind === 'delete' ? '删除' : '写入' }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="表" width="100">
                <template #default="{ row }">{{ row.table }}</template>
              </el-table-column>
              <el-table-column label="对象">
                <template #default="{ row }">
                  {{ row.record ? (row.record.faceNo ?? row.record.setNo ?? row.record.position ?? row.id) : row.id }}
                </template>
              </el-table-column>
            </el-table>
          </div>
        </el-card>
      </el-tab-pane>

      <!-- ============ 导入 ============ -->
      <el-tab-pane label="导入合并" name="import">
        <el-card shadow="never">
          <template #header><strong>导入作业包并离线合并</strong></template>
          <el-form label-width="100px">
            <el-form-item label="作业包 JSON">
              <div style="width: 100%">
                <el-upload
                  :auto-upload="false"
                  :show-file-list="false"
                  :on-change="onFileChange"
                  accept=".json,application/json"
                >
                  <el-button>选择 JSON 文件</el-button>
                </el-upload>
                <el-input
                  v-model="importText"
                  type="textarea"
                  :rows="6"
                  placeholder="或在此粘贴作业包 JSON 文本"
                  style="margin-top: 8px"
                />
              </div>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="parseAndPreview">解析并预览</el-button>
              <el-button v-if="mergeStore.preview" @click="retryPreview">重新预览</el-button>
            </el-form-item>
          </el-form>
          <el-alert v-if="mergeError" :title="mergeError" type="error" :closable="false" style="margin-top: 8px" />
        </el-card>

        <!-- 预览结果 -->
        <div v-if="mergeStore.preview" class="preview">
          <!-- 重复导入 -->
          <el-alert
            v-if="mergeStore.preview.status === 'duplicate' && mergeStore.preview.duplicate"
            type="warning"
            :closable="false"
            show-icon
            title="该作业包已导入过，未重复计数"
            :description="`${mergeStore.preview.duplicate.packageNo}（${mergeStore.preview.duplicate.geologist}）已于 ${new Date(mergeStore.preview.duplicate.importedAt).toLocaleString('zh-CN')} 导入，本次不重复并入。`"
          />

          <!-- 版本过期拒绝 -->
          <el-alert
            v-if="mergeStore.preview.staleFaces.length > 0"
            type="error"
            :closable="false"
            show-icon
            title="作业包版本过期，本次拒绝合并"
            description="以下掌子面在本机已被修改（本地版本高于作业包基于的版本），直接并入会覆盖本机关键字段。请确认受影响内容后，在下方按冲突选择保留方式再重试。"
          >
            <div v-for="sf in mergeStore.preview.staleFaces" :key="sf.faceId" class="stale-block">
              <div class="stale-head">
                <strong>{{ sf.faceNo }}</strong>
                <el-tag size="small" type="info">作业包基于 v{{ sf.baseVersion }}</el-tag>
                <el-tag size="small" type="danger">本机当前 v{{ sf.localVersion }}</el-tag>
              </div>
              <el-table :data="sf.affected" size="small" border>
                <el-table-column label="受影响表" width="110">
                  <template #default="{ row }">{{ row.table }}</template>
                </el-table-column>
                <el-table-column label="受影响内容">
                  <template #default="{ row }">{{ row.label }}</template>
                </el-table-column>
                <el-table-column label="原因" min-width="200">
                  <template #default="{ row }">{{ row.reason }}</template>
                </el-table-column>
              </el-table>
            </div>
          </el-alert>

          <!-- 可直接并入 -->
          <el-card v-if="mergeStore.preview.autoApplied.length > 0" shadow="never">
            <template #header>
              <strong>可直接并入（{{ mergeStore.preview.autoApplied.length }} 项）</strong>
            </template>
            <el-table :data="mergeStore.preview.autoApplied" size="small" border max-height="260">
              <el-table-column label="表" width="100">
                <template #default="{ row }">{{ row.table }}</template>
              </el-table-column>
              <el-table-column label="内容">
                <template #default="{ row }">{{ row.label }}</template>
              </el-table-column>
              <el-table-column label="操作" width="90">
                <template #default="{ row }">
                  <el-tag size="small" :type="row.action === 'created' ? 'success' : row.action === 'deleted' ? 'danger' : 'info'">
                    {{ row.action === 'created' ? '新增' : row.action === 'deleted' ? '删除' : '更新' }}
                  </el-tag>
                </template>
              </el-table-column>
            </el-table>
          </el-card>

          <!-- 冲突选择 -->
          <el-card v-if="mergeStore.preview.conflicts.length > 0" shadow="never">
            <template #header>
              <div class="conflict-head">
                <strong>冲突待选择（{{ mergeStore.preview.conflicts.length }} 项）</strong>
                <div class="spacer" />
                <el-button size="small" @click="mergeStore.resolveAllLocal()">全部保留本机</el-button>
                <el-button size="small" @click="mergeStore.resolveAllIncoming()">全部采用作业包</el-button>
              </div>
            </template>
            <div v-for="c in mergeStore.preview.conflicts" :key="c.key" class="conflict-block">
              <div class="conflict-title">
                <el-tag size="small" type="warning">{{ c.table }}</el-tag>
                <strong>{{ c.objectLabel }}</strong>
                <el-radio-group
                  :model-value="mergeStore.resolutions[c.key]"
                  size="small"
                  @update:model-value="(v: string) => mergeStore.setResolution(c.key, v as 'local' | 'incoming')"
                >
                  <el-radio-button value="local">保留本机</el-radio-button>
                  <el-radio-button value="incoming">采用作业包</el-radio-button>
                </el-radio-group>
              </div>
              <el-table :data="c.fields" size="small" border>
                <el-table-column label="字段" width="130">
                  <template #default="{ row }">{{ row.label }}</template>
                </el-table-column>
                <el-table-column label="基准" min-width="140">
                  <template #default="{ row }">
                    <span class="muted">{{ displayVal(row.base) }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="本机" min-width="140">
                  <template #default="{ row }">
                    <span :class="{ 'val-local': mergeStore.resolutions[c.key] === 'local' }">{{ displayVal(row.local) }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="作业包" min-width="140">
                  <template #default="{ row }">
                    <span :class="{ 'val-incoming': mergeStore.resolutions[c.key] === 'incoming' }">{{ displayVal(row.incoming) }}</span>
                  </template>
                </el-table-column>
              </el-table>
            </div>
          </el-card>

          <!-- 操作栏 -->
          <div class="merge-bar">
            <el-alert
              v-if="!mergeStore.canMerge && mergeStore.preview.status !== 'duplicate'"
              type="warning"
              :closable="false"
              title="请先逐项选择冲突保留方式，再确认合并"
            />
            <div class="spacer" />
            <el-button @click="mergeStore.resetPreview()">取消</el-button>
            <el-button
              type="primary"
              :loading="importing"
              :disabled="!mergeStore.canMerge"
              @click="doMerge"
            >
              确认合并
            </el-button>
          </div>
        </div>
      </el-tab-pane>

      <!-- ============ 历史 ============ -->
      <el-tab-pane label="导入历史" name="history">
        <el-card shadow="never">
          <template #header><strong>已导入作业包（幂等台账）</strong></template>
          <el-table :data="mergeStore.imports" size="small" border>
            <el-table-column label="作业包编号" prop="packageNo" min-width="180" />
            <el-table-column label="编录人" prop="geologist" width="120" />
            <el-table-column label="并入项数" prop="appliedCount" width="100" />
            <el-table-column label="导入时间" width="180">
              <template #default="{ row }">{{ new Date(row.importedAt).toLocaleString('zh-CN') }}</template>
            </el-table-column>
            <el-table-column label="内容哈希" min-width="120">
              <template #default="{ row }">
                <span class="muted">{{ row.contentHash.slice(0, 12) }}…</span>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="mergeStore.imports.length === 0" description="暂无导入记录" :image-size="60" />
        </el-card>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>


<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.header h2 {
  margin: 0;
}
.spacer {
  flex: 1;
}
.pkg-summary {
  margin-top: 14px;
}
.preview {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 14px;
}
.stale-block {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.stale-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.conflict-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.conflict-block {
  border: 1px solid #e4e7ec;
  border-radius: 6px;
  padding: 10px;
  margin-bottom: 10px;
}
.conflict-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.merge-bar {
  display: flex;
  align-items: center;
  gap: 10px;
}
.muted {
  color: #97a0ad;
  font-size: 12px;
}
.val-local {
  color: #1f4f8a;
  font-weight: 600;
}
.val-incoming {
  color: #2f8f5b;
  font-weight: 600;
}
</style>
