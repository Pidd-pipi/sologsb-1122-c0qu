/**
 * 同步仓储：所有业务写入的唯一入口。
 * 每次写入都在同一事务内完成「落库 + 追加操作日志 + 推进版本向量」，
 * 保证断网期间的改动可追溯、可导出、可按序合并。
 */
import { db, toPlain, getDeviceId, getLocalGeologist, DB_VERSION } from './db';
import { newId } from './id';
import type {
  AppliedPackage,
  EntityTable,
  LogOp,
  SketchDoc,
  SyncEntity,
  SyncMeta,
  SyncState,
  VersionVector,
  WorkPackage,
  FaceVersionInfo,
  MergePlan,
  MergeReport,
} from '../types/sync';
import { mergeVV, aggregateFaceVersion } from './merge';
import type { LocalSnapshot } from './merge';

const STATE_KEY = 'syncState';
const ENTITY_TABLE_NAMES: EntityTable[] = ['faces', 'joints', 'grades', 'waters', 'sketches'];

/* ---------------- 数据变更通知（合并成功后通知各页面/Store 重读） ---------------- */

type Listener = () => void;
const listeners = new Set<Listener>();

export function onDataChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emitDataChange(): void {
  listeners.forEach((cb) => cb());
}

/* ---------------- 同步状态 ---------------- */

const defaultState = (): SyncState => ({
  deviceId: getDeviceId(),
  geologist: getLocalGeologist(),
  seq: 0,
  lastExportSeq: 0,
  ops: [],
  appliedSeqs: {},
});

export async function getSyncState(): Promise<SyncState> {
  const row = await db.kv.get(STATE_KEY);
  return (row?.value as SyncState) ?? defaultState();
}

export async function saveSyncState(state: SyncState): Promise<void> {
  await db.kv.put({ key: STATE_KEY, value: state });
}

export async function ensureSyncState(): Promise<SyncState> {
  const existing = await db.kv.get(STATE_KEY);
  if (existing?.value) return existing.value as SyncState;
  const state = defaultState();
  await saveSyncState(state);
  return state;
}

/** 把每条业务记录的 _sync 版本向量各分量 +1 */
function nextMeta(base: SyncMeta | undefined, state: SyncState, at = Date.now()): SyncMeta {
  const vv: VersionVector = mergeVV(base?.vv ?? {}, { [state.deviceId]: (base?.vv[state.deviceId] ?? 0) + 1 });
  return { deviceId: state.deviceId, vv, updatedAt: at };
}

/* ---------------- 本机写入（带日志） ---------------- */

function faceRefOf(table: EntityTable, row: Record<string, unknown>): string {
  if (table === 'faces') return String(row.id);
  if (table === 'sketches') return String(row.faceId ?? row.id);
  return String(row.faceId ?? '');
}

/** 新增或更新一条业务记录（调用方提供含 id 的完整行），返回落库后的行 */
export async function upsertEntity<T extends SyncEntity>(
  table: EntityTable,
  row: T,
  geologist?: string,
): Promise<T> {
  const state = await getSyncState();
  const plain = toPlain(row) as unknown as Record<string, unknown>;
  const recordId = String(plain.id);
  const baseTable = db.table(table);
  const base = (await baseTable.get(recordId)) as SyncEntity | undefined;
  const meta = nextMeta(base?._sync, state);
  plain._sync = meta;
  state.seq += 1;
  const op: LogOp = {
    seq: state.seq,
    deviceId: state.deviceId,
    geologist: geologist ?? getLocalGeologist() ?? String(plain.geologist ?? ''),
    table,
    recordId,
    faceRef: faceRefOf(table, plain),
    op: 'upsert',
    after: plain as unknown as SyncEntity,
    base: base ?? null,
    at: meta.updatedAt,
  };

  await db.transaction('rw', baseTable, db.oplog, db.kv, async () => {
    await baseTable.put(plain);
    await db.oplog.put(op);
    await saveSyncState(state);
  });
  emitDataChange();
  return plain as T;
}

