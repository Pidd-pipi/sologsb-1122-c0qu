<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { UploadRawFile } from 'element-plus';
import {
  buildWorkPackage,
  downloadWorkPackage,
  parseWorkPackage,
  loadSnapshot,
  applyMergePlan,
  listAppliedPackages,
  getSyncState,
  saveSyncState,
} from '../utils/syncRepo';
import { buildMergePlan, resolveConflicts, shortDevice, vvText, type ConflictDecision } from '../utils/merge';
import type { AppliedPackage, MergePlan, WorkPackage } from '../types/sync';
import { getLocalGeologist, setLocalGeologist } from '../utils/db';
import { useFaceStore } from '../stores/faceStore';
import { useJointStore } from '../stores/jointStore';
import { useGradeStore } from '../stores/gradeStore';

const faceStore = useFaceStore();
const jointStore = useJointStore();
const gradeStore = useGradeStore();

const deviceId = ref('');
const geologist = ref('');
const exporting = ref(false);

const pkg = ref<WorkPackage | null>(null);
const plan = ref<MergePlan | null>(null);
const decisions = reactive(new Map<string, ConflictDecision>());
const applying = ref(false);
const applyError = ref('');
const lastReport = ref<{ creates: number; updates: number; deletes: number; skips: number; labels: string[] } | null>(null);

const applied = ref<AppliedPackage[]>([]);
const localOpCount = ref(0);

const conflictEntries = computed(() => (plan.value?.entries ?? []).filter((e) => e.conflict));
const autoEntries = computed(() => (plan.value?.entries ?? []).filter((e) => !e.conflict && e.action !== 'skip'));
const skipEntries = computed(() => (plan.value?.entries ?? []).filter((e) => !e.conflict && e.action === 'skip'));
const unresolvedCount = computed(
  () =>
    plan.value?.conflicts.filter((c) =>
      c.kind === 'field' ? c.fields.some((f) => !f.choice) : !c.choice,
    ).length ?? 0,
);

onMounted(async () => {
  const state = await getSyncState();
  deviceId.value = state.deviceId;
  geologist.value = state.geologist || getLocalGeologist();
  localOpCount.value = state.seq;
  applied.value = await listAppliedPackages();
});

async function saveName() {
  const name = geologist.value.trim();
  setLocalGeologist(name);
  const state = await getSyncState();
  state.geologist = name;
  await saveSyncState(state);
  ElMessage.success(name ? `已记录本机地质员：${name}` : '已清空地质员署名');
}

async function exportPack() {
  exporting.value = true;
  try {
    await saveName();
    const { pkg: built, filename } = await buildWorkPackage();
    if (built.ops.length === 0) {
      ElMessage.warning('本机还没有任何编录操作，作业包为空');
      return;
    }
    downloadWorkPackage(built, filename);
    const state = await getSyncState();
    state.lastExportSeq = state.seq;
    await saveSyncState(state);
    ElMessage.success(`已导出作业包：${built.ops.length} 条操作，覆盖 ${built.faces.length} 个掌子面`);
  } finally {
    exporting.value = false;
  }
}

async function onFile(file: UploadRawFile): Promise<void> {
  applyError.value = '';
  lastReport.value = null;
  decisions.clear();
  try {
    const text = await file.text();
    const parsed = parseWorkPackage(text);
    pkg.value = parsed;
    const snap = await loadSnapshot();
    const result = buildMergePlan(parsed, snap);
    plan.value = result;
    seedDefaults(result);
  } catch (e) {
    plan.value = null;
    pkg.value = null;
    ElMessage.error(e instanceof Error ? e.message : '读取作业包失败');
  }
}

