<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { Attitude } from '../../types/face';
import { getSketch, onDataChange, putSketch } from '../../utils/syncRepo';

export interface SketchSegment {
  id: string;
  /** 线中点 x（视图坐标） */
  x: number;
  /** 线中点 y（视图坐标） */
  y: number;
  /** 结构面倾角 ° */
  dipAngle: number;
  /** 结构面倾向 ° */
  dipDirection: number;
  /** 线长（视图坐标） */
  length: number;
  label: string;
}

const props = defineProps<{
  faceId: string;
  lithology: string;
  attitude: Attitude;
  /** 是否只读 */
  readonly?: boolean;
}>();

const emit = defineEmits<{
  (e: 'change', segments: SketchSegment[]): void;
}>();

const VB = { w: 660, h: 380 };
const segments = ref<SketchSegment[]>([]);
const selectedId = ref('');
let saving = false;
let dirty = false;

/** 岩性填充纹样：按岩性选择不同 SVG pattern */
const patternId = computed(() => {
  const name = props.lithology;
  if (name.includes('灰岩') || name.includes('石灰岩')) return 'pat-carbonate';
  if (name.includes('砂岩')) return 'pat-sandstone';
  if (name.includes('泥岩') || name.includes('页岩')) return 'pat-mudstone';
  if (name.includes('花岗') || name.includes('片麻')) return 'pat-igneous';
  return 'pat-default';
});

const patternLabel = computed(() => {
  const map: Record<string, string> = {
    'pat-carbonate': '灰岩：短横线纹样',
    'pat-sandstone': '砂岩：点状纹样',
    'pat-mudstone': '泥岩/页岩：水平层理纹样',
    'pat-igneous': '岩浆岩：交叉线纹样',
    'pat-default': '通用：斜线纹样',
  };
  return map[patternId.value] ?? '通用纹样';
});

async function load() {
  const doc = await getSketch(props.faceId);
  segments.value = doc ? doc.segments : [];
  selectedId.value = '';
  emit('change', segments.value);
}

async function persist() {
  if (saving) {
    dirty = true;
    return;
  }
  saving = true;
  try {
    await putSketch(props.faceId, segments.value);
  } finally {
    saving = false;
  }
  if (dirty) {
    dirty = false;
    void persist();
  }
  emit('change', segments.value);
}

function onClick(e: MouseEvent) {
  if (props.readonly) return;
  const svg = e.currentTarget as SVGSVGElement;
  const rect = svg.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const x = Math.round(((e.clientX - rect.left) / rect.width) * VB.w);
  const y = Math.round(((e.clientY - rect.top) / rect.height) * VB.h);
  const dipAngle = props.attitude.dipAngle;
  const dipDirection = props.attitude.dipDirection;
  const index = segments.value.length + 1;
  segments.value = [
    ...segments.value,
    {
      id: `seg_${Date.now().toString(36)}${index}`,
      x,
      y,
      dipAngle,
      dipDirection,
      length: 56,
      label: `J${index} ${Math.round(dipDirection)}°∠${Math.round(dipAngle)}°`,
    },
  ];
  persist();
}

function undo() {
  if (segments.value.length === 0) return;
  segments.value = segments.value.slice(0, -1);
  persist();
}

function clearAll() {
  segments.value = [];
  persist();
}

function lineOf(seg: SketchSegment) {
  const rad = ((90 - seg.dipAngle) * Math.PI) / 180;
  const dx = (Math.cos(rad) * seg.length) / 2;
  const dy = (Math.sin(rad) * seg.length) / 2;
  return { x1: seg.x - dx, y1: seg.y - dy, x2: seg.x + dx, y2: seg.y + dy };
}

function tickOf(seg: SketchSegment) {
  const rad = ((90 - seg.dipAngle) * Math.PI) / 180;
  const nx = -Math.sin(rad);
  const ny = Math.cos(rad);
  return { x: seg.x + nx * 10, y: seg.y + ny * 10 };
}

onMounted(load);
watch(() => props.faceId, load);
// 合并作业包后素描可能被更新：数据变更时重读当前掌子面
const unsubscribe = onDataChange(() => {
  void load();
});
onUnmounted(unsubscribe);
</script>

