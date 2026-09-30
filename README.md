# sologsb-1122 隧道掌子面地质编录台（gbtunnelface）

面向隧道施工地质人员的掌子面编录工作台：逐循环编录围岩级别、岩性、节理产状与涌水情况，绘制岩性素描并用数字表示结构面，实时按 BQ 指标判定围岩级别并给出支护建议。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21822**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3 + TypeScript（`<script setup>`） |
| UI | Element Plus 2 |
| 构建 | Vite 5 |
| 状态管理 | Pinia |
| 路由 | Vue Router 4（history 模式） |
| 本地存储 | IndexedDB（Dexie 4）+ localStorage（素描线段），含结构版本号与升级迁移 |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # vue-tsc 类型检查 + vite 构建
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1122/
├── docker-compose.yml
├── .env.example
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.ts
        ├── App.vue
        ├── router/index.ts
        ├── types/{face,joint,grade,water,package}.ts
        ├── stores/{face,joint,grade,merge}Store.ts
        ├── components/common/{SketchCanvas,JointPolarPlot,GradeTag,FaceCard}.vue
        ├── hooks/{useFaceFilter,useGradeCalc}.ts
        ├── pages/{FaceList,FaceDetail,JointEntry,WaterView,GradeJudge,MergeCenter}.vue
        └── utils/{db,geoMath,id,merge}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/faces` | 掌子面台账：里程区间/岩性/围岩级别/开挖方式筛选 + 级别分布条 | TunnelFace、RockMassGrade |
| `/faces/:id` | 掌子面详情：基本信息 + 岩性素描图 + 节理组列表 + 与上循环级别比对 | TunnelFace、JointSet、RockMassGrade |
| `/faces/:id/joints` | 节理产状录入：极点图/玫瑰图、同组产状合并、异常倾角提示 | JointSet |
| `/faces/:id/water` | 涌水记录与沿里程趋势折线，标记突变点与建议措施 | WaterInflow |
| `/grade/:faceId` | 围岩级别判定：逐项输入 RQD/Jv/Kv/出水状态，实时算级别与支护建议，可人工修正并保存 | RockMassGrade、TunnelFace |
| `/merge` | 离线作业包合并：导出作业包、导入预览、冲突选择、过期拒绝、导入历史 | WorkPackage、TunnelFace、JointSet |

`/` 重定向到 `/faces`，未匹配路由同样兜底到 `/faces`。

## 数据存储说明

- 数据库名 `gbtunnelface`，当前结构版本 **v3**（`localStorage['gbtunnelface:db-version']` 记录）。
- 五张表：`faces`（掌子面，含 `version` 版本号）、`joints`（节理组）、`grades`（围岩级别判定）、`waters`（涌水记录）、`imports`（作业包导入台账，幂等用）。
- v1 → v2 迁移：为老掌子面补 `attitude`、`mileageRange`，为级别记录补 `correctedBq`、`manualAdjusted`，为涌水补 `chainage`，并新增索引。
- v2 → v3 迁移：为老掌子面补 `version`（默认 1），新增 `imports` 表与索引。
- 岩性素描的结构面线段单独存 `localStorage['gbtunnelface:sketch:<faceId>']`，刷新后仍在。
- 离线编录基准快照存 `localStorage['gbtunnelface:base-snapshot']`，记录出发时全量数据，作业包据此算变更。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 个示范掌子面、4 组节理、1 条级别判定与 3 条涌水记录。

## 离线作业包合并（断网编录 · 回来合并）

两名地质员在隧道内断网编录同一掌子面，回来后不再整份覆盖，而是各自导出作业包再离线合并。

- **作业包**：每次编录导出为一个 JSON 作业包，含掌子面版本（`faceVersions`）与操作顺序（`ops`，按 `seq` 递增），并携带基准快照（`bases`）。
- **不同对象直接并入**：新增的掌子面/节理组/涌水记录/级别判定，以及只被一方修改的记录，合并时直接并入。
- **冲突让人选择**：同一掌子面关键字段（编号/里程/岩性/产状等）或同一节理组两边都改过时，按字段列出「基准 / 本机 / 作业包」对比，人工选择保留本机或采用作业包。
- **版本过期拒绝合并**：作业包基于的掌子面版本旧于本机当前版本时，拒绝合并并列出受影响内容（掌子面字段 + 子记录），确认后可按冲突选择再重试。
- **重复导入不重复计数**：每个作业包按 `packageId` 与内容哈希（SHA-256，不可用时降级为字符串哈希）去重，重复导入只提示不并入。
- **合并失败可重试**：合并在 Dexie 事务内执行，失败即回滚，本机原记录完整保留，可调整后重试。
- **读到同一份合并结果**：合并成功后自动重载 `faceStore` / `jointStore` / `gradeStore`，台账、详情、涌水趋势、围岩级别判定均从 IndexedDB 读取同一份合并后数据。
- **模拟两台设备**：页面右上角「重置演示数据」可清空并恢复初始示范数据，配合「导出作业包」即可演示两名地质员从同一基准出发、各自编录后合并的完整流程。

## 功能要点

- **围岩级别实时判定**：`BQ = 90 + 3σc + 250Kv`，`[BQ] = BQ − 100(K1 + K2 + K3)`（K1 由出水状态、K2 由洞跨取值），再按 >550/451~550/351~450/251~350/151~250/≤150 映射到 Ⅰ~Ⅵ 级，并给出对应支护建议；支持人工修正级别。
- **级别比对**：详情页与判定页自动与上一循环级别比对，输出「变好/变差 N 级」结论。
- **素描交互**：`<SketchCanvas>` 在图上单击即按当前岩层产状布置结构面线段，带岩性填充纹样、比例尺、图例与撤销/清空，线段本地持久化。
- **节理统计**：`<JointPolarPlot>` 等面积投影极点图 + 走向玫瑰图，按组着色；按倾向 30° 聚类支持同组产状合并。
- **异常提示**：倾角超出 0~90° 直接拦截；涌水量较上一点翻倍或趋势突增标记为突变点并给出措施。
