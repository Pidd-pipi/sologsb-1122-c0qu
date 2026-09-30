<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { readDbVersion } from './utils/db';

const route = useRoute();
const router = useRouter();

const activeMenu = computed(() => {
  if (route.path.startsWith('/merge')) return '/merge';
  if (route.path.startsWith('/faces')) {
    if (route.path.endsWith('/joints')) return '/faces/joints';
    if (route.path.endsWith('/water')) return '/faces/water';
    return '/faces';
  }
  if (route.path.startsWith('/grade')) return '/grade';
  return '/faces';
});

const version = readDbVersion();

function onSelect(index: string) {
  if (index === '/faces/joints' || index === '/faces/water' || index === '/grade') {
    // 这三项依赖具体掌子面，进入台账让用户选择
    void router.push('/faces');
    return;
  }
  void router.push(index);
}
</script>

<template>
  <el-container class="app">
    <el-header class="app-header">
      <div class="brand">隧道掌子面地质编录台</div>
      <el-menu :default-active="activeMenu" mode="horizontal" class="menu" @select="onSelect">
        <el-menu-item index="/faces">掌子面台账</el-menu-item>
        <el-menu-item index="/faces/joints">节理产状</el-menu-item>
        <el-menu-item index="/faces/water">涌水记录</el-menu-item>
        <el-menu-item index="/grade">围岩级别</el-menu-item>
        <el-menu-item index="/merge">离线合并</el-menu-item>
      </el-menu>
      <el-tag size="small" effect="plain">本地结构版本 v{{ version }}</el-tag>
    </el-header>
    <el-main class="app-main">
      <router-view />
    </el-main>
  </el-container>
</template>

<style scoped>
.app {
  min-height: 100vh;
  background: #f5f6f8;
}
.app-header {
  display: flex;
  align-items: center;
  gap: 18px;
  background: #3b3f46;
  color: #f4f6f8;
  height: 60px;
}
.brand {
  font-size: 18px;
  font-weight: 700;
  white-space: nowrap;
}
.menu {
  flex: 1;
  border-bottom: none;
  background: transparent;
}
:deep(.menu .el-menu-item) {
  color: #d6dde5;
}
:deep(.menu .el-menu-item.is-active) {
  color: #ffffff;
  border-bottom-color: #e0b463;
}
.app-main {
  padding: 18px 22px 40px;
}
</style>