/** 删除一条业务记录（掌子面连带删除子记录，各自记 delete 日志） */
export async function removeEntity(table: EntityTable, id: string): Promise<void> {
  const state = await getSyncState();
  const baseTable = db.table(table);
  const base = (await baseTable.get(id)) as SyncEntity | undefined;
  if (!base) {
    await baseTable.delete(id);
    return;
  }
  const ops: LogOp[] = [];
  const pushDelete = (t: EntityTable, b: SyncEntity): void => {
    state.seq += 1;
    ops.push({
      seq: state.seq,
      deviceId: state.deviceId,
      geologist: getLocalGeologist(),
      table: t,
      recordId: String((b as unknown as Record<string, unknown>).id),
      faceRef: faceRefOf(t, b as unknown as Record<string, unknown>),
      op: 'delete',
      after: null,
      base: b,
      at: Date.now(),
    });
  };
  pushDelete(table, base);

  const childRows: Array<{ table: EntityTable; row: SyncEntity }> = [];
  if (table === 'faces') {
    for (const t of ['joints', 'grades', 'waters'] as const) {
      const rows = (await db.table(t).where('faceId').equals(id).toArray()) as SyncEntity[];
      rows.forEach((row) => childRows.push({ table: t, row }));
    }
    const sketch = await db.sketches.get(id);
    if (sketch) childRows.push({ table: 'sketches', row: sketch });
    childRows.forEach(({ table: t, row }) => pushDelete(t, row));
  }

  await db.transaction(
    'rw',
    [db.faces, db.joints, db.grades, db.waters, db.sketches, db.oplog, db.kv],
    async () => {
      await baseTable.delete(id);
      for (const { table: t, row } of childRows) {
        await db.table(t).delete(String((row as unknown as Record<string, unknown>).id));
      }
      await db.oplog.bulkPut(ops);
      await saveSyncState(state);
    },
  );
  emitDataChange();
}

/** 岩性素描：整份线段集合 upsert（无变化则跳过，不产生新版本） */
export async function putSketch(faceId: string, segments: SketchDoc['segments']): Promise<void> {
  const state = await getSyncState();
  const base = await db.sketches.get(faceId);
  const nextSegments = toPlain(segments);
  if (base && JSON.stringify(base.segments) === JSON.stringify(nextSegments)) return;
  const meta = nextMeta(base?._sync, state);
  const doc = { id: faceId, faceId, segments: nextSegments, _sync: meta };
  state.seq += 1;
  const op: LogOp = {
    seq: state.seq,
    deviceId: state.deviceId,
    geologist: getLocalGeologist(),
    table: 'sketches',
    recordId: faceId,
    faceRef: faceId,
    op: 'upsert',
    after: doc,
    base: base ?? null,
    at: meta.updatedAt,
  };
  await db.transaction('rw', db.sketches, db.oplog, db.kv, async () => {
    await db.sketches.put(doc);
    await db.oplog.put(op);
    await saveSyncState(state);
  });
  emitDataChange();
}

export async function getSketch(faceId: string) {
  return db.sketches.get(faceId);
}

/* ---------------- 快照（合并计划输入） ---------------- */

export async function loadSnapshot(): Promise<LocalSnapshot> {
  const state = await ensureSyncState();
  const rows = {
    faces: new Map<string, SyncEntity>(),
    joints: new Map<string, SyncEntity>(),
    grades: new Map<string, SyncEntity>(),
    waters: new Map<string, SyncEntity>(),
    sketches: new Map<string, SyncEntity>(),
  } as LocalSnapshot['rows'];
  for (const name of ENTITY_TABLE_NAMES) {
    const list = (await db.table(name).toArray()) as SyncEntity[];
    for (const row of list) rows[name].set(String((row as unknown as Record<string, unknown>).id), row);
  }
  const appliedList = await db.applied.toArray();
  const appliedById = new Map<string, AppliedPackage>();
  appliedList.forEach((a) => appliedById.set(a.packageId, a));
  const localOps = await db.oplog.where('deviceId').equals(state.deviceId).toArray();
  localOps.sort((a, b) => a.seq - b.seq);
  return {
    schemaVersion: DB_VERSION,
    deviceId: state.deviceId,
    rows,
    appliedById,
    appliedSeqs: { ...state.appliedSeqs },
    localOps,
  };
}

/* ---------------- 导出作业包 ---------------- */

export async function buildWorkPackage(): Promise<{ pkg: WorkPackage; filename: string }> {
  const state = await ensureSyncState();
  const snap = await loadSnapshot();
  const ops = (await db.oplog.where('deviceId').equals(state.deviceId).toArray()).sort((a, b) => a.seq - b.seq);

  const faces: FaceVersionInfo[] = [];
  for (const face of snap.rows.faces.values()) {
    const faceId = face.id;
    const faceNo = (face as { faceNo: string }).faceNo;
    const touchedIds = new Set(ops.map((op) => op.faceRef));
    faces.push({
      faceId,
      faceNo,
      faceVersion: aggregateFaceVersion(snap, faceId),
      touched: touchedIds.has(faceId),
    });
  }

  const pkg: WorkPackage = {
    kind: 'gbtunnelface-workpack',
    packageFormat: 1,
    schemaVersion: DB_VERSION,
    packageId: newId('pkg'),
    deviceId: state.deviceId,
    geologist: state.geologist || getLocalGeologist() || '未署名地质员',
    exportedAt: Date.now(),
    deviceSeq: state.seq,
    sinceSeq: ops[0]?.seq ?? 0,
    faces,
    ops,
  };
  return { pkg, filename: `workpack-${pkg.geologist}-${new Date().toISOString().slice(0, 10)}.json` };
}

