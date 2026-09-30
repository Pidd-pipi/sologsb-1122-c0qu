<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useFaceStore } from '../stores/faceStore';
import { useGradeStore } from '../stores/gradeStore';
import { useJointStore } from '../stores/jointStore';
import { useGradeCalc } from '../hooks/useGradeCalc';
import GradeTag from '../components/common/GradeTag.vue';
import { GROUNDWATERS, GRADE_SUPPORT, ROCK_GRADES, type Groundwater, type RockGrade } from '../types/grade';
import { attitudeText, estimateJv, formatChainage } from '../utils/geoMath';

const route = useRoute();
const router = useRouter();
const faceStore = useFaceStore();
const gradeStore = useGradeStore();
const jointStore = useJointStore();

const faceId = computed(() => String(route.params.faceId ?? ''));
const face = computed(() => faceStore.byId(faceId.value));
const joints = computed(() => jointStore.byFace(faceId.value));
const history = computed(() => gradeStore.byFace(faceId.value));
const previous = computed(() => history.value[0]);

const { input, result, patch } = useGradeCalc(() => joints.value);
const manual = ref(false);
const manualGrade = ref<RockGrade>('Ⅲ');

const finalGrade = computed<RockGrade>(() => (manual.value ? manualGrade.value : result.value.grade));
const finalSupport = computed(() => GRADE_SUPPORT[finalGrade.value]);

const compareText = computed(() => {
  if (!previous.value) return '本掌子面尚无历史判定，保存后将成为首次记录';
  const order = ROCK_GRADES;
  const delta = order.indexOf(finalGrade.value) - order.indexOf(previous.value.grade);
  if (delta === 0) return `与上循环级别一致（${previous.value.grade} 级）`;
  return delta > 0
    ? `较上循环变差 ${delta} 级：${previous.value.grade} → ${finalGrade.value}`
    : `较上循环变好 ${-delta} 级：${previous.value.grade} → ${finalGrade.value}`;
});

watch(
  () => result.value.grade,
  (g) => {
    manualGrade.value = g;
  },
  { immediate: true },
);

async function save() {
  if (!face.value) {
    ElMessage.error('未找到该掌子面');
    return;
  }
  await gradeStore.addGrade({
    faceId: face.value.id,
    grade: finalGrade.value,
    bqValue: result.value.bq,
    rqd: input.value.rqd,
    jv: result.value.jv,
    kv: input.value.kv,
    groundwater: input.value.groundwater,
    spanWidth: input.value.spanWidth,
    correction: Number((result.value.k1 + result.value.k2 + input.value.extraCorrection).toFixed(3)),
    correctedBq: result.value.correctedBq,
    supportSuggestion: finalSupport.value,
    manualAdjusted: manual.value,
  });
  ElMessage.success(`已保存 ${finalGrade.value} 级围岩判定`);
}

