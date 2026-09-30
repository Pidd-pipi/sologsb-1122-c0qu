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
| 本地存储 | IndexedDB（Dexie 4）+ localStorage（设备 id / 地质员署名），v3 起带版本向量、操作日志与升级迁移 |
| 离线测试 | Vitest 2 + fake-indexeddb（`npm test`，14 个合并引擎端到端用例） |

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
        ├── types/{face,joint,grade,water,sync}.ts
        ├── stores/{face,joint,grade}Store.ts
        ├── components/common/{SketchCanvas,JointPolarPlot,GradeTag,FaceCard}.vue
        ├── hooks/{useFaceFilter,useGradeCalc}.ts
        ├── pages/{FaceList,FaceDetail,JointEntry,WaterView,GradeJudge,SyncCenter}.vue
        ├── utils/{db,geoMath,id,merge,syncRepo}.ts
        ├── __tests__/merge.test.ts
        └── vitest.setup.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/faces` | 掌子面台账：里程区间/岩性/围岩级别/开挖方式筛选 + 级别分布条 | TunnelFace、RockMassGrade |
| `/faces/:id` | 掌子面详情：基本信息 + 岩性素描图 + 节理组列表 + 与上循环级别比对 | TunnelFace、JointSet、RockMassGrade |
| `/faces/:id/joints` | 节理产状录入：极点图/玫瑰图、同组产状合并、异常倾角提示 | JointSet |
| `/faces/:id/water` | 涌水记录与沿里程趋势折线，标记突变点与建议措施 | WaterInflow |
| `/grade/:faceId` | 围岩级别判定：逐项输入 RQD/Jv/Kv/出水状态，实时算级别与支护建议，可人工修正并保存 | RockMassGrade、TunnelFace |
| `/sync` | 作业包与离线合并：导出/导入作业包、冲突人工裁决、过期拒绝与合并回执 | 全部表 + oplog/applied |

`/` 重定向到 `/faces`，未匹配路由同样兜底到 `/faces`。

## 数据存储说明

- 数据库名 `gbtunnelface`，当前结构版本 **v3**（`localStorage['gbtunnelface:db-version']` 记录）。
- 业务表：`faces`（掌子面）、`joints`（节理组）、`grades`（围岩级别判定）、`waters`（涌水记录）、`sketches`（岩性素描文档，v3 起从 localStorage 迁入）。
- 协作表：`oplog`（本机有序操作日志，含操作前快照 base）、`applied`（已合并作业包回执，去重用）、`kv`（同步状态）。
- v1 → v2 迁移：为老掌子面补 `attitude`、`mileageRange`，为级别记录补 `correctedBq`、`manualAdjusted`，为涌水补 `chainage`，并新增索引。
- v2 → v3 迁移：为全部业务记录补版本向量 `_sync.vv`（设备 id → 序号），把 `localStorage['gbtunnelface:sketch:<faceId>']` 线段迁入 `sketches` 表，初始化本机设备 id 与同步状态。
- 所有业务写入只经 `utils/syncRepo.ts`：同一事务内「落库 + 追加操作日志 + 推进版本向量」，删除掌子面连带删除子记录并各自记日志。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 个示范掌子面、4 组节理、1 条级别判定与 3 条涌水记录（均带初始版本向量与操作日志）。

## 断网协作：作业包与离线合并（`/sync`）

两名地质员在隧道内断网编录同一掌子面，回到有网环境后通过「作业包」交换合并，**全程本机完成、不上传服务器**：

1. **导出**：`/sync` 页填写本机地质员署名后「导出我的作业包 (.json)」。作业包含 `schemaVersion`、导出设备、`packageId`、**每个掌子面的聚合版本向量**（掌子面本身 + 节理/级别/涌水/素描版本逐分量取最大），以及**按 seq 排列的有序操作日志**（含共同基线快照 base）。
2. **导入预检**：选择同伴的作业包后，先由纯函数引擎 `utils/merge.ts` 生成「合并计划」，不直接写库：
   - **重复导入**：`packageId` 已在 `applied` 表 → 拒绝并提示原合并时间，不重复计数；
   - **结构版本过期**：包 `schemaVersion` 高于本机 → 整包拒绝；
   - **作业包版本过期**：对方设备水位已覆盖，或所改掌子面版本是本机严格子集 → 整包拒绝，并逐条列出受影响的掌子面与子记录；
   - **不能合并自己导出的包**（设备标识一致）。
3. **冲突人工裁决**：
   - 不同对象（新掌子面 / 不撞自然键的记录）**直接并入**；自然键映射：掌子面按编号、节理组按 `(掌子面, 组号)`、素描按掌子面；
   - 同一记录版本分叉时做 **base/local/remote 三方比对**；同一掌子面**关键字段**（编号、里程、开挖方式、断面、岩性、风化、强度、产状）或同一节理组关键字段（组号、倾向、倾角）两边都改且不一致 → 列出原值/本机值/对方值供逐字段选择；非关键字段一边改自动取改方；
   - 对方删除而本机改过 → 选择「保留本机」或「按对方删除」；同编号各自新建 → 二选一（采用对方时沿用本机 id，子记录归属不变）；
   - 岩性素描按**线段并集**（不同 id 线段直接并入）。
4. **执行**：确认后在**单事务**内落库并写回执；任何一步失败整体回滚，**本机原记录保留**，冲突选择与计划保留，可直接重试。成功后通过 `onDataChange` 通知，台账、详情、涌水趋势、围岩级别判定统一重读**同一份合并结果**。
5. **级别判定消费合并结果**：级别判定读取的节理、涌水均来自合并后的同一数据源。


## 功能要点

- **围岩级别实时判定**：`BQ = 90 + 3σc + 250Kv`，`[BQ] = BQ − 100(K1 + K2 + K3)`（K1 由出水状态、K2 由洞跨取值），再按 >550/451~550/351~450/251~350/151~250/≤150 映射到 Ⅰ~Ⅵ 级，并给出对应支护建议；支持人工修正级别。
- **级别比对**：详情页与判定页自动与上一循环级别比对，输出「变好/变差 N 级」结论。
- **素描交互**：`<SketchCanvas>` 在图上单击即按当前岩层产状布置结构面线段，带岩性填充纹样、比例尺、图例与撤销/清空，线段本地持久化。
- **节理统计**：`<JointPolarPlot>` 等面积投影极点图 + 走向玫瑰图，按组着色；按倾向 30° 聚类支持同组产状合并。
- **异常提示**：倾角超出 0~90° 直接拦截；涌水量较上一点翻倍或趋势突增标记为突变点并给出措施。
