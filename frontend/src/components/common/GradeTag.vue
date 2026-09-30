<script setup lang="ts">
import { computed } from 'vue';
import { GRADE_COLOR, type RockGrade } from '../../types/grade';

const props = defineProps<{
  grade?: RockGrade;
  /** 直接给文案时忽略 grade */
  label?: string;
}>();

const color = computed(() => (props.grade ? GRADE_COLOR[props.grade] : '#7b8592'));
const text = computed(() => props.label ?? (props.grade ? `${props.grade} 级围岩` : '未判定'));
</script>

<template>
  <span class="grade-tag" :style="{ backgroundColor: color }" :data-testid="`grade-tag-${props.grade ?? 'na'}`">
    {{ text }}
  </span>
</template>

<style scoped>
.grade-tag {
  display: inline-block;
  padding: 1px 10px;
  border-radius: 10px;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  line-height: 20px;
  white-space: nowrap;
}
</style>