/** 非关键字段冲突默认取本机（仍展示、可改）；关键字段必须人工选择 */
function seedDefaults(result: MergePlan) {
  if (result.status !== 'conflicts') return;
  for (const c of result.conflicts) {
    if (c.kind !== 'field') continue;
    const fields: Record<string, 'local' | 'remote'> = {};
    for (const f of c.fields) {
      if (!f.key) fields[f.field] = 'local';
    }
    decisions.set(`${c.table}:${c.targetId}`, { fields });
  }
  plan.value = resolveConflicts(result, decisions, deviceId.value);
}

function chooseField(entryKey: string, field: string, choice: 'local' | 'remote') {
  const d = decisions.get(entryKey) ?? { fields: {} };
  d.fields = { ...(d.fields ?? {}), [field]: choice };
  decisions.set(entryKey, d);
  recompute();
}

function chooseRecord(entryKey: string, choice: 'local' | 'remote') {
  decisions.set(entryKey, { recordChoice: choice, fields: decisions.get(entryKey)?.fields });
  recompute();
}

function recompute() {
  if (!plan.value || !pkg.value) return;
  plan.value = resolveConflicts(plan.value, decisions, deviceId.value);
}

async function confirmMerge() {
  if (!plan.value) return;
  applying.value = true;
  applyError.value = '';
  try {
    // 提交前再定稿一次（保证默认选择全部生效）
    recompute();
    const report = await applyMergePlan(plan.value);
    lastReport.value = report;
    ElMessage.success(`合并完成：新增 ${report.creates}、更新 ${report.updates}、删除 ${report.deletes}`);
    plan.value = null;
    pkg.value = null;
    decisions.clear();
    // 所有页面读同一份合并结果：统一重读各 Store
    await Promise.all([faceStore.load(), jointStore.load(), gradeStore.load()]);
    applied.value = await listAppliedPackages();
    const state = await getSyncState();
    localOpCount.value = state.seq;
  } catch (e) {
    // 事务已回滚：本机原记录保留，计划保留可直接重试
    applyError.value = e instanceof Error ? e.message : '合并失败';
    ElMessage.error(`合并失败，本机原记录未改动，可修正后重试：${applyError.value}`);
  } finally {
    applying.value = false;
  }
}

function resetDialog() {
  plan.value = null;
  pkg.value = null;
  applyError.value = '';
  decisions.clear();
}

const actionTag: Record<string, { type: 'success' | 'primary' | 'warning' | 'info' | 'danger'; text: string }> = {
  create: { type: 'success', text: '并入新增' },
  replace: { type: 'primary', text: '整体更新' },
  patch: { type: 'primary', text: '合并更新' },
  delete: { type: 'danger', text: '删除' },
  skip: { type: 'info', text: '跳过' },
};

