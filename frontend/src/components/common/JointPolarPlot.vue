<script setup lang="ts">
import { computed } from 'vue';
import type { JointSet } from '../../types/joint';
import { polarPoint, roseBuckets } from '../../utils/geoMath';

const props = defineProps<{
  joints: JointSet[];
}>();

const SIZE = 300;
const R = 120;
const COLORS = ['#1f4f8a', '#c9962c', '#2f8f5b', '#a03b8a', '#c0552a', '#4a4a8a'];

function colorOf(setNo: number): string {
  return COLORS[(setNo - 1) % COLORS.length];
}

const poles = computed(() =>
  props.joints.map((j) => {
    const p = polarPoint(j.dipDirection, j.dipAngle, R);
    return { ...j, cx: SIZE / 2 + p.x, cy: SIZE / 2 + p.y };
  }),
);

const rings = [R, (R * 2) / 3, R / 3];

const rose = computed(() => {
  const buckets = roseBuckets(props.joints, 10);
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  return buckets.map((b) => {
    const deg = Number(b.label.replace('°', ''));
    const len = (b.count / max) * (R - 6);
    const rad = ((deg - 90) * Math.PI) / 180;
    const spread = (10 * Math.PI) / 180;
    const x1 = cx + Math.cos(rad - spread / 2) * 12;
    const y1 = cy + Math.sin(rad - spread / 2) * 12;
    const x2 = cx + Math.cos(rad - spread / 2) * (12 + len);
    const y2 = cy + Math.sin(rad - spread / 2) * (12 + len);
    const x3 = cx + Math.cos(rad + spread / 2) * (12 + len);
    const y3 = cy + Math.sin(rad + spread / 2) * (12 + len);
    const x4 = cx + Math.cos(rad + spread / 2) * 12;
    const y4 = cy + Math.sin(rad + spread / 2) * 12;
    return {
      label: b.label,
      count: b.count,
      path: `M${x1} ${y1} L${x2} ${y2} A ${12 + len} ${12 + len} 0 0 1 ${x3} ${y3} L${x4} ${y4} Z`,
      lx: cx + Math.cos(rad) * (R + 14),
      ly: cy + Math.sin(rad) * (R + 14),
    };
  });
});

const steepCount = computed(() => props.joints.filter((j) => j.dipAngle >= 60).length);
</script>

<template>
  <div class="polar" data-testid="joint-polar-plot">
    <svg :viewBox="`0 0 ${SIZE} ${SIZE}`" width="100%" height="300" role="img" aria-label="节理极点图与走向玫瑰图">
      <circle :cx="SIZE / 2" :cy="SIZE / 2" :r="R" fill="#fbfcfd" stroke="#c8d0da" />
      <circle v-for="r in rings" :key="r" :cx="SIZE / 2" :cy="SIZE / 2" :r="r" fill="none" stroke="#e2e7ec" />
      <line :x1="SIZE / 2 - R" :y1="SIZE / 2" :x2="SIZE / 2 + R" :y2="SIZE / 2" stroke="#e2e7ec" />
      <line :x1="SIZE / 2" :y1="SIZE / 2 - R" :x2="SIZE / 2" :y2="SIZE / 2 + R" stroke="#e2e7ec" />
      <text :x="SIZE / 2" :y="14" text-anchor="middle" font-size="10" fill="#7b8592">N</text>
      <text :x="SIZE - 6" :y="SIZE / 2 + 4" text-anchor="end" font-size="10" fill="#7b8592">E</text>
      <text :x="SIZE / 2" :y="SIZE - 4" text-anchor="middle" font-size="10" fill="#7b8592">S</text>
      <text :x="6" :y="SIZE / 2 + 4" font-size="10" fill="#7b8592">W</text>

      <circle
        v-for="p in poles"
        :key="p.id"
        :cx="p.cx"
        :cy="p.cy"
        r="5"
        :fill="colorOf(p.setNo)"
        fill-opacity="0.85"
      />
      <text
        v-for="p in poles"
        :key="`t-${p.id}`"
        :x="p.cx + 7"
        :y="p.cy - 6"
        font-size="10"
        :fill="colorOf(p.setNo)"
      >
        J{{ p.setNo }}
      </text>
    </svg>

    <svg :viewBox="`0 0 ${SIZE} ${SIZE}`" width="100%" height="300" role="img" aria-label="走向玫瑰图">
      <circle :cx="SIZE / 2" :cy="SIZE / 2" :r="R" fill="#fbfcfd" stroke="#c8d0da" />
      <circle :cx="SIZE / 2" :cy="SIZE / 2" :r="R / 2" fill="none" stroke="#e2e7ec" />
      <g v-for="b in rose" :key="b.label">
        <path :d="b.path" fill="#2f8f5b" fill-opacity="0.55" stroke="#2f8f5b" />
        <text :x="b.lx" :y="b.ly" text-anchor="middle" font-size="9" fill="#5b6470">
          {{ b.label }}
        </text>
      </g>
    </svg>

    <div class="summary">
      <span>节理组 {{ joints.length }} 组 · 陡倾（≥60°）{{ steepCount }} 组</span>
      <span class="legend">
        <i v-for="j in joints" :key="j.id" :style="{ backgroundColor: colorOf(j.setNo) }">J{{ j.setNo }}</i>
      </span>
    </div>
  </div>
</template>

<style scoped>
.polar {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.summary {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: #5b6470;
}
.legend {
  display: flex;
  gap: 6px;
}
.legend i {
  font-style: normal;
  color: #fff;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 11px;
}
</style>
