import { db } from './db';
import { newId } from './id';
import type { TunnelFace } from '../types/face';
import type { JointSet } from '../types/joint';
import type { RockMassGrade } from '../types/grade';
import type { WaterInflow } from '../types/water';
import type {
  AnyRecord,
  AppliedChange,
  ConflictResolutions,
  ImportRecord,
  MergePreview,
  MergeStatus,
  ObjectConflict,
  PackageOp,
  PackageTable,
  StaleFace,
  WorkPackage,
} from '../types/package';

const BASE_SNAPSHOT_KEY = 'gbtunnelface:base-snapshot';

export const TABLES: PackageTable[] = ['faces', 'joints', 'grades', 'waters'];

type RecordMap = Record<string, AnyRecord>;

// ---------------------------------------------------------------------------
// 基准快照：记录离线编录出发时的全量数据，作业包据此算变更
// ---------------------------------------------------------------------------

export function readBaseSnapshot(): RecordMap {
  try {
    const raw = window.localStorage.getItem(BASE_SNAPSHOT_KEY);
    return raw ? (JSON.parse(raw) as RecordMap) : {};
  } catch {
    return {};
  }
}

export function saveBaseSnapshot(records: RecordMap): void {
  try {
    window.localStorage.setItem(BASE_SNAPSHOT_KEY, JSON.stringify(records));
  } catch {
    /* 存储不可用时忽略 */
  }
}

/** 采集当前全量数据作为基准快照 */
export async function captureBaseSnapshot(): Promise<RecordMap> {
  const [faces, joints, grades, waters] = await Promise.all([
    db.faces.toArray(),
    db.joints.toArray(),
    db.grades.toArray(),
    db.waters.toArray(),
  ]);
  const map: RecordMap = {};
  for (const r of [...faces, ...joints, ...grades, ...waters]) {
    map[r.id] = r;
  }
  saveBaseSnapshot(map);
  return map;
}

// ---------------------------------------------------------------------------
// 记录读写
// ---------------------------------------------------------------------------

async function getAllRecords(): Promise<RecordMap> {
  const [faces, joints, grades, waters] = await Promise.all([
    db.faces.toArray(),
    db.joints.toArray(),
    db.grades.toArray(),
    db.waters.toArray(),
  ]);
  const map: RecordMap = {};
  for (const r of [...faces, ...joints, ...grades, ...waters]) {
    map[r.id] = r;
  }
  return map;
}

function tableOf(record: AnyRecord): PackageTable {
  if ('faceNo' in record) return 'faces';
  if ('setNo' in record) return 'joints';
  if ('bqValue' in record) return 'grades';
  return 'waters';
}

function faceIdOf(record: AnyRecord): string | undefined {
  if (tableOf(record) === 'faces') return (record as TunnelFace).id;
  return (record as JointSet | RockMassGrade | WaterInflow).faceId;
}

function labelOf(record: AnyRecord): string {
  const table = tableOf(record);
  if (table === 'faces') {
    const f = record as TunnelFace;
    return `${f.faceNo}（${f.lithology}，${f.chainage} m）`;
  }
  if (table === 'joints') {
    const j = record as JointSet;
    return `J${j.setNo}（${j.dipDirection}°∠${j.dipAngle}°）`;
  }
  if (table === 'grades') {
    const g = record as RockMassGrade;
    return `${g.grade} 级判定（${new Date(g.judgedAt).toLocaleString('zh-CN')}）`;
  }
  const w = record as WaterInflow;
  return `${w.position} ${w.type} ${w.estimatedFlow}L/min`;
}

// ---------------------------------------------------------------------------
// 作业包构建：对比基准快照，只打包变更记录
// ---------------------------------------------------------------------------

