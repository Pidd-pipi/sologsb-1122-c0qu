import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import FaceList from '../pages/FaceList.vue';
import FaceDetail from '../pages/FaceDetail.vue';
import JointEntry from '../pages/JointEntry.vue';
import WaterView from '../pages/WaterView.vue';
import GradeJudge from '../pages/GradeJudge.vue';
import SyncCenter from '../pages/SyncCenter.vue';

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/faces' },
  { path: '/faces', name: 'face-list', component: FaceList },
  { path: '/faces/:id', name: 'face-detail', component: FaceDetail },
  { path: '/faces/:id/joints', name: 'joint-entry', component: JointEntry },
  { path: '/faces/:id/water', name: 'water-view', component: WaterView },
  { path: '/grade/:faceId', name: 'grade-judge', component: GradeJudge },
  { path: '/sync', name: 'sync-center', component: SyncCenter },
  { path: '/:pathMatch(.*)*', redirect: '/faces' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