onMounted(async () => {
  await faceStore.load();
  await jointStore.load();
  await gradeStore.load();
  if (face.value) {
    patch({
      rockStrength: face.value.rockStrength,
      spanWidth: Number(face.value.faceSize.split('×')[0]) || 12,
    });
  }
});
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>围岩级别判定 · {{ face?.faceNo ?? '未知' }}</h2>
      <GradeTag :grade="finalGrade" />
      <el-tag type="info" effect="plain">节理 {{ joints.length }} 组 · 自动 Jv {{ estimateJv(joints) }}</el-tag>
      <div class="spacer" />
      <el-button @click="router.push(`/faces/${faceId}`)">返回掌子面详情</el-button>
      <el-button @click="router.push(`/faces/${faceId}/joints`)">节理录入</el-button>
    </div>

    <el-alert v-if="!face" type="warning" :closable="false" show-icon title="未找到该掌子面" />

    <div class="grid">
      <el-card shadow="never">
        <template #header><strong>逐项指标输入</strong></template>
        <el-form label-width="150px">
          <el-form-item label="饱和抗压强度 Rc">
            <el-input-number v-model="input.rockStrength" :min="1" :max="300" :step="1" />
            <span class="hint">MPa</span>
          </el-form-item>
          <el-form-item label="岩石质量指标 RQD">
            <el-slider v-model="input.rqd" :min="0" :max="100" :step="1" style="width: 240px" />
            <span class="hint">{{ input.rqd }} %</span>
          </el-form-item>
          <el-form-item label="节理体密度 Jv">
            <el-input-number v-model="input.jv" :min="0" :max="60" :step="0.1" :precision="1" />
            <span class="hint">条/m³（0 表示按节理间距自动估算 {{ estimateJv(joints) }}）</span>
          </el-form-item>
          <el-form-item label="岩体完整性系数 Kv">
            <el-slider v-model="input.kv" :min="0" :max="1" :step="0.01" style="width: 240px" />
            <span class="hint">{{ input.kv }}</span>
          </el-form-item>
          <el-form-item label="出水状态">
            <el-select v-model="input.groundwater" style="width: 200px">
              <el-option v-for="g in GROUNDWATERS" :key="g" :label="g" :value="g" />
            </el-select>
          </el-form-item>
          <el-form-item label="洞跨">
            <el-input-number v-model="input.spanWidth" :min="1" :max="60" :step="0.5" />
            <span class="hint">m</span>
          </el-form-item>
          <el-form-item label="其它修正系数">
            <el-input-number v-model="input.extraCorrection" :min="0" :max="1" :step="0.01" :precision="2" />
          </el-form-item>
        </el-form>
      </el-card>

      <div class="right">
        <el-card shadow="never">
          <template #header><strong>实时算得的级别与支护建议</strong></template>
          <div class="result">
            <GradeTag :grade="finalGrade" />
            <span class="muted">BQ = {{ result.bq }} · [BQ] = {{ result.correctedBq }}</span>
            <el-tag v-if="manual" type="warning" size="small">人工修正</el-tag>
          </div>
          <p class="support">{{ finalSupport }}</p>
          <el-checkbox v-model="manual">启用人工修正级别</el-checkbox>
          <el-radio-group v-if="manual" v-model="manualGrade" style="margin-top: 8px">
            <el-radio-button v-for="g in ROCK_GRADES" :key="g" :value="g">{{ g }}</el-radio-button>
          </el-radio-group>
          <el-divider />
          <p class="muted">{{ compareText }}</p>
          <el-button type="primary" @click="save">保存判定结果</el-button>
        </el-card>

        <el-card shadow="never">
          <template #header><strong>计算过程</strong></template>
          <ol class="steps">
            <li v-for="(line, i) in result.explanation" :key="i">{{ line }}</li>
          </ol>
        </el-card>

        <el-card shadow="never">
          <template #header><strong>本掌子面历史判定</strong></template>
          <el-table :data="history" size="small" border>
            <el-table-column label="时间" width="170">
              <template #default="{ row }">{{ new Date(row.judgedAt).toLocaleString('zh-CN') }}</template>
            </el-table-column>
            <el-table-column label="级别" width="90">
              <template #default="{ row }"><GradeTag :grade="row.grade" /></template>
            </el-table-column>
            <el-table-column prop="bqValue" label="BQ" width="90" />
            <el-table-column prop="correctedBq" label="[BQ]" width="90" />
            <el-table-column prop="rqd" label="RQD" width="80" />
            <el-table-column prop="kv" label="Kv" width="80" />
            <el-table-column prop="groundwater" label="出水" width="120" />
            <el-table-column label="修正" width="80">
              <template #default="{ row }">{{ row.manualAdjusted ? '人工' : '自动' }}</template>
            </el-table-column>
          </el-table>
          <el-empty v-if="history.length === 0" description="尚无历史判定" :image-size="60" />
        </el-card>

        <el-card v-if="face" shadow="never">
          <template #header><strong>掌子面摘要</strong></template>
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="桩号">{{ formatChainage(face.chainage) }}</el-descriptions-item>
            <el-descriptions-item label="开挖方式">{{ face.excavationMethod }}</el-descriptions-item>
            <el-descriptions-item label="岩性">{{ face.lithology }}（{{ face.weathering }}）</el-descriptions-item>
            <el-descriptions-item label="断面尺寸">{{ face.faceSize }} m</el-descriptions-item>
            <el-descriptions-item label="岩层产状">
              {{ attitudeText(face.attitude.dipDirection, face.attitude.dipAngle) }}
            </el-descriptions-item>
            <el-descriptions-item label="地质员">{{ face.geologist }}</el-descriptions-item>
          </el-descriptions>
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
  grid-template-columns: 520px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.right {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.result {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.support {
  color: #2f3a46;
  margin: 6px 0;
}
.muted {
  color: #7b8592;
  font-size: 13px;
}
.hint {
  margin-left: 8px;
  color: #97a0ad;
  font-size: 12px;
}
.steps {
  margin: 0;
  padding-left: 18px;
  color: #5b6470;
  font-size: 13px;
  line-height: 1.9;
}
</style>