export async function buildPackage(geologist: string, note = ''): Promise<WorkPackage> {
  const base = readBaseSnapshot();
  if (Object.keys(base).length === 0) {
    // 没有基准快照时先采集，保证作业包带得出去、合得回来
    await captureBaseSnapshot();
  }
  const baseMap = readBaseSnapshot();
  const current = await getAllRecords();

  const ops: PackageOp[] = [];
  const bases: RecordMap = {};
  const faceVersions: Record<string, number> = {};
  let seq = 0;

  // 掌子面版本：取基准中各掌子面的版本
  for (const r of Object.values(baseMap)) {
    if (tableOf(r) === 'faces') {
      faceVersions[r.id] = (r as TunnelFace).version ?? 1;
    }
  }

  // 变更：当前有而基准无 / 两边都有但内容不同 → upsert
  for (const [id, record] of Object.entries(current)) {
    const before = baseMap[id];
    if (!before || JSON.stringify(before) !== JSON.stringify(record)) {
      ops.push({ seq: ++seq, kind: 'upsert', table: tableOf(record), id, record });
      if (before) bases[id] = before;
    }
  }
  // 删除：基准有而当前无 → delete
  for (const [id, record] of Object.entries(baseMap)) {
    if (!current[id]) {
      ops.push({ seq: ++seq, kind: 'delete', table: tableOf(record), id });
      bases[id] = record;
    }
  }

  // 按操作顺序排序（upsert 在前，delete 在后；同类按 seq）
  ops.sort((a, b) => a.seq - b.seq);

  return {
    id: newId('pkg'),
    packageNo: `PKG-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(seq).padStart(3, '0')}`,
    geologist: geologist.trim() || '未署名',
    createdAt: Date.now(),
    note: note.trim() || undefined,
    ops,
    bases,
    faceVersions,
  };
}

// ---------------------------------------------------------------------------
// 内容哈希：只哈希有效负载，重复导出同一份作业不产生新计数
// ---------------------------------------------------------------------------

/** 简单字符串哈希（cyrb53），作为 crypto.subtle 不可用时的兜底 */
function simpleHash(str: string): string {
  let h1 = 0xdeadbeef ^ 0x9e3779b9;
  let h2 = 0x41c6ce57 ^ 0x85ebca6b;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(16, '0');
}

