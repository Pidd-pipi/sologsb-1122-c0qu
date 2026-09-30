/**
 * 作业包离线合并引擎（纯函数，不直接触碰数据库，便于测试与失败重试）。
 *
 * 合并顺序：
 * 1. 重复导入：packageId 已在 applied 表 → duplicate，不计数。
 * 2. 结构版本：作业包 schemaVersion 更高 → rejected，列出受影响内容。
 * 3. 作业包过期：设备序号水位已覆盖，或所改动掌子面的版本落后本机 → rejected。
 * 4. 逐记录按版本向量判定：无分叉直接快进/并入；分叉做 base/local/remote 三方比对，
 *    两边都改且不一致的字段列为冲突交人选择；不同对象（新 id / 自然键不撞）直接并入。
 */
import type {
  AppliedPackage,
  EntityTable,
  FaceVersionInfo,
  FieldConflict,
  LogOp,
  MergeConflict,
  MergePlan,
  MergeReport,
  PlanEntry,
  SyncEntity,
  SyncMeta,
  VersionVector,
  WorkPackage,
} from '../types/sync';
import { FIELD_LABELS, isKeyField } from '../types/sync';
import type { SketchDoc } from '../types/sync';
import { DB_VERSION } from './db';

/* ---------------- 版本向量 ---------------- */

export function vvCmp(a: VersionVector, b: VersionVector): 'equal' | 'ahead' | 'behind' | 'forked' {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let aAhead = false;
  let bAhead = false;
  for (const k of keys) {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    if (av > bv) aAhead = true;
    if (av < bv) bAhead = true;
  }
  if (aAhead && bAhead) return 'forked';
  if (aAhead) return 'ahead';
  if (bAhead) return 'behind';
  return 'equal';
}

export function mergeVV(a: VersionVector, b: VersionVector): VersionVector {
  const out: VersionVector = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    out[k] = Math.max(a[k] ?? 0, b[k] ?? 0);
  }
  return out;
}

export function vvText(vv: VersionVector): string {
  return Object.entries(vv)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([d, n]) => `${shortDevice(d)}:${n}`)
    .join(' · ');
}

export function shortDevice(deviceId: string): string {
  return deviceId.replace(/^dev_/, '').slice(-4);
}

/* ---------------- 快照与工具 ---------------- */

export interface LocalSnapshot {
  schemaVersion: number;
  deviceId: string;
  rows: Record<EntityTable, Map<string, SyncEntity>>;
  appliedById: Map<string, AppliedPackage>;
  appliedSeqs: Record<string, number>;
  /** 本机操作日志（含历史 delete，用于判断「本机删过」） */
  localOps: LogOp[];
}

const SYSTEM_KEYS = new Set(['id', 'faceId', '_sync']);
const TIME_KEYS: Record<EntityTable, Set<string>> = {
  faces: new Set(['recordedAt']),
  joints: new Set(),
  grades: new Set(['judgedAt']),
  waters: new Set(['measuredAt']),
  sketches: new Set(),
};

function businessFields(table: EntityTable, row: SyncEntity): string[] {
  return Object.keys(row).filter((k) => !SYSTEM_KEYS.has(k) && !TIME_KEYS[table].has(k));
}

function fieldEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function meta(row: SyncEntity | null | undefined): SyncMeta | null {
  return row?._sync ?? null;
}

/** 汇总掌子面版本：掌子面本身与其全部子记录版本向量逐分量取最大 */
export function aggregateFaceVersion(snap: LocalSnapshot, faceId: string): VersionVector {
  let vv: VersionVector = {};
  const face = snap.rows.faces.get(faceId);
  if (face) vv = mergeVV(vv, face._sync.vv);
  for (const t of ['joints', 'grades', 'waters', 'sketches'] as const) {
    for (const row of snap.rows[t].values()) {
      const ref = t === 'sketches' ? (row as SketchDoc).faceId : (row as { faceId: string }).faceId;
      if (ref === faceId) vv = mergeVV(vv, row._sync.vv);
    }
  }
  return vv;
}

/* ---------------- 展示 ---------------- */

