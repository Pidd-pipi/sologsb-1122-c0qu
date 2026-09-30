import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import App from './App.vue';
import router from './router';
import { ensureSeedData, markDbVersion } from './utils/db';

async function bootstrap() {
  // 先完成 IndexedDB 迁移与示范数据灌入，再挂载应用
  await ensureSeedData();
  markDbVersion();

  const app = createApp(App);
  app.use(createPinia());
  app.use(router);
  app.use(ElementPlus, { locale: zhCn });
  app.mount('#app');
}

void bootstrap();
