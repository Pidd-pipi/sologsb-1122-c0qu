<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useFaceStore } from '../stores/faceStore';
import { useGradeStore } from '../stores/gradeStore';
import { useJointStore } from '../stores/jointStore';
import { useFaceFilter } from '../hooks/useFaceFilter';
import FaceCard from '../components/common/FaceCard.vue';
import GradeTag from '../components/common/GradeTag.vue';
import {
  EXCAVATION_METHODS,
  LITHOLOGIES,
  WEATHERINGS,
  type ExcavationMethod,
  type TunnelFaceDraft,
  type Weathering,
} from '../types/face';
import { ROCK_GRADES, type RockGrade } from '../types/grade';
import { formatChainage } from '../utils/geoMath';

const router = useRouter();
const faceStore = useFaceStore();
const gradeStore = useGradeStore();
const jointStore = useJointStore();
const { filters, result, options, gradeDistribution, reset } = useFaceFilter();

const dialogVisible = ref(false);
const error = ref('');

const form = reactive<TunnelFaceDraft>({
  faceNo: '',
  chainage: 12486,
  mileageRange: [12486, 12489],
  excavationMethod: '台阶法',
  faceSize: '12.6×9.8',
  lithology: '石灰岩',
  weathering: '微风化',
  rockStrength: 55,
  attitude: { strike: 45, dipDirection: 135, dipAngle: 30 },
  geologist: '',
});

const maxGradeCount = computed(() => Math.max(1, ...gradeDistribution.value.map((g) => g.count)));

function openDialog() {
  dialogVisible.value = true;
  error.value = '';
}

/** 复制上一循环（里程更小的最近一个掌子面）的信息 */
function copyPrevious() {
  const latest = faceStore.latest;
  if (!latest) {
    error.value = '暂无可复制的上一循环';
    return;
  }
  const draft = faceStore.previousDraft(latest.id) ?? latest;
  form.excavationMethod = draft.excavationMethod;
  form.faceSize = draft.faceSize;
  form.lithology = draft.lithology;
  form.weathering = draft.weathering;
  form.rockStrength = draft.rockStrength;
  form.attitude = { ...draft.attitude };
  form.geologist = draft.geologist;
  form.chainage = latest.chainage + 3;
  form.mileageRange = [latest.chainage + 3, latest.chainage + 6];
  form.faceNo = `${latest.faceNo}-next`;
  error.value = '';
  ElMessage.success(`已复制 ${latest.faceNo} 的编录信息，请修改编号与里程`);
}

async function submit() {
  error.value = '';
  if (!form.faceNo.trim()) {
    error.value = '掌子面编号必填';
    return;
  }
  if (faceStore.items.some((it) => it.faceNo === form.faceNo.trim())) {
    error.value = '掌子面编号已存在，请更换';
    return;
  }
  if (form.mileageRange[1] < form.mileageRange[0]) {
    error.value = '编录里程区间终点不能小于起点';
    return;
  }
  if (form.rockStrength <= 0 || form.rockStrength > 300) {
    error.value = '饱和抗压强度需在 0 ~ 300 MPa 之间';
    return;
  }
  const created = await faceStore.add({ ...form, faceNo: form.faceNo.trim() });
  dialogVisible.value = false;
  ElMessage.success(`已建立掌子面「${created.faceNo}」`);
  form.faceNo = '';
}