export async function computeContentHash(pkg: WorkPackage): Promise<string> {
  const payload = JSON.stringify({
    ops: pkg.ops.map((o) => ({ seq: o.seq, kind: o.kind, table: o.table, id: o.id, record: o.record ?? null })),
    bases: pkg.bases,
    faceVersions: pkg.faceVersions,
  });
  try {
    if (globalThis.crypto?.subtle) {
      const buf = new TextEncoder().encode(payload);
      const digest = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
  } catch {
    /* 降级到简单哈希 */
  }
  return simpleHash(payload);
}

// ---------------------------------------------------------------------------
// 字段级冲突
// ---------------------------------------------------------------------------

const FIELD_LABELS: Record<string, string> = {
  faceNo: '掌子面编号',
  chainage: '里程桩号',
  mileageRange: '编录里程区间',
  excavationMethod: '开挖方式',
  faceSize: '断面尺寸',
  lithology: '岩性',
  weathering: '风化程度',
  rockStrength: '饱和抗压强度',
  attitude: '岩层产状',
  geologist: '地质员',
  version: '版本',
  setNo: '组号',
  dipDirection: '倾向',
  dipAngle: '倾角',
  spacing: '间距',
  persistence: '延伸长度',
  aperture: '张开度',
  fillMaterial: '充填物',
  roughness: '粗糙度',
  waterWet: '渗水状态',
  jointCount: '条数',
  grade: '围岩级别',
  bqValue: 'BQ',
  rqd: 'RQD',
  jv: 'Jv',
  kv: 'Kv',
  groundwater: '出水状态',
  spanWidth: '洞跨',
  correction: '修正系数',
  correctedBq: '修正后[BQ]',
  supportSuggestion: '支护建议',
  manualAdjusted: '人工修正',
  judgedAt: '判定时间',
  position: '出水部位',
  type: '出水类型',
  estimatedFlow: '估算涌水量',
  waterTemp: '水温',
  waterPressure: '水压',
  changeTrend: '变化趋势',
  measuredAt: '量测时间',
};

function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

function buildFieldConflicts(base: AnyRecord, local: AnyRecord, incoming: AnyRecord): ObjectConflict['fields'] {
  const fields: ObjectConflict['fields'] = [];
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(incoming)]);
  for (const key of keys) {
    if (key === 'id' || key === 'version') continue;
    const b = (base as unknown as Record<string, unknown>)[key];
    const l = (local as unknown as Record<string, unknown>)[key];
    const i = (incoming as unknown as Record<string, unknown>)[key];
    const localChanged = JSON.stringify(b) !== JSON.stringify(l);
    const incomingChanged = JSON.stringify(b) !== JSON.stringify(i);
    // 只有两边都改了同一字段且取值不同才算冲突
    if (localChanged && incomingChanged && JSON.stringify(l) !== JSON.stringify(i)) {
      fields.push({ field: key, label: fieldLabel(key), base: b, local: l, incoming: i });
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// 合并预览：三方合并，识别冲突与过期掌子面
// ---------------------------------------------------------------------------

export async function previewMerge(pkg: WorkPackage): Promise<MergePreview> {
  // 重复导入检查
  const contentHash = await computeContentHash(pkg);
  const imports = await db.imports.toArray();
  const dup = imports.find((r) => r.packageId === pkg.id || r.contentHash === contentHash);
  if (dup) {
    return {
      status: 'duplicate',
      autoApplied: [],
      conflicts: [],
      staleFaces: [],
      duplicate: { importedAt: dup.importedAt, packageNo: dup.packageNo, geologist: dup.geologist },
    };
  }

  const current = await getAllRecords();
  const autoApplied: AppliedChange[] = [];
  const conflicts: ObjectConflict[] = [];
  const staleFaces: StaleFace[] = [];

  // 先识别过期掌子面：包改了掌子面关键字段，且本地版本 > 包基于的版本
  for (const op of pkg.ops) {
    if (op.table !== 'faces' || op.kind !== 'upsert' || !op.record) continue;
    const incoming = op.record as TunnelFace;
    const local = current[op.id] as TunnelFace | undefined;
    const base = pkg.bases[op.id] as TunnelFace | undefined;
    if (!local || !base) continue;
    const baseVersion = pkg.faceVersions[op.id] ?? base.version ?? 1;
    const localVersion = local.version ?? 1;
    const incomingChanged = JSON.stringify(base) !== JSON.stringify(incoming);
    if (incomingChanged && localVersion > baseVersion) {
      staleFaces.push({
        faceId: op.id,
        faceNo: incoming.faceNo,
        baseVersion,
        localVersion,
        affected: [],
      });
    }
  }

  // 收集过期掌子面影响的内容
  for (const sf of staleFaces) {
    for (const op of pkg.ops) {
      if (op.table === 'faces' && op.id === sf.faceId) {
        sf.affected.push({ table: 'faces', id: op.id, label: sf.faceNo, reason: '掌子面关键字段被两边修改' });
      } else {
        const rec = op.record ?? pkg.bases[op.id];
        if (rec && faceIdOf(rec) === sf.faceId) {
          sf.affected.push({
            table: op.table,
            id: op.id,
            label: labelOf(rec),
            reason: '该掌子面已过期，子记录合并需人工确认',
          });
        }
      }
    }
  }

  // 逐操作三方合并
  for (const op of pkg.ops) {
    const local = current[op.id];
    const base = pkg.bases[op.id];
    const incoming = op.record;

    if (op.kind === 'delete') {
      if (!local) {
        autoApplied.push({ table: op.table, id: op.id, label: labelOf(base ?? { id: op.id } as AnyRecord), action: 'deleted' });
        continue;
      }
      if (base && JSON.stringify(local) === JSON.stringify(base)) {
        autoApplied.push({ table: op.table, id: op.id, label: labelOf(local), action: 'deleted' });
      } else {
        // 本地改了又要删 → 冲突
        conflicts.push({
          key: `${op.table}:${op.id}`,
          table: op.table,
          id: op.id,
          objectLabel: labelOf(local),
          faceId: faceIdOf(local),
          fields: buildFieldConflicts(base ?? local, local, base ?? local),
          existedInBase: !!base,
        });
      }
      continue;
    }

    // upsert
    if (!local) {
      // 本地没有 → 直接并入（新建）
      autoApplied.push({ table: op.table, id: op.id, label: labelOf(incoming!), action: 'created' });
      continue;
    }
    if (!base) {
      // 两边各自新建了同 id 对象 → 冲突
      conflicts.push({
        key: `${op.table}:${op.id}`,
        table: op.table,
        id: op.id,
        objectLabel: labelOf(incoming!),
        faceId: faceIdOf(incoming!),
        fields: buildFieldConflicts(local, local, incoming!),
        existedInBase: false,
      });
      continue;
    }

    const localChanged = JSON.stringify(local) !== JSON.stringify(base);
    const incomingChanged = JSON.stringify(incoming) !== JSON.stringify(base);

    if (!localChanged && !incomingChanged) {
      autoApplied.push({ table: op.table, id: op.id, label: labelOf(local), action: 'updated' });
    } else if (localChanged && !incomingChanged) {
      autoApplied.push({ table: op.table, id: op.id, label: labelOf(local), action: 'updated' });
    } else if (!localChanged && incomingChanged) {
      autoApplied.push({ table: op.table, id: op.id, label: labelOf(incoming!), action: 'updated' });
    } else {
      // 两边都改了 → 冲突
      const fields = buildFieldConflicts(base, local, incoming!);
      if (fields.length === 0) {
        autoApplied.push({ table: op.table, id: op.id, label: labelOf(local), action: 'updated' });
      } else {
        conflicts.push({
          key: `${op.table}:${op.id}`,
          table: op.table,
          id: op.id,
          objectLabel: labelOf(local),
          faceId: faceIdOf(local),
          fields,
          existedInBase: true,
        });
      }
    }
  }

  // 过期掌子面本身算冲突（按字段选择），子记录若也在过期面下则升级为冲突
  for (const sf of staleFaces) {
    const op = pkg.ops.find((o) => o.table === 'faces' && o.id === sf.faceId);
    if (op?.record) {
      const local = current[op.id] as TunnelFace;
      const base = pkg.bases[op.id] as TunnelFace;
      const fields = buildFieldConflicts(base, local, op.record as TunnelFace);
      conflicts.push({
        key: `faces:${op.id}`,
        table: 'faces',
        id: op.id,
        objectLabel: sf.faceNo,
        faceId: op.id,
        faceNo: sf.faceNo,
        fields,
        existedInBase: true,
      });
    }
  }

  const status: MergeStatus =
    staleFaces.length > 0 ? 'stale' : conflicts.length > 0 ? 'conflicts' : 'clean';

  return { status, autoApplied, conflicts, staleFaces };
}

// ---------------------------------------------------------------------------
// 应用合并：事务执行，失败回滚，保留本机原记录
// ---------------------------------------------------------------------------

export async function applyMerge(
  pkg: WorkPackage,
  resolutions: ConflictResolutions,
): Promise<{ applied: AppliedChange[] }> {
  const contentHash = await computeContentHash(pkg);
  const current = await getAllRecords();
  const applied: AppliedChange[] = [];

  // 收集要写入/删除的记录
  const puts: { table: PackageTable; record: AnyRecord; isNew: boolean }[] = [];
  const deletes: { table: PackageTable; id: string; label: string }[] = [];

  for (const op of pkg.ops) {
    const local = current[op.id];
    const base = pkg.bases[op.id];
    const key = `${op.table}:${op.id}`;
    const resolution = resolutions[key];

    if (op.kind === 'delete') {
      if (!local) continue;
      if (base && JSON.stringify(local) === JSON.stringify(base)) {
        deletes.push({ table: op.table, id: op.id, label: labelOf(local) });
      } else if (resolution === 'incoming') {
        deletes.push({ table: op.table, id: op.id, label: labelOf(local) });
      }
      continue;
    }

    // upsert
    if (!local) {
      puts.push({ table: op.table, record: op.record!, isNew: true });
      continue;
    }
    if (!base) {
      // 两边新建同 id：按选择
      if (resolution === 'incoming') {
        puts.push({ table: op.table, record: op.record!, isNew: false });
      }
      continue;
    }

    const localChanged = JSON.stringify(local) !== JSON.stringify(base);
    const incomingChanged = JSON.stringify(op.record) !== JSON.stringify(base);

    if (!localChanged && !incomingChanged) continue;
    if (localChanged && !incomingChanged) continue; // 保留本机
    if (!localChanged && incomingChanged) {
      puts.push({ table: op.table, record: op.record!, isNew: false });
      continue;
    }
    // 两边都改了
    if (resolution === 'incoming') {
      puts.push({ table: op.table, record: op.record!, isNew: false });
    } else {
      // 默认保留本机
      continue;
    }
  }

  // 掌子面版本号：新建为 1，更新则在本机版本基础上递增
  for (const p of puts) {
    if (p.table === 'faces') {
      const face = p.record as TunnelFace;
      const local = current[face.id] as TunnelFace | undefined;
      p.record = { ...face, version: local ? (local.version ?? 1) + 1 : 1 } as TunnelFace;
    }
  }

  // 事务执行
  const txTables = [db.faces, db.joints, db.grades, db.waters, db.imports];
  await db.transaction('rw', txTables, async () => {
    for (const p of puts) {
      await tableBulkPut(p.table, p.record);
      applied.push({
        table: p.table,
        id: p.record.id,
        label: labelOf(p.record),
        action: p.isNew ? 'created' : 'updated',
      });
    }
    for (const d of deletes) {
      await tableDelete(d.table, d.id);
      applied.push({ table: d.table, id: d.id, label: d.label, action: 'deleted' });
    }
    // 记录导入台账（幂等）
    const record: ImportRecord = {
      id: newId('imp'),
      packageId: pkg.id,
      contentHash,
      packageNo: pkg.packageNo,
      geologist: pkg.geologist,
      importedAt: Date.now(),
      appliedCount: applied.length,
    };
    await db.imports.put(record);
  });

  return { applied };
}

async function tableBulkPut(table: PackageTable, record: AnyRecord): Promise<void> {
  if (table === 'faces') await db.faces.put(record as TunnelFace);
  else if (table === 'joints') await db.joints.put(record as JointSet);
  else if (table === 'grades') await db.grades.put(record as RockMassGrade);
  else await db.waters.put(record as WaterInflow);
}

async function tableDelete(table: PackageTable, id: string): Promise<void> {
  if (table === 'faces') await db.faces.delete(id);
  else if (table === 'joints') await db.joints.delete(id);
  else if (table === 'grades') await db.grades.delete(id);
  else await db.waters.delete(id);
}

// ---------------------------------------------------------------------------
// 导入历史
// ---------------------------------------------------------------------------

export async function listImports(): Promise<ImportRecord[]> {
  const rows = await db.imports.toArray();
  return rows.sort((a, b) => b.importedAt - a.importedAt);
}

// ---------------------------------------------------------------------------
// 解析作业包文件
// ---------------------------------------------------------------------------

export function parsePackageJson(text: string): WorkPackage {
  const data = JSON.parse(text) as WorkPackage;
  if (!data || typeof data !== 'object' || !Array.isArray(data.ops) || !data.bases) {
    throw new Error('作业包格式不正确：缺少 ops / bases 字段');
  }
  if (!data.id || !data.packageNo) {
    throw new Error('作业包格式不正确：缺少 id / packageNo 字段');
  }
  return data;
}

/** 把作业包序列化为可下载的 JSON 文件 */
export function packageToJson(pkg: WorkPackage): string {
  return JSON.stringify(pkg, null, 2);
}