export function downloadWorkPackage(pkg: WorkPackage, filename: string): void {
  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------------- 导入作业包 ---------------- */

export function parseWorkPackage(text: string): WorkPackage {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('文件不是合法的 JSON，可能不是作业包文件');
  }
  const pkg = data as Partial<WorkPackage>;
  if (!pkg || pkg.kind !== 'gbtunnelface-workpack') {
    throw new Error('缺少作业包标识（kind=gbtunnelface-workpack），请选择本台导出的 .json 作业包');
  }
  if (pkg.packageFormat !== 1) {
    throw new Error(`不支持的作业包格式版本 ${String(pkg.packageFormat)}（本机支持 1）`);
  }
  if (!pkg.deviceId || !Array.isArray(pkg.ops)) {
    throw new Error('作业包内容不完整（缺少 deviceId / ops）');
  }
  return pkg as WorkPackage;
}

/* ---------------- 执行合并计划 ---------------- */

/**
 * 把已定稿（无未决冲突）的合并计划在单事务内落库。
 * 事务任何一步失败都会整体回滚：本机原记录保留，可修正后重试。
 */
export async function applyMergePlan(plan: MergePlan): Promise<MergeReport> {
  if (plan.status === 'duplicate' || plan.status === 'rejected') {
    throw new Error(plan.reason ?? '该作业包不可合并');
  }
  const pending = plan.conflicts.some((c) =>
    c.kind === 'field' ? c.fields.some((f) => !f.choice) : !c.choice,
  );
  if (pending) throw new Error('仍有冲突未选择处理方式，无法完成合并');

  const report: MergeReport = {
    packageId: plan.pkg.packageId,
    appliedAt: Date.now(),
    creates: 0,
    updates: 0,
    deletes: 0,
    skips: 0,
    labels: [],
  };
  const affectedFaces = Array.from(new Set(plan.entries.map((e) => e.faceRef)));
  const state = await getSyncState();
  const prevWatermark = state.appliedSeqs[plan.pkg.deviceId] ?? 0;
  state.appliedSeqs[plan.pkg.deviceId] = Math.max(prevWatermark, plan.pkg.deviceSeq);

  const appliedRow: AppliedPackage = {
    packageId: plan.pkg.packageId,
    deviceId: plan.pkg.deviceId,
    geologist: plan.pkg.geologist,
    deviceSeq: plan.pkg.deviceSeq,
    appliedAt: report.appliedAt,
    opCount: plan.pkg.ops.filter((op) => op.seq > prevWatermark).length,
    faces: affectedFaces,
  };

  await db.transaction(
    'rw',
    [db.faces, db.joints, db.grades, db.waters, db.sketches, db.applied, db.kv],
    async () => {
      for (const entry of plan.entries) {
        const table = db.table(entry.table);
        switch (entry.action) {
          case 'create':
          case 'replace':
          case 'patch':
            await table.put(toPlain(entry.resolvedRow));
            report.labels.push(entry.label);
            if (entry.action === 'create') report.creates += 1;
            else report.updates += 1;
            break;
          case 'delete':
            await table.delete(entry.targetId);
            report.deletes += 1;
            report.labels.push(`删除：${entry.label}`);
            if (entry.table === 'faces') {
              const plannedChildren = new Set(
                plan.entries.filter((e) => e.table !== 'faces').map((e) => e.targetId),
              );
              for (const t of ['joints', 'grades', 'waters'] as const) {
                const children = await db.table(t).where('faceId').equals(entry.targetId).toArray();
                for (const child of children as Array<{ id: string }>) {
                  if (!plannedChildren.has(child.id)) await db.table(t).delete(child.id);
                }
              }
              if (!plannedChildren.has(entry.targetId)) await db.sketches.delete(entry.targetId);
            }
            break;
          case 'skip':
            report.skips += 1;
            break;
        }
      }
      await db.applied.put(appliedRow);
      await saveSyncState(state);
    },
  );
  emitDataChange();
  return report;
}

/* ---------------- 本机操作流水（页面展示用） ---------------- */

export async function listLocalOps(limit = 50): Promise<LogOp[]> {
  const state = await getSyncState();
  const all = await db.oplog.where('deviceId').equals(state.deviceId).reverse().sortBy('seq');
  return all.slice(0, limit).reverse();
}

export async function listAppliedPackages(): Promise<AppliedPackage[]> {
  return db.applied.orderBy('appliedAt').reverse().toArray();
}