onMounted(async () => {
  await faceStore.load();
  await gradeStore.load();
  await jointStore.load();
});
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>掌子面台账</h2>
      <el-tag>共 {{ faceStore.items.length }} 个掌子面</el-tag>
      <el-tag type="info" effect="plain">筛选命中 {{ result.length }} 个</el-tag>
      <div class="spacer" />
      <el-button type="primary" @click="openDialog">新建编录</el-button>
    </div>

    <el-card shadow="never">
      <el-form :inline="true" @submit.prevent>
        <el-form-item label="里程区间">
          <el-input-number v-model="filters.chainageFrom" :min="0" :max="999999" :step="10" controls-position="right" style="width: 130px" />
          <span style="margin: 0 6px">—</span>
          <el-input-number v-model="filters.chainageTo" :min="0" :max="999999" :step="10" controls-position="right" style="width: 130px" />
        </el-form-item>
        <el-form-item label="岩性">
          <el-select v-model="filters.lithology" style="width: 140px">
            <el-option label="全部" value="all" />
            <el-option v-for="l in options.lithologies" :key="l" :label="l" :value="l" />
          </el-select>
        </el-form-item>
        <el-form-item label="围岩级别">
          <el-select v-model="filters.grade" style="width: 120px">
            <el-option label="全部" value="all" />
            <el-option v-for="g in ROCK_GRADES" :key="g" :label="`${g} 级`" :value="g" />
          </el-select>
        </el-form-item>
        <el-form-item label="开挖方式">
          <el-select v-model="filters.method" style="width: 130px">
            <el-option label="全部" value="all" />
            <el-option v-for="m in EXCAVATION_METHODS" :key="m" :label="m" :value="m" />
          </el-select>
        </el-form-item>
        <el-form-item label="关键词">
          <el-input v-model="filters.keyword" placeholder="编号 / 地质员 / 岩性" clearable style="width: 180px" />
        </el-form-item>
        <el-form-item>
          <el-button @click="reset">重置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never">
      <template #header><strong>围岩级别分布</strong></template>
      <div class="dist">
        <div v-for="item in gradeDistribution" :key="item.grade" class="dist-row">
          <GradeTag :grade="item.grade" />
          <div class="bar-wrap">
            <div class="bar" :style="{ width: `${(item.count / maxGradeCount) * 100}%` }" />
          </div>
          <span class="count">{{ item.count }} 个</span>
        </div>
      </div>
    </el-card>

    <div v-if="result.length === 0" class="empty">
      <el-empty description="没有符合条件的掌子面" />
    </div>
    <div v-else class="grid">
      <FaceCard
        v-for="row in result"
        :key="row.face.id"
        :face="row.face"
        :grade="row.grade"
        :joint-count="jointStore.byFace(row.face.id).length"
        :water-count="gradeStore.watersByFace(row.face.id).length"
        :footer="`编录时间 ${new Date(row.lastRecordedAt).toLocaleString('zh-CN')}`"
        @open="(id) => router.push(`/faces/${id}`)"
      />
    </div>

    <el-dialog v-model="dialogVisible" title="新建掌子面编录" width="700px">
      <el-alert v-if="error" :title="error" type="error" :closable="false" style="margin-bottom: 10px" />
      <div style="margin-bottom: 10px">
        <el-button size="small" @click="copyPrevious">复制上一循环信息</el-button>
        <span class="hint">按里程最大的掌子面自动带出开挖方式、岩性、产状等字段</span>
      </div>
      <el-form :model="form" label-width="120px">
        <el-form-item label="掌子面编号" required>
          <el-input v-model="form.faceNo" placeholder="如 ZK-104" />
        </el-form-item>
        <el-form-item label="里程桩号 m">
          <el-input-number v-model="form.chainage" :min="0" :max="999999" :step="1" />
          <span class="hint">{{ formatChainage(form.chainage) }}</span>
        </el-form-item>
        <el-form-item label="编录里程区间 m">
          <el-input-number v-model="form.mileageRange[0]" :min="0" :max="999999" />
          <span style="margin: 0 6px">—</span>
          <el-input-number v-model="form.mileageRange[1]" :min="0" :max="999999" />
        </el-form-item>
        <el-form-item label="开挖方式">
          <el-select v-model="form.excavationMethod">
            <el-option v-for="m in EXCAVATION_METHODS" :key="m" :label="m" :value="m" />
          </el-select>
        </el-form-item>
        <el-form-item label="开挖断面尺寸 m">
          <el-input v-model="form.faceSize" placeholder="宽×高，如 12.6×9.8" />
        </el-form-item>
        <el-form-item label="岩性">
          <el-select v-model="form.lithology">
            <el-option v-for="l in LITHOLOGIES" :key="l" :label="l" :value="l" />
          </el-select>
        </el-form-item>
        <el-form-item label="风化程度">
          <el-select v-model="form.weathering">
            <el-option v-for="w in WEATHERINGS" :key="w" :label="w" :value="w" />
          </el-select>
        </el-form-item>
        <el-form-item label="饱和抗压强度">
          <el-input-number v-model="form.rockStrength" :min="1" :max="300" :step="1" />
          <span class="hint">MPa</span>
        </el-form-item>
        <el-form-item label="岩层产状">
          <span class="hint">走向</span>
          <el-input-number v-model="form.attitude.strike" :min="0" :max="360" />
          <span class="hint">倾向</span>
          <el-input-number v-model="form.attitude.dipDirection" :min="0" :max="360" />
          <span class="hint">倾角</span>
          <el-input-number v-model="form.attitude.dipAngle" :min="0" :max="90" />
        </el-form-item>
        <el-form-item label="地质员">
          <el-input v-model="form.geologist" style="width: 200px" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存编录</el-button>
      </template>
    </el-dialog>
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
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.empty {
  padding: 30px 0;
}
.dist {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dist-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.bar-wrap {
  flex: 1;
  height: 14px;
  background: #f0f3f6;
  border-radius: 7px;
  overflow: hidden;
}
.bar {
  height: 100%;
  background: linear-gradient(90deg, #7fbf9a, #2f8f5b);
}
.count {
  width: 70px;
  text-align: right;
  color: #5b6470;
  font-size: 13px;
}
.hint {
  margin-left: 8px;
  color: #97a0ad;
  font-size: 12px;
}
</style>