function displayValue(table: EntityTable, field: string, value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (field === 'mileageRange' && Array.isArray(value)) {
    return `[${(value as number[]).join(', ')}]`;
  }
  if (field === 'attitude' && typeof value === 'object') {
    const a = value as { strike: number; dipDirection: number; dipAngle: number };
    return `走向 ${a.strike}° / 倾向 ${a.dipDirection}° / 倾角 ${a.dipAngle}°`;
  }
  if (field === 'segments' && Array.isArray(value)) {
    return `${(value as unknown[]).length} 条线段`;
  }
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

function rowLabel(table: EntityTable, row: SyncEntity, faceNo: string): string {
  switch (table) {
    case 'faces':
      return `掌子面 ${(row as { faceNo: string }).faceNo}`;
    case 'joints':
      return `节理组 J${(row as { setNo: number }).setNo}（${faceNo}）`;
    case 'grades':
      return `围岩级别判定 ${(row as { grade: string }).grade} 级（${faceNo}）`;
    case 'waters': {
      const w = row as { position: string; type: string };
      return `涌水记录 · ${w.type} · ${w.position}（${faceNo}）`;
    }
    case 'sketches':
      return `岩性素描（${faceNo}）`;
  }
}

/* ---------------- 归并远程操作 ---------------- */

interface RecordGroup {
  table: EntityTable;
  remoteId: string;
  faceRef: string;
  ops: LogOp[];
  /** 包内最终状态：null 表示被删除 */
  remote: SyncEntity | null;
  /** 包内首次操作前的基线快照 */
  base: SyncEntity | null;
  seqMin: number;
  seqMax: number;
}

function groupOps(ops: LogOp[]): RecordGroup[] {
  const map = new Map<string, RecordGroup>();
  for (const op of ops) {
    const key = `${op.table}:${op.recordId}`;
    const g = map.get(key);
    if (g) {
      g.ops.push(op);
      if (g.base === null && op.base) g.base = op.base;
    } else {
      map.set(key, {
        table: op.table,
        remoteId: op.recordId,
        faceRef: op.faceRef,
        ops: [op],
        remote: null,
        base: op.base,
        seqMin: op.seq,
        seqMax: op.seq,
      });
    }
    const cur = map.get(key)!;
    cur.remote = op.after;
    cur.seqMax = Math.max(cur.seqMax, op.seq);
  }
  return [...map.values()];
}

/* ---------------- 三方行合并 ---------------- */

interface FieldDecision {
  field: string;
  source: 'local' | 'remote' | 'equal';
}

/** 字段级人工选择 */
type FieldChoice = 'local' | 'remote';

/**
 * 三方比对：返回每个业务字段的取值来源，以及两边都改且不一致的冲突字段。
 * base 为 null（双方各自新建）时，所有不一致字段都视为双方改动冲突。
 */
function threeWayDiff(
  table: EntityTable,
  base: SyncEntity | null,
  local: SyncEntity,
  remote: SyncEntity,
): { decisions: FieldDecision[]; conflicts: FieldConflict[] } {
  const fields = Array.from(
    new Set([...businessFields(table, local), ...businessFields(table, remote)]),
  );
  const decisions: FieldDecision[] = [];
  const conflicts: FieldConflict[] = [];
  for (const field of fields) {
    const lv = (local as unknown as Record<string, unknown>)[field];
    const rv = (remote as unknown as Record<string, unknown>)[field];
    const bv = base ? (base as unknown as Record<string, unknown>)[field] : undefined;
    const localChanged = !base || !fieldEqual(bv, lv);
    const remoteChanged = !base || !fieldEqual(bv, rv);
    const label = FIELD_LABELS[table][field] ?? field;

    if (localChanged && remoteChanged) {
      if (fieldEqual(lv, rv)) {
        decisions.push({ field, source: 'equal' });
      } else {
        decisions.push({ field, source: 'local' });
        conflicts.push({
          field,
          label,
          key: isKeyField(table, field),
          baseDisplay: base ? displayValue(table, field, bv) : '（双方各自新建，无共同基线）',
          localDisplay: displayValue(table, field, lv),
          remoteDisplay: displayValue(table, field, rv),
          choice: null,
        });
      }
    } else if (remoteChanged) {
      decisions.push({ field, source: 'remote' });
    } else {
      // 仅本机改或两边都没改：保留本机
      decisions.push({ field, source: 'local' });
    }
  }
  return { decisions, conflicts };
}

/** 按字段决策与用户选择拼出最终行（id / faceId 沿用本机目标行） */
function composeRow(
  table: EntityTable,
  target: SyncEntity,
  remote: SyncEntity,
  decisions: FieldDecision[],
  fieldChoices: Map<string, 'local' | 'remote'>,
  mergedVV: VersionVector,
  deviceId: string,
): SyncEntity {
  const out = clone(target) as unknown as Record<string, unknown>;
  for (const d of decisions) {
    const source = fieldChoices.get(d.field) ?? d.source;
    if (source === 'remote') {
      out[d.field] = (remote as unknown as Record<string, unknown>)[d.field];
    }
  }
  const sync: SyncMeta = {
    deviceId,
    vv: mergedVV,
    updatedAt: Math.max(target._sync.updatedAt, remote._sync.updatedAt),
  };
  out._sync = sync;
  return out as unknown as SyncEntity;
}

function stampAdopted(remote: SyncEntity, localDevice: string, localVV: VersionVector): SyncEntity {
  const out = clone(remote) as unknown as Record<string, unknown>;
  out._sync = {
    deviceId: remote._sync.deviceId,
    vv: mergeVV(remote._sync.vv, localVV),
    updatedAt: remote._sync.updatedAt,
  } satisfies SyncMeta;
  void localDevice;
  return out as unknown as SyncEntity;
}

/** 素描并集：不同线段（不同 id）直接并入，同 id 视为同一条 */
function unionSketch(local: SketchDoc, remote: SketchDoc, deviceId: string): SketchDoc {
  const map = new Map<string, SketchDoc['segments'][number]>();
  for (const s of local.segments) map.set(s.id, s);
  for (const s of remote.segments) if (!map.has(s.id)) map.set(s.id, s);
  return {
    id: local.id,
    faceId: local.faceId,
    segments: [...map.values()],
    _sync: {
      deviceId,
      vv: mergeVV(local._sync.vv, remote._sync.vv),
      updatedAt: Math.max(local._sync.updatedAt, remote._sync.updatedAt),
    },
  };
}

/* ---------------- 主入口：生成合并计划 ---------------- */

export function buildMergePlan(pkg: WorkPackage, snap: LocalSnapshot): MergePlan {
  const empty: MergePlan = {
    status: 'ready',
    pkg,
    affected: [],
    entries: [],
    conflicts: [],
    summary: { creates: 0, updates: 0, deletes: 0, skips: 0 },
  };

  // 1) 重复导入
  const existed = snap.appliedById.get(pkg.packageId);
  if (existed) {
    return {
      ...empty,
      status: 'duplicate',
      reason: `该作业包已于 ${new Date(existed.appliedAt).toLocaleString('zh-CN')} 合并过（${existed.geologist}，${existed.opCount} 条操作），重复导入不重复计数。`,
    };
  }

  // 2) 结构版本过期
  if (pkg.schemaVersion > snap.schemaVersion) {
    return {
      ...empty,
      status: 'rejected',
      reason: `作业包来自更新的数据库结构（包 v${pkg.schemaVersion}，本机 v${snap.schemaVersion}）。请先升级本机程序后再合并，已拒绝整包写入。`,
      affected: pkg.ops.map((op) => `${op.table}#${op.recordId}`),
    };
  }

  // 2.5) 不能合并本机自己导出的作业包（自己的操作本就在本机）
  if (pkg.deviceId === snap.deviceId) {
    return {
      ...empty,
      status: 'rejected',
      reason: '该作业包由本机导出（设备标识一致），不能合并自己的作业包；请导入同伴设备导出的包。',
      affected: pkg.faces.filter((f) => f.touched).map((f) => f.faceNo),
    };
  }

  // 3) 操作水位：剔除本机已合并过的该设备序号
  const watermark = snap.appliedSeqs[pkg.deviceId] ?? 0;
  const freshOps = pkg.ops.filter((op) => op.seq > watermark);
  if (freshOps.length === 0) {
    return {
      ...empty,
      status: 'rejected',
      reason: `作业包已过期：对方设备截至序号 ${pkg.deviceSeq} 的全部操作本机此前都已合并（本机水位 ${watermark}），没有任何新内容。`,
      affected: pkg.faces.filter((f) => f.touched).map((f) => `${f.faceNo}（掌子面版本 ${vvText(f.faceVersion)}）`),
    };
  }

  // 远程 faceId -> faceNo（优先用 faces 清单）
  const remoteFaceName = new Map<string, string>();
  for (const f of pkg.faces) remoteFaceName.set(f.faceId, f.faceNo);
  for (const op of pkg.ops) {
    if (op.table === 'faces' && op.after) {
      remoteFaceName.set(op.recordId, (op.after as { faceNo: string }).faceNo);
    }
    if (op.base && op.table === 'faces') {
      remoteFaceName.set(op.recordId, (op.base as { faceNo: string }).faceNo);
    }
  }

  // 远程 faceId -> 本机 faceId（同 id 优先，其次按掌子面编号自然键）
  const remoteToLocalFace = new Map<string, string>();
  const localFacesByNo = new Map<string, string>();
  for (const f of snap.rows.faces.values()) {
    localFacesByNo.set((f as { faceNo: string }).faceNo, f.id);
  }
  for (const [remoteFaceId, faceNo] of remoteFaceName) {
    if (snap.rows.faces.has(remoteFaceId)) {
      remoteToLocalFace.set(remoteFaceId, remoteFaceId);
    } else if (localFacesByNo.get(faceNo)) {
      remoteToLocalFace.set(remoteFaceId, localFacesByNo.get(faceNo)!);
    } else {
      remoteToLocalFace.set(remoteFaceId, remoteFaceId);
    }
  }
  const localFaceNo = (faceRef: string): string => {
    const localId = remoteToLocalFace.get(faceRef) ?? faceRef;
    const f = snap.rows.faces.get(localId);
    return f ? (f as { faceNo: string }).faceNo : remoteFaceName.get(faceRef) ?? '未知掌子面';
  };

  // 4) 掌子面版本过期：本包改过、本机却严格领先（包版本是本机子集）→ 拒绝并指出受影响内容
  const staleFaces: FaceVersionInfo[] = [];
  for (const f of pkg.faces) {
    if (!f.touched) continue;
    const localId = remoteToLocalFace.get(f.faceId);
    if (!localId) continue;
    const localFV = aggregateFaceVersion(snap, localId);
    if (vvCmp(f.faceVersion, localFV) === 'behind') {
      staleFaces.push(f);
    }
  }
  if (staleFaces.length > 0) {
    const staleIds = new Set(staleFaces.map((f) => f.faceId));
    const affected: string[] = [];
    for (const f of staleFaces) {
      affected.push(
        `掌子面 ${f.faceNo}：作业包版本 ${vvText(f.faceVersion)}，本机版本 ${vvText(
          aggregateFaceVersion(snap, remoteToLocalFace.get(f.faceId)!),
        )}`,
      );
      const childLabels = freshOps
        .filter((op) => op.faceRef === f.faceId && op.table !== 'faces')
        .map((op) => {
          const row = op.after ?? op.base;
          return row ? rowLabel(op.table, row, f.faceNo) : `${op.table}#${op.recordId}`;
        });
      affected.push(...Array.from(new Set(childLabels)).map((t) => `  └ ${t}`));
    }
    void staleIds;
    return {
      ...empty,
      status: 'rejected',
      reason:
        '作业包版本过期：以下掌子面在对方导出后本机已有更新的合并版本，整包拒绝合并。请让对方重新导出基于最新版本的作业包后再试。',
      affected,
    };
  }

  // 5) 逐记录归并
  const groups = groupOps(freshOps);
  const entries: PlanEntry[] = [];

  const locallyDeleted = (table: EntityTable, remoteId: string, base: SyncEntity | null): boolean => {
    return snap.localOps.some((op) => {
      if (op.op !== 'delete' || op.table !== table) return false;
      if (op.recordId === remoteId) return true;
      if (base && op.base && (op.base as { id: string }).id === (base as { id: string }).id) return true;
      return false;
    });
  };

  for (const g of groups) {
    const faceNo = localFaceNo(g.faceRef);
    const localFaceId = remoteToLocalFace.get(g.faceRef) ?? g.faceRef;

    // 远程记录映射到本机目标行：同 id → 直接命中；否则按自然键
    let targetId = g.remoteId;
    let local: SyncEntity | null = snap.rows[g.table].get(g.remoteId) ?? null;
    if (!local) {
      if (g.remote) {
        if (g.table === 'faces') {
          const no = (g.remote as { faceNo: string }).faceNo;
          const hit = localFacesByNo.get(no);
          if (hit) {
            targetId = hit;
            local = snap.rows.faces.get(hit)!;
          }
        } else if (g.table === 'joints') {
          const setNo = (g.remote as { setNo: number }).setNo;
          const hit = [...snap.rows.joints.values()].find(
            (j) => (j as { faceId: string }).faceId === localFaceId && (j as { setNo: number }).setNo === setNo,
          );
          if (hit) {
            targetId = hit.id;
            local = hit;
          }
        } else if (g.table === 'sketches') {
          const hit = snap.rows.sketches.get(localFaceId);
          if (hit) {
            targetId = hit.id;
            local = hit;
          }
        }
      } else if (g.table === 'faces') {
        // 远程删除的掌子面，按编号找回本机行
        const no = g.base ? (g.base as { faceNo: string }).faceNo : remoteFaceName.get(g.remoteId);
        const hit = (no && localFacesByNo.get(no)) || null;
        if (hit) {
          targetId = hit;
          local = snap.rows.faces.get(hit)!;
        }
      }
    }

    const remote = g.remote;
    const base = g.base;
    const labelBase = remote ?? local ?? base;
    const label = labelBase ? rowLabel(g.table, labelBase, faceNo) : `${g.table}#${g.remoteId}`;
    const entry: PlanEntry = {
      table: g.table,
      targetId,
      remoteId: g.remoteId,
      faceRef: localFaceId,
      label,
      action: 'skip',
      resolvedRow: null,
      conflict: null,
      seqMin: g.seqMin,
      seqMax: g.seqMax,
    };

    // —— 远程有、本机无：新建并入（除非本机已删且基线相同，则静默） ——
    if (remote && !local) {
      if (base && locallyDeleted(g.table, g.remoteId, base)) {
        entry.action = 'skip';
        entry.note = '本机已删除该记录，远程修改不复活（如需恢复请由人工重新录入）';
      } else {
        const adopted = stampAdopted(remote, snap.deviceId, {});
        if (g.table !== 'faces') {
          (adopted as unknown as Record<string, unknown>).faceId = localFaceId;
        }
        if (g.table === 'sketches') {
          (adopted as SketchDoc).id = localFaceId;
        }
        entry.action = 'create';
        entry.resolvedRow = adopted;
      }
      entries.push(entry);
      continue;
    }

    // —— 远程删除 ——
    if (!remote) {
      if (!local) {
        entry.action = 'skip';
        entry.note = '双方均已无该记录';
      } else if (base) {
        const cmpLocalBase = vvCmp(local._sync.vv, base._sync.vv);
        const localEdited = cmpLocalBase === 'ahead' || cmpLocalBase === 'forked';
        if (localEdited) {
          // 对方删、本机改 → 冲突
          entry.action = 'skip';
          entry.conflict = {
            table: g.table,
            targetId,
            faceRef: localFaceId,
            label,
            kind: 'delete-update',
            fields: [],
            choice: null,
            local,
            remote: null,
            base,
          };
        } else {
          entry.action = 'delete';
        }
      } else {
        entry.action = 'skip';
        entry.note = '远程为「建后即删」，本机亦无独立修改';
      }
      entries.push(entry);
      continue;
    }

    // —— 双方都有：版本向量判定 ——
    const cmp = vvCmp(local!._sync.vv, remote._sync.vv);
    const naturalRemapped = targetId !== g.remoteId;

    if (cmp === 'equal' || cmp === 'ahead') {
      entry.action = 'skip';
      entry.note = cmp === 'equal' ? '版本一致' : '本机版本已包含对方修改';
      entries.push(entry);
      continue;
    }

    if (cmp === 'behind' && !naturalRemapped) {
      // 快进对方版本（faceId 沿用本机映射）
      const row = clone(remote) as unknown as Record<string, unknown>;
      if (g.table !== 'faces') row.faceId = localFaceId;
      if (g.table === 'sketches') row.id = localFaceId;
      row._sync = {
        deviceId: snap.deviceId,
        vv: mergeVV(local!._sync.vv, remote._sync.vv),
        updatedAt: Math.max(local!._sync.updatedAt, remote._sync.updatedAt),
      } satisfies SyncMeta;
      entry.action = 'replace';
      entry.resolvedRow = row as unknown as SyncEntity;
      entries.push(entry);
      continue;
    }

    // —— 分叉：素描走线段并集；其余做三方字段比对 ——
    if (g.table === 'sketches') {
      entry.action = 'patch';
      entry.resolvedRow = unionSketch(local as SketchDoc, remote as SketchDoc, snap.deviceId);
      entry.note = `素描线段并集（本机 ${(local as SketchDoc).segments.length} 条 + 对方 ${
        (remote as SketchDoc).segments.length
      } 条，去重后 ${(entry.resolvedRow as SketchDoc).segments.length} 条）`;
      entries.push(entry);
      continue;
    }

    if (g.table === 'faces' && naturalRemapped && !base) {
      // 同编号各自新建：整条掌子面二选一
      entry.action = 'skip';
      entry.conflict = {
        table: g.table,
        targetId,
        faceRef: localFaceId,
        label,
        kind: 'create-create',
        fields: [],
        choice: null,
        local,
        remote,
        base: null,
      };
      entries.push(entry);
      continue;
    }

    const { decisions, conflicts } = threeWayDiff(g.table, base, local!, remote);
    const mergedVV = mergeVV(local!._sync.vv, remote._sync.vv);
    if (conflicts.length === 0) {
      entry.action = 'patch';
      entry.resolvedRow = composeRow(g.table, local!, remote, decisions, new Map(), mergedVV, snap.deviceId);
    } else {
      entry.action = 'skip';
      // 先把无争议字段合成好（冲突字段占位取本机），用户选择后在 resolveConflicts 重算
      entry.conflict = {
        table: g.table,
        targetId,
        faceRef: localFaceId,
        label,
        kind: 'field',
        fields: conflicts,
        choice: null,
        local,
        remote,
        base,
      };
    }
    entries.push(entry);
  }

  // 删除掌子面时连带子记录：若远程删掉了某掌子面且最终执行删除，子记录按 faceRef 一并处理
  // （子记录版本若更新仍会单独成条产生冲突，不会被误删）
  for (const e of entries) {
    if (e.table === 'faces' && e.action === 'delete') {
      for (const t of ['joints', 'grades', 'waters', 'sketches'] as const) {
        for (const row of snap.rows[t].values()) {
          const ref = t === 'sketches' ? (row as SketchDoc).faceId : (row as { faceId: string }).faceId;
          if (ref === e.targetId && !entries.some((x) => x.targetId === row.id)) {
            entries.push({
              table: t,
              targetId: row.id,
              remoteId: row.id,
              faceRef: e.targetId,
              label: rowLabel(t, row, e.label.replace(/^掌子面\s*/, '')),
              action: 'delete',
              resolvedRow: null,
              conflict: null,
              note: '随掌子面一并删除',
              seqMin: e.seqMin,
              seqMax: e.seqMax,
            });
          }
        }
      }
    }
  }

  entries.sort((a, b) => a.seqMin - b.seqMin || a.seqMax - b.seqMax);
  const conflicts = entries.map((e) => e.conflict).filter((c): c is MergeConflict => !!c);
  const summary = {
    creates: entries.filter((e) => e.action === 'create').length,
    updates: entries.filter((e) => e.action === 'replace' || e.action === 'patch').length,
    deletes: entries.filter((e) => e.action === 'delete').length,
    skips: entries.filter((e) => e.action === 'skip').length,
  };

  return {
    status: conflicts.length > 0 ? 'conflicts' : 'ready',
    pkg,
    affected: [],
    entries,
    conflicts,
    summary,
  };
}

/* ---------------- 用户决策后定稿 ---------------- */

export interface ConflictDecision {
  /** 字段冲突：field -> 选择；delete-update / create-create：用 recordChoice */
  recordChoice?: 'local' | 'remote';
  fields?: Record<string, 'local' | 'remote'>;
}

/** 所有冲突是否都已选择（UI 用于阻止提前确认） */
export function unresolvedConflicts(plan: MergePlan): MergeConflict[] {
  return plan.conflicts.filter((c) => {
    if (c.kind === 'field') return c.fields.some((f: FieldConflict) => !f.choice);
    return !c.choice;
  });
}

/**
 * 把用户选择写回计划，重算每条冲突记录的 resolvedRow / action。
 * 不触碰数据库；失败重试时可重新决策。
 */
export function resolveConflicts(plan: MergePlan, decisions: Map<string, ConflictDecision>, deviceId: string): MergePlan {
  const next: MergePlan = {
    ...plan,
    entries: plan.entries.map((entry) => ({ ...entry })),
  };
  for (const entry of next.entries) {
    const c = entry.conflict;
    if (!c) continue;
    const key = `${c.table}:${c.targetId}`;
    const decision = decisions.get(key);
    if (!decision) continue;

    if (c.kind === 'delete-update') {
      if (decision.recordChoice === 'local') {
        entry.action = 'patch';
        const row = clone(c.local!) as unknown as Record<string, unknown>;
        row._sync = {
          deviceId,
          vv: mergeVV(c.local!._sync.vv, c.remote?._sync.vv ?? {}),
          updatedAt: c.local!._sync.updatedAt,
        } satisfies SyncMeta;
        entry.resolvedRow = row as unknown as SyncEntity;
        entry.note = '冲突已按「保留本机」定稿';
      } else if (decision.recordChoice === 'remote') {
        entry.action = 'delete';
        entry.resolvedRow = null;
        entry.note = '冲突已按「按对方删除」定稿';
      }
      continue;
    }

    if (c.kind === 'create-create') {
      if (decision.recordChoice === 'local') {
        entry.action = 'patch';
        const row = clone(c.local!) as unknown as Record<string, unknown>;
        row._sync = {
          deviceId,
          vv: mergeVV(c.local!._sync.vv, c.remote!._sync.vv),
          updatedAt: Math.max(c.local!._sync.updatedAt, c.remote!._sync.updatedAt),
        } satisfies SyncMeta;
        entry.resolvedRow = row as unknown as SyncEntity;
        entry.note = '同编号掌子面冲突，已保留本机';
      } else if (decision.recordChoice === 'remote') {
        // 采用对方内容，但沿用本机 id（子记录仍挂在本机掌子面下）
        const { decisions: diffs } = threeWayDiff(c.table, null, c.local!, c.remote!);
        const fieldChoices = new Map<string, FieldChoice>();
        for (const d of diffs) fieldChoices.set(d.field, 'remote');
        entry.action = 'replace';
        entry.resolvedRow = composeRow(
          c.table,
          c.local!,
          c.remote!,
          diffs,
          fieldChoices,
          mergeVV(c.local!._sync.vv, c.remote!._sync.vv),
          deviceId,
        );
        entry.note = '同编号掌子面冲突，已采用对方内容（保留本机 id，子记录归属不变）';
      }
      continue;
    }

    // 字段冲突：重跑三方比对并套用选择
    const { decisions: diffs, conflicts } = threeWayDiff(c.table, c.base, c.local!, c.remote!);
    const allChosen = conflicts.every((f) => decision.fields?.[f.field]);
    if (!allChosen) continue;
    const fieldChoices = new Map<string, FieldChoice>();
    for (const f of conflicts) fieldChoices.set(f.field, decision.fields![f.field]!);
    entry.action = 'patch';
    entry.resolvedRow = composeRow(
      c.table,
      c.local!,
      c.remote!,
      diffs,
      fieldChoices,
      mergeVV(c.local!._sync.vv, c.remote!._sync.vv),
      deviceId,
    );
    entry.note = '双方修改冲突，已按人工选择合并';
  }

  // 同步 conflicts 列表中的选择状态（供 UI 显示）
  for (const c of next.conflicts) {
    const d = decisions.get(`${c.table}:${c.targetId}`);
    if (!d) continue;
    if (c.kind === 'field' && d.fields) {
      for (const f of c.fields) {
        if (d.fields[f.field]) f.choice = d.fields[f.field]!;
      }
    } else if (d.recordChoice) {
      c.choice = d.recordChoice;
    }
  }
  next.conflicts = next.entries.map((e) => e.conflict).filter((x): x is MergeConflict => !!x);
  next.status = unresolvedConflicts(next).length > 0 ? 'conflicts' : 'ready';
  next.summary = {
    creates: next.entries.filter((e) => e.action === 'create').length,
    updates: next.entries.filter((e) => e.action === 'replace' || e.action === 'patch').length,
    deletes: next.entries.filter((e) => e.action === 'delete').length,
    skips: next.entries.filter((e) => e.action === 'skip').length,
  };
  return next;
}

export function emptyReport(pkg: WorkPackage): MergeReport {
  return {
    packageId: pkg.packageId,
    appliedAt: Date.now(),
    creates: 0,
    updates: 0,
    deletes: 0,
    skips: 0,
    labels: [],
  };
}
