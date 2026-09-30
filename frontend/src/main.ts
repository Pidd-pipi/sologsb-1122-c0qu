import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import App from './App.vue';
import router from './router';
import { ensureSeedData, markDbVersion } from './utils/db';
import { captureBaseSnapshot, readBaseSnapshot } from './utils/merge';

async function bootstrap() {
  // 先完成 IndexedDB 迁移与示范数据灌入，再挂载应用
  await ensureSeedData();
  markDbVersion();
  // 首次进入采集基准快照（离线编录的出发点），已有则保留
  if (Object.keys(readBaseSnapshot()).length === 0) {
    await captureBaseSnapshot();
  }

  const app = createApp(App);
  app.use(createPinia());
  app.use(router);
  app.use(ElementPlus, { locale: zhCn });
  app.mount('#app');
}

void bootstrap();
