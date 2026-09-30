<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useFaceStore } from '../stores/faceStore';
import { useJointStore } from '../stores/jointStore';
import JointPolarPlot from '../components/common/JointPolarPlot.vue';
import SketchCanvas from '../components/common/SketchCanvas.vue';
import {
  FILL_MATERIALS,
  ROUGHNESSES,
  WATER_WETS,
  isDipAbnormal,
  type FillMaterial,
  type JointSetDraft,
  type Roughness,
  type WaterWet,
} from '../types/joint';
import { attitudeText, clusterJoints } from '../utils/geoMath';
import { nextSetNo } from '../utils/id';

const route = useRoute();
const router = useRouter();
const faceStore = useFaceStore();
const jointStore = useJointStore();

const faceId = computed(() => String(route.params.id ?? ''));
const face = computed(() => faceStore.byId(faceId.value));
const joints = computed(() => jointStore.byFace(faceId.value));
const clusters = computed(() => clusterJoints(joints.value));

const error = ref('');
const mergeTarget = ref('');

const form = reactive<JointSetDraft>({
  faceId: '',
  setNo: 1,
  dipDirection: 120,
  dipAngle: 60,
  spacing: 40,
  persistence: 3,
  aperture: 1,
  fillMaterial: '方解石',
  roughness: '粗糙',
  waterWet: '潮湿',
  jointCount: 5,
});

watch(
  faceId,
  (id) => {
    form.faceId = id;
    form.setNo = nextSetNo(jointStore.byFace(id).map((j) => j.setNo));
    if (face.value) {
      form.dipDirection = face.value.attitude.dipDirection;
      form.dipAngle = face.value.attitude.dipAngle;
    }
  },
  { immediate: true },
);

const dipAbnormal = computed(() => isDipAbnormal(form.dipAngle));
const apparentDipHint = computed(() => {
  // 视倾角示意：假定剖面方向与倾向夹角 30°
  const rad = (v: number) => (v * Math.PI) / 180;
  const value = (Math.atan(Math.tan(rad(form.dipAngle)) * Math.sin(rad(30))) * 180) / Math.PI;
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
});

async function submit() {
  error.value = '';
  if (!form.faceId) {
    error.value = '未指定掌子面';
    return;
  }
  if (isDipAbnormal(form.dipAngle)) {
    error.value = '倾角异常：必须落在 0 ~ 90° 之间';
    return;
  }
  if (joints.value.some((j) => j.setNo === form.setNo)) {
    error.value = `组号 J${form.setNo} 已存在，请改用 J${nextSetNo(joints.value.map((j) => j.setNo))}`;
    return;
  }
  const created = await jointStore.add({ ...form });
  ElMessage.success(`已录入 J${created.setNo}：${attitudeText(created.dipDirection, created.dipAngle)}`);
  form.setNo = nextSetNo(joints.value.map((j) => j.setNo));
  form.jointCount = 5;
}

async function mergeCluster(clusterNo: number) {
  const cluster = clusters.value.find((c) => c.clusterNo === clusterNo);
  if (!cluster || cluster.members.length < 2) {
    ElMessage.warning('该簇只有一个组，无需合并');
    return;
  }
  const target = joints.value.find((j) => `J${j.setNo}` === cluster.members[0]);
  const sourceIds = joints.value.filter((j) => cluster.members.includes(`J${j.setNo}`) && j.id !== target?.id).map((j) => j.id);
  if (!target) return;
  await jointStore.mergeInto(target.id, sourceIds);
  ElMessage.success(`已把 ${cluster.members.slice(1).join('、')} 合并入 J${target.setNo}`);
}