const tableName: Record<string, string> = {
  faces: '掌子面',
  joints: '节理组',
  grades: '级别判定',
  waters: '涌水记录',
  sketches: '素描',
};
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>作业包与离线合并</h2>
      <el-tag type="info" effect="plain">本机设备 {{ shortDevice(deviceId) }}</el-tag>
      <el-tag type="info" effect="plain">本机已产生 {{ localOpCount }} 条有序操作</el-tag>
    </div>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="断网协作流程：各自编录 → 导出作业包（带掌子面版本与操作顺序）→ 互相导入合并"
      description="不同对象直接并入；同一掌子面关键字段或同一节理组两边都改过会先列出冲突由你选择；作业包版本过期将拒绝合并并指出受影响内容；重复导入不重复计数。"
      style="margin-bottom: 14px"
    />

    <div class="grid">
      <el-card shadow="never">
        <template #header><strong>① 本机署名</strong></template>
        <el-form label-width="92px">
          <el-form-item label="地质员姓名">
            <el-input v-model="geologist" placeholder="如 岑柏川" style="width: 200px" @change="saveName" />
          </el-form-item>
          <el-form-item label="设备标识">
            <span class="mono">{{ deviceId }}</span>
          </el-form-item>
        </el-form>
      </el-card>

      <el-card shadow="never">
        <template #header><strong>② 导出作业包（断网编录后）</strong></template>
        <p class="muted">作业包包含本机全部操作流水（按序）、每个掌子面的聚合版本与数据库结构版本。用 U 盘 / 聊天工具发给同伴即可。</p>
        <el-button type="primary" :loading="exporting" @click="exportPack">导出我的作业包 (.json)</el-button>
      </el-card>

      <el-card shadow="never">
        <template #header><strong>③ 导入同伴作业包并合并</strong></template>
        <el-upload
          :auto-upload="false"
          :show-file-list="false"
          accept=".json,application/json"
          :on-change="(f: any) => f.raw && onFile(f.raw)"
        >
          <el-button>选择同伴的作业包文件</el-button>
        </el-upload>
        <p class="muted">只做本机合并、不上传任何服务器；冲突未解决前不写库，失败可重试。</p>
      </el-card>
    </div>

    <!-- 合并面板 -->
    <el-card v-if="plan && pkg" shadow="never" class="merge-panel">
      <template #header>
        <div class="panel-head">
          <strong>作业包预检：{{ pkg.geologist }}（设备 {{ shortDevice(pkg.deviceId) }}）</strong>
          <span class="muted">
            导出于 {{ new Date(pkg.exportedAt).toLocaleString('zh-CN') }} · {{ pkg.ops.length }} 条操作 · 结构版本
            v{{ pkg.schemaVersion }}
          </span>
          <el-button size="small" @click="resetDialog">关闭</el-button>
        </div>
      </template>

      <!-- 重复导入 -->
      <el-result
        v-if="plan.status === 'duplicate'"
        icon="info"
        title="该作业包已合并过"
        :sub-title="plan.reason"
      />

      <!-- 版本过期 / 结构不兼容：拒绝 -->
      <div v-else-if="plan.status === 'rejected'">
        <el-result icon="error" title="拒绝合并：作业包不可用" :sub-title="plan.reason">
          <template #extra>
            <el-button type="primary" @click="resetDialog">知道了</el-button>
          </template>
        </el-result>
        <el-card v-if="plan.affected.length" shadow="never" class="affected">
          <template #header><strong>受影响内容（{{ plan.affected.length }} 项）</strong></template>
          <ul class="affected-list">
            <li v-for="(line, i) in plan.affected" :key="i" :class="{ indent: line.startsWith('  └') }">{{ line }}</li>
          </ul>
        </el-card>
      </div>

      <template v-else>
        <!-- 汇总 -->
        <div class="summary">
          <el-tag type="success">新增 {{ plan.summary.creates }}</el-tag>
          <el-tag type="primary">更新 {{ plan.summary.updates }}</el-tag>
          <el-tag type="danger">删除 {{ plan.summary.deletes }}</el-tag>
          <el-tag type="info">跳过 {{ plan.summary.skips }}</el-tag>
          <el-tag v-if="plan.status === 'conflicts'" type="warning">
            待裁决冲突 {{ unresolvedCount }} 处
          </el-tag>
        </div>

        <!-- 冲突清单 -->
        <div v-for="entry in conflictEntries" :key="`c-${entry.table}-${entry.targetId}`" class="conflict-box">
          <div class="conflict-title">
            <el-tag type="danger" size="small">冲突</el-tag>
            <el-tag size="small" effect="plain">{{ tableName[entry.table] }}</el-tag>
            <strong>{{ entry.label }}</strong>
          </div>

          <!-- 字段冲突（含关键字段） -->
          <template v-if="entry.conflict?.kind === 'field'">
            <el-table :data="entry.conflict.fields" size="small" border>
              <el-table-column prop="label" label="字段" width="150">
                <template #default="{ row }">
                  {{ row.label }}
                  <el-tag v-if="row.key" type="danger" size="small">关键字段</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="baseDisplay" label="共同原值" min-width="180" />
              <el-table-column label="本机值" min-width="150">
                <template #default="{ row }">
                  <strong :class="{ chosen: row.choice === 'local' }">{{ row.localDisplay }}</strong>
                </template>
              </el-table-column>
              <el-table-column label="对方值" min-width="150">
                <template #default="{ row }">
                  <strong :class="{ chosen: row.choice === 'remote' }">{{ row.remoteDisplay }}</strong>
                </template>
              </el-table-column>
              <el-table-column label="选择" width="210">
                <template #default="{ row }">
                  <el-radio-group
                    :model-value="row.choice"
                    @update:model-value="(v: any) => chooseField(`${entry.table}:${entry.targetId}`, row.field, v)"
                  >
                    <el-radio-button value="local">取本机</el-radio-button>
                    <el-radio-button value="remote">取对方</el-radio-button>
                  </el-radio-group>
                </template>
              </el-table-column>
            </el-table>
          </template>

          <!-- 对方删除 / 本机改过 -->
          <template v-else-if="entry.conflict?.kind === 'delete-update'">
            <el-alert
              type="warning"
              :closable="false"
              :title="`对方（${pkg.geologist}）删除了该记录，但本机之后做过修改。保留本机记录，还是按对方删除？`"
              show-icon
              style="margin: 6px 0"
            />
            <el-radio-group
              :model-value="entry.conflict.choice"
              @update:model-value="(v: any) => chooseRecord(`${entry.table}:${entry.targetId}`, v)"
            >
              <el-radio-button value="local">保留本机记录</el-radio-button>
              <el-radio-button value="remote">按对方删除</el-radio-button>
            </el-radio-group>
          </template>

          <!-- 同编号各自新建 -->
          <template v-else-if="entry.conflict?.kind === 'create-create'">
            <el-alert
              type="warning"
              :closable="false"
              title="两边各自新建了相同编号的掌子面（无共同基线），请选择以哪一份为准"
              show-icon
              style="margin: 6px 0"
            />
            <div class="create-choice">
              <div :class="['choice-card', entry.conflict.choice === 'local' && 'picked']">
                <strong>本机：{{ (entry.conflict.local as any)?.faceNo }}</strong>
                <p>岩性 {{ (entry.conflict.local as any)?.lithology }} · 桩号 {{ (entry.conflict.local as any)?.chainage }} · 地质员 {{ (entry.conflict.local as any)?.geologist }}</p>
                <el-button size="small" @click="chooseRecord(`${entry.table}:${entry.targetId}`, 'local')">用本机这份</el-button>
              </div>
              <div :class="['choice-card', entry.conflict.choice === 'remote' && 'picked']">
                <strong>对方：{{ (entry.conflict.remote as any)?.faceNo }}（{{ pkg.geologist }}）</strong>
                <p>岩性 {{ (entry.conflict.remote as any)?.lithology }} · 桩号 {{ (entry.conflict.remote as any)?.chainage }} · 地质员 {{ (entry.conflict.remote as any)?.geologist }}</p>
                <el-button size="small" @click="chooseRecord(`${entry.table}:${entry.targetId}`, 'remote')">用对方这份</el-button>
              </div>
            </div>
          </template>
        </div>

        <!-- 自动并入条目（按操作顺序） -->
        <el-card v-if="autoEntries.length" shadow="never" class="auto-card">
          <template #header>
            <strong>无冲突，按对方操作顺序自动处理（{{ autoEntries.length }} 项）</strong>
          </template>
          <el-table :data="autoEntries" size="small" border>
            <el-table-column label="顺序" width="70">
              <template #default="{ $index }">{{ $index + 1 }}</template>
            </el-table-column>
            <el-table-column label="类型" width="90">
              <template #default="{ row }">
                <el-tag :type="actionTag[row.action].type" size="small">{{ actionTag[row.action].text }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="label" label="内容" min-width="260" />
            <el-table-column label="版本向量" min-width="160">
              <template #default="{ row }">{{ row.resolvedRow ? vvText(row.resolvedRow._sync.vv) : '—' }}</template>
            </el-table-column>
            <el-table-column prop="note" label="说明" min-width="180" />
          </el-table>
        </el-card>

        <el-card v-if="skipEntries.length" shadow="never" class="auto-card">
          <template #header><strong>跳过（{{ skipEntries.length }} 项）</strong></template>
          <el-table :data="skipEntries" size="small" border>
            <el-table-column prop="label" label="内容" min-width="260" />
            <el-table-column prop="note" label="原因" min-width="220" />
          </el-table>
        </el-card>

        <el-alert
          v-if="applyError"
          :title="`合并失败：${applyError}。本次事务已回滚，本机原记录完好，解决问题后可直接再次确认重试。`"
          type="error"
          :closable="false"
          show-icon
          style="margin: 10px 0"
        />

        <div class="actions">
          <el-button @click="resetDialog">取消</el-button>
          <el-button
            type="primary"
            :loading="applying"
            :disabled="plan.status === 'conflicts'"
            @click="confirmMerge"
          >
            {{ plan.status === 'conflicts' ? `还有 ${unresolvedCount} 处冲突待选择` : '确认合并写入本机' }}
          </el-button>
        </div>
      </template>
    </el-card>

    <!-- 最近一次合并回执 -->
    <el-card v-if="lastReport" shadow="never">
      <template #header><strong>最近一次合并回执</strong></template>
      <el-result
        icon="success"
        title="合并成功"
        :sub-title="`新增 ${lastReport.creates} · 更新 ${lastReport.updates} · 删除 ${lastReport.deletes} · 跳过 ${lastReport.skips}`"
      />
      <el-table :data="lastReport.labels.map((l) => ({ l }))" size="small" border>
        <el-table-column prop="l" label="已并入内容" />
      </el-table>
    </el-card>

    <!-- 已合并历史 -->
    <el-card shadow="never">
      <template #header><strong>已合并作业包（重复导入以此去重）</strong></template>
      <el-table :data="applied" size="small" border>
        <el-table-column prop="geologist" label="来源地质员" width="130" />
        <el-table-column label="设备" width="100">
          <template #default="{ row }">{{ shortDevice(row.deviceId) }}</template>
        </el-table-column>
        <el-table-column prop="opCount" label="操作条数" width="90" />
        <el-table-column label="合并时间" width="180">
          <template #default="{ row }">{{ new Date(row.appliedAt).toLocaleString('zh-CN') }}</template>
        </el-table-column>
        <el-table-column label="水位序号" width="100">
          <template #default="{ row }">#{{ row.deviceSeq }}</template>
        </el-table-column>
        <el-table-column prop="packageId" label="作业包 ID" min-width="200" />
      </el-table>
      <el-empty v-if="applied.length === 0" description="尚未合并过作业包" :image-size="60" />
    </el-card>
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
.grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}
.muted {
  color: #7b8592;
  font-size: 13px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: #7b8592;
}
.panel-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.summary {
  display: flex;
  gap: 10px;
  margin: 8px 0 14px;
}
.conflict-box {
  border: 1px solid #f0c4a8;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
  background: #fffaf5;
}
.conflict-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.auto-card {
  margin-bottom: 12px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 12px;
}
.affected {
  margin: 0 24px 20px;
}
.affected-list {
  margin: 0;
  padding-left: 18px;
  line-height: 1.9;
}
.affected-list .indent {
  list-style: none;
  color: #7b8592;
  padding-left: 14px;
}
.chosen {
  color: #1f6f43;
}
.create-choice {
  display: flex;
  gap: 12px;
}
.choice-card {
  flex: 1;
  border: 1px solid #d8dee6;
  border-radius: 8px;
  padding: 10px 12px;
}
.choice-card.picked {
  border-color: #2f8f5b;
  background: #f1f9f4;
}
</style>
