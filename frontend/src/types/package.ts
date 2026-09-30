import type { TunnelFace } from './face';
import type { JointSet } from './joint';
import type { RockMassGrade } from './grade';
import type { WaterInflow } from './water';

/** 可合并的表 */
export type PackageTable = 'faces' | 'joints' | 'grades' | 'waters';

export type AnyRecord = TunnelFace | JointSet | RockMassGrade | WaterInflow;

/** 作业包操作（带顺序） */
export interface PackageOp {
  /** 包内操作顺序，从 1 递增 */
  seq: number;
  kind: 'upsert' | 'delete';
  table: PackageTable;
  /** 记录 id */
  id: string;
  /** upsert 时的完整记录 */
  record?: AnyRecord;
}

/** 离线作业包：一次编录作业的完整变更集 */
export interface WorkPackage {
  /** 包 id（幂等用） */
  id: string;
  /** 作业包编号（展示用） */
  packageNo: string;
  /** 编录人 */
  geologist: string;
  /** 编录出发时间（ms） */
  createdAt: number;
  note?: string;
  /** 操作顺序：按 seq 递增 */
  ops: PackageOp[];
  /** 基准快照：本包涉及记录在出发时的状态（id -> 记录） */
  bases: Record<string, AnyRecord>;
  /** 各掌子面基于的版本（faceId -> baseVersion） */
  faceVersions: Record<string, number>;
}

/** 合并预览状态 */
export type MergeStatus = 'clean' | 'duplicate' | 'stale' | 'conflicts' | 'error';

/** 字段级冲突项 */
export interface FieldConflict {
  field: string;
  label: string;
  base: unknown;
  local: unknown;
  incoming: unknown;
}

/** 对象级冲突：同一记录两边都改了 */
export interface ObjectConflict {
  key: string;
  table: PackageTable;
  id: string;
  objectLabel: string;
  faceId?: string;
  faceNo?: string;
  fields: FieldConflict[];
  /** 基准中是否存在该记录（false=两边各自新建了同 id 对象） */
  existedInBase: boolean;
}

/** 版本过期的掌子面 */
export interface StaleFace {
  faceId: string;
  faceNo: string;
  baseVersion: number;
  localVersion: number;
  affected: { table: PackageTable; id: string; label: string; reason: string }[];
}

/** 可直接并入的变更 */
export interface AppliedChange {
  table: PackageTable;
  id: string;
  label: string;
  action: 'created' | 'updated' | 'deleted';
}

/** 合并预览结果 */
export interface MergePreview {
  status: MergeStatus;
  /** 可直接并入的变更 */
  autoApplied: AppliedChange[];
  /** 冲突列表（需人工选择） */
  conflicts: ObjectConflict[];
  /** 版本过期的掌子面（本次拒绝合并） */
  staleFaces: StaleFace[];
  /** 重复导入信息 */
  duplicate?: { importedAt: number; packageNo: string; geologist: string };
  error?: string;
}

/** 导入历史记录（幂等台账） */
export interface ImportRecord {
  id: string;
  packageId: string;
  contentHash: string;
  packageNo: string;
  geologist: string;
  importedAt: number;
  appliedCount: number;
}

/** 冲突选择：key = `${table}:${id}`，值 = 保留本机 / 采用作业包 */
export type ConflictResolutions = Record<string, 'local' | 'incoming'>;