<template>
  <div class="sketch">
    <div class="toolbar">
      <span class="hint">在图上单击即可按当前产状布置结构面线段（{{ segments.length }} 条）</span>
      <el-button size="small" :disabled="readonly || segments.length === 0" @click="undo">撤销</el-button>
      <el-button size="small" :disabled="readonly || segments.length === 0" @click="clearAll">清空</el-button>
    </div>

    <svg
      :viewBox="`0 0 ${VB.w} ${VB.h}`"
      class="canvas"
      data-testid="sketch-canvas"
      :style="{ cursor: readonly ? 'default' : 'crosshair' }"
      @click="onClick"
    >
      <defs>
        <pattern id="pat-carbonate" width="16" height="10" patternUnits="userSpaceOnUse">
          <rect width="16" height="10" fill="#dfe3e8" />
          <line x1="0" y1="5" x2="9" y2="5" stroke="#9aa3ad" stroke-width="1.2" />
        </pattern>
        <pattern id="pat-sandstone" width="12" height="12" patternUnits="userSpaceOnUse">
          <rect width="12" height="12" fill="#e6dfd2" />
          <circle cx="3" cy="3" r="1.1" fill="#b0a189" />
          <circle cx="9" cy="8" r="1.1" fill="#b0a189" />
        </pattern>
        <pattern id="pat-mudstone" width="14" height="9" patternUnits="userSpaceOnUse">
          <rect width="14" height="9" fill="#e4e0e6" />
          <line x1="0" y1="3" x2="14" y2="3" stroke="#a9a2b0" stroke-width="1" />
          <line x1="0" y1="7" x2="14" y2="7" stroke="#a9a2b0" stroke-width="1" />
        </pattern>
        <pattern id="pat-igneous" width="14" height="14" patternUnits="userSpaceOnUse">
          <rect width="14" height="14" fill="#e8dede" />
          <path d="M0 14L14 0M-2 4L4 -2M10 16L16 10" stroke="#bda9a9" stroke-width="1" />
        </pattern>
        <pattern id="pat-default" width="12" height="12" patternUnits="userSpaceOnUse">
          <rect width="12" height="12" fill="#e6e8ea" />
          <line x1="0" y1="12" x2="12" y2="0" stroke="#adb4bb" stroke-width="1" />
        </pattern>
      </defs>

      <!-- 掌子面轮廓（马蹄形） -->
      <path
        d="M40 330 L40 170 A 130 130 0 0 1 300 170 L300 330 Z"
        :fill="`url(#${patternId})`"
        stroke="#4a4f57"
        stroke-width="2"
      />
      <path d="M340 330 L340 170 A 130 130 0 0 1 600 170 L600 330 Z" fill="#f3f5f6" stroke="#4a4f57" stroke-width="1" stroke-dasharray="6 4" />

      <!-- 岩层产状参考线 -->
      <line x1="60" y1="300" x2="280" y2="200" stroke="#8a6d1f" stroke-width="1.6" stroke-dasharray="8 4" />
      <text x="60" y="292" font-size="12" fill="#8a6d1f">
        岩层产状 {{ attitude.strike }}°/{{ attitude.dipDirection }}°∠{{ attitude.dipAngle }}°
      </text>

      <!-- 结构面线段 -->
      <g v-for="seg in segments" :key="seg.id">
        <line
          :x1="lineOf(seg).x1"
          :y1="lineOf(seg).y1"
          :x2="lineOf(seg).x2"
          :y2="lineOf(seg).y2"
          :stroke="selectedId === seg.id ? '#d3542f' : '#1f4f8a'"
          stroke-width="2.4"
          @click.stop="selectedId = seg.id"
        />
        <circle :cx="tickOf(seg).x" :cy="tickOf(seg).y" r="2.6" fill="#1f4f8a" />
        <text :x="seg.x + 6" :y="seg.y - 6" font-size="11" fill="#1f4f8a">{{ seg.label }}</text>
      </g>

      <!-- 比例尺 -->
      <g>
        <line x1="440" y1="350" x2="540" y2="350" stroke="#333" stroke-width="2" />
        <line x1="440" y1="344" x2="440" y2="356" stroke="#333" stroke-width="2" />
        <line x1="540" y1="344" x2="540" y2="356" stroke="#333" stroke-width="2" />
        <text x="452" y="342" font-size="11" fill="#333">2 m（1:100）</text>
      </g>

      <!-- 图例 -->
      <g>
        <rect x="40" y="16" width="14" height="10" :fill="`url(#${patternId})`" stroke="#4a4f57" />
        <text x="60" y="25" font-size="11" fill="#333">{{ patternLabel }}</text>
        <line x1="230" y1="21" x2="256" y2="21" stroke="#1f4f8a" stroke-width="2.4" />
        <text x="262" y="25" font-size="11" fill="#333">结构面线段（数字表示产状）</text>
        <line x1="450" y1="21" x2="476" y2="21" stroke="#8a6d1f" stroke-width="1.6" stroke-dasharray="6 4" />
        <text x="482" y="25" font-size="11" fill="#333">岩层层面</text>
      </g>
    </svg>

    <div v-if="segments.length > 0" class="legend">
      <el-tag v-for="seg in segments" :key="seg.id" size="small" :type="selectedId === seg.id ? 'danger' : 'info'">
        {{ seg.label }} @ ({{ seg.x }}, {{ seg.y }})
      </el-tag>
    </div>
  </div>
</template>

<style scoped>
.sketch {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
}
.hint {
  flex: 1;
  font-size: 13px;
  color: #7b8592;
}
.canvas {
  width: 100%;
  border: 1px solid #d8dee6;
  border-radius: 6px;
  background: #fbfcfd;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
</style>