onMounted(async () => {
  await faceStore.load();
  await jointStore.load();
});
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>节理产状录入 · {{ face?.faceNo ?? '未知' }}</h2>
      <el-tag type="info" effect="plain">已录 {{ joints.length }} 组</el-tag>
      <div class="spacer" />
      <el-button @click="router.push(`/faces/${faceId}`)">返回掌子面详情</el-button>
      <el-button @click="router.push(`/grade/${faceId}`)">围岩级别判定</el-button>
    </div>

    <div class="grid">
      <el-card shadow="never">
        <template #header><strong>新增节理组</strong></template>
        <el-alert v-if="error" :title="error" type="error" :closable="false" style="margin-bottom: 10px" />
        <el-form :model="form" label-width="110px">
          <el-form-item label="组号">
            <el-input-number v-model="form.setNo" :min="1" :max="99" />
            <span class="hint">建议 J{{ nextSetNo(joints.map((j) => j.setNo)) }}</span>
          </el-form-item>
          <el-form-item label="倾向 °">
            <el-input-number v-model="form.dipDirection" :min="0" :max="360" />
          </el-form-item>
          <el-form-item label="倾角 °">
            <el-input-number v-model="form.dipAngle" :min="0" :max="120" />
            <span v-if="dipAbnormal" class="warn">倾角异常，需在 0~90° 之间</span>
            <span v-else class="hint">剖面夹角 30° 时视倾角约 {{ apparentDipHint }}°</span>
          </el-form-item>
          <el-form-item label="间距 cm">
            <el-input-number v-model="form.spacing" :min="1" :max="500" />
          </el-form-item>
          <el-form-item label="延伸长度 m">
            <el-input-number v-model="form.persistence" :min="0" :max="50" :step="0.1" :precision="1" />
          </el-form-item>
          <el-form-item label="张开度 mm">
            <el-input-number v-model="form.aperture" :min="0" :max="100" :step="0.1" :precision="1" />
          </el-form-item>
          <el-form-item label="充填物">
            <el-select v-model="form.fillMaterial">
              <el-option v-for="f in FILL_MATERIALS" :key="f" :label="f" :value="f" />
            </el-select>
          </el-form-item>
          <el-form-item label="粗糙度">
            <el-select v-model="form.roughness">
              <el-option v-for="r in ROUGHNESSES" :key="r" :label="r" :value="r" />
            </el-select>
          </el-form-item>
          <el-form-item label="渗水状态">
            <el-select v-model="form.waterWet">
              <el-option v-for="w in WATER_WETS" :key="w" :label="w" :value="w" />
            </el-select>
          </el-form-item>
          <el-form-item label="条数">
            <el-input-number v-model="form.jointCount" :min="1" :max="999" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="submit">保存节理组</el-button>
          </el-form-item>
        </el-form>
      </el-card>

      <div class="right">
        <el-card shadow="never">
          <template #header><strong>极点图与走向玫瑰图</strong></template>
          <JointPolarPlot :joints="joints" />
        </el-card>

        <el-card shadow="never">
          <template #header>
            <div class="card-head">
              <strong>同组产状合并（按倾向 30° 聚类）</strong>
            </div>
          </template>
          <el-table :data="clusters" size="small" border>
            <el-table-column label="簇" width="70">
              <template #default="{ row }">C{{ row.clusterNo }}</template>
            </el-table-column>
            <el-table-column label="平均产状" width="150">
              <template #default="{ row }">{{ attitudeText(row.dipDirection, row.dipAngle) }}</template>
            </el-table-column>
            <el-table-column label="成员" min-width="140">
              <template #default="{ row }">{{ row.members.join('、') }}</template>
            </el-table-column>
            <el-table-column prop="jointCount" label="合计条数" width="100" />
            <el-table-column label="操作" width="110">
              <template #default="{ row }">
                <el-button size="small" :disabled="row.members.length < 2" @click="mergeCluster(row.clusterNo)">
                  合并
                </el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="clusters.length === 0" description="暂无节理组" :image-size="60" />
        </el-card>

        <el-card shadow="never">
          <template #header><strong>节理组清单</strong></template>
          <el-table :data="joints" size="small" border>
            <el-table-column label="组号" width="70">
              <template #default="{ row }">J{{ row.setNo }}</template>
            </el-table-column>
            <el-table-column label="产状" width="150">
              <template #default="{ row }">{{ attitudeText(row.dipDirection, row.dipAngle) }}</template>
            </el-table-column>
            <el-table-column prop="spacing" label="间距 cm" width="90" />
            <el-table-column prop="persistence" label="延伸 m" width="90" />
            <el-table-column prop="aperture" label="张开 mm" width="90" />
            <el-table-column prop="fillMaterial" label="充填" width="90" />
            <el-table-column prop="roughness" label="粗糙度" width="110" />
            <el-table-column prop="waterWet" label="渗水" width="90" />
            <el-table-column prop="jointCount" label="条数" width="80" />
            <el-table-column label="操作" width="90">
              <template #default="{ row }">
                <el-button size="small" danger @click="jointStore.remove(row.id)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <el-card v-if="face" shadow="never">
          <template #header><strong>岩性素描（可继续布置结构面）</strong></template>
          <SketchCanvas :face-id="face.id" :lithology="face.lithology" :attitude="face.attitude" />
        </el-card>
      </div>
    </div>
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
.grid {
  display: grid;
  grid-template-columns: 420px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.right {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.hint {
  margin-left: 8px;
  color: #97a0ad;
  font-size: 12px;
}
.warn {
  margin-left: 8px;
  color: #d93025;
  font-size: 12px;
}
</style>
