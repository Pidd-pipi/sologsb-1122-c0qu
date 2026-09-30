/**
 * 离线协作 / 作业包合并领域模型。
 *
 * 核心概念：
 * - SyncMeta：每条记录自带的版本向量（每台设备一个序号），是判断「谁更新 / 分叉 / 过期」的依据。
 * - LogOp：本机一次增删改的有序操作日志（带操作前快照 base，用于三方比对）。
 * - WorkPackage：导出给同伴的作业包，含掌子面版本清单 + 按操作顺序排列的日志。
 */
import type { TunnelFace } from './face';
import type { JointSet } from './joint';
import type { RockMassGrade } from './grade';
import type { WaterInflow } from './water';

/** 设备（浏览器 / 作业端）标识 */
export type DeviceId = string;

/** 版本向量：deviceId -> 该设备在本对象上的最新序号 */
export type VersionVector = Record<string, number>;

/** 同步元数据，挂在每条业务记录的 _sync 字段上 */
export interface SyncMeta {
  /** 最后修改该记录的设备 */
  deviceId: DeviceId;
  /** 掌子面版本 / 记录版本：各设备序号 */
  vv: VersionVector;
  /** 最后修改时间 */
  updatedAt: number;
}

export type EntityTable = 'faces' | 'joints' | 'grades' | 'waters' | 'sketches';

export const ENTITY_TABLES: EntityTable[] = ['faces', 'joints', 'grades', 'waters', 'sketches'];

/** 岩性素描文档：一个掌子面一条，线段集合整体参与合并 */
export interface SketchDoc {
  /** 即 faceId */
  id: string;
  faceId: string;
  segments: Array<{
    id: string;
    x: number;
    y: number;
    dipAngle: number;
    dipDirection: number;
    length: number;
    label: string;
  }>;
  _sync: SyncMeta;
}

export type SyncEntity =
  | (TunnelFace & { _sync: SyncMeta })
  | (JointSet & { _sync: SyncMeta })
  | (RockMassGrade & { _sync: SyncMeta })
  | (WaterInflow & { _sync: SyncMeta })
  | SketchDoc;

/** 一条有序操作日志（记录在操作发生的设备上，seq 在该设备内单调递增） */
export interface LogOp {
  /** 操作顺序号（设备内单调递增、连续） */
  seq: number;
  deviceId: DeviceId;
  /** 操作时记录在案的地质员姓名 */
  geologist: string;
  table: EntityTable;
  /** faces/joints/grades/waters 为业务主键；sketches 为 faceId */
  recordId: string;
  /** 所属掌子面（faces 表为自身 id），用于归属与受影响内容定位 */
  faceRef: string;
  op: 'upsert' | 'delete';
  /** 操作后的完整记录（delete 时为 null） */
  after: SyncEntity | null;
  /** 操作前本机快照（首次创建时为 null），三方合并的共同基线 */
  base: SyncEntity | null;
  at: number;
}

/** 作业包中携带的掌子面版本信息 */
export interface FaceVersionInfo {
  faceId: string;
  faceNo: string;
  /** 导出时该掌子面的版本向量（含子记录汇聚） */
  faceVersion: VersionVector;
  /** 本包是否包含该掌子面的改动 */
  touched: boolean;
}

/** 作业包：两名地质员断网编录后交换合并的载体 */
export interface WorkPackage {
  kind: 'gbtunnelface-workpack';
  /** 作业包格式版本 */
  packageFormat: 1;
  /** 导出方的数据库结构版本；高于接收方则拒绝合并 */
  schemaVersion: number;
  /** 导出批次唯一 id（重复导入去重） */
  packageId: string;
  deviceId: DeviceId;
  geologist: string;
  exportedAt: number;
  /** 导出设备的操作序号水位（= 本包最后一条操作的 seq） */
  deviceSeq: number;
  /** 本包第一条操作的 seq（全量导出时为 0/最小） */
  sinceSeq: number;
  /** 导出方全部掌子面的版本清单（即使本包未改动也列出，供版本核对） */
  faces: FaceVersionInfo[];
  /** 按操作顺序排列的日志 */
  ops: LogOp[];
}

/** 已成功合并的作业包回执（同时承担重复导入去重） */
export interface AppliedPackage {
  packageId: string;
  deviceId: DeviceId;
  geologist: string;
  deviceSeq: number;
  appliedAt: number;
  opCount: number;
  faces: string[];
}

/** 本机同步状态（kv 表单行） */
export interface SyncState {
  deviceId: DeviceId;
  geologist: string;
  /** 本机已产生的最大操作序号 */
  seq: number;
  /** 上次导出作业包时的序号水位 */
  lastExportSeq: number;
  /** 全量操作日志（追加写，导出后保留以便重新导出 / 补发包） */
  ops: LogOp[];
  /** 各设备已合并的序号水位：deviceId -> deviceSeq */
  appliedSeqs: Record<string, number>;
}

/* ---------- 冲突 ---------- */

export type ConflictChoice = 'local' | 'remote';

export interface FieldConflict {
  field: string;
  label: string;
  /** 是否「关键字段」（掌子面关键信息 / 节理组产状组号） */
  key: boolean;
  baseDisplay: string;
  localDisplay: string;
  remoteDisplay: string;
  /** 用户选择，未选为 null（素描并集只对 sketches 开放） */
  choice: ConflictChoice | 'union' | null;
}

export interface MergeConflict {
  /** 冲突记录在执行侧的目标表 + 主键 */
  table: EntityTable;
  targetId: string;
  faceRef: string;
  /** 记录在作业包中的展示名，如「掌子面 ZK-104」「节理组 J2（ZK-104）」 */
  label: string;
  kind: 'field' | 'delete-update' | 'create-create';
  fields: FieldConflict[];
  /** delete-update 冲突：对方删除、本机改过 → 用户选择保留还是删除 */
  choice: ConflictChoice | null;
  local: SyncEntity | null;
  remote: SyncEntity | null;
  base: SyncEntity | null;
}

export type PlanAction = 'create' | 'replace' | 'patch' | 'delete' | 'skip';

export interface PlanEntry {
  table: EntityTable;
  /** 执行侧目标记录 id（自然键匹配后可能与作业包中的 id 不同） */
  targetId: string;
  /** 作业包中原始 id */
  remoteId: string;
  faceRef: string;
  label: string;
  action: PlanAction;
  /** 无冲突时待落库的最终行（_sync 已重算） */
  resolvedRow: SyncEntity | null;
  /** 该条目仍有待用户选择的冲突 */
  conflict: MergeConflict | null;
  /** skip / 备注信息 */
  note?: string;
  /** 同记录在包内的首末操作顺序，用于保持操作顺序展示 */
  seqMin: number;
  seqMax: number;
}

export type PlanStatus = 'ready' | 'conflicts' | 'duplicate' | 'rejected';

export interface MergePlan {
  status: PlanStatus;
  pkg: WorkPackage;
  /** rejected / duplicate 时的原因说明 */
  reason?: string;
  /** rejected 时逐条理出的受影响内容 */
  affected: string[];
  entries: PlanEntry[];
  conflicts: MergeConflict[];
  summary: {
    creates: number;
    updates: number;
    deletes: number;
    skips: number;
  };
}

/** apply 成功后的结果回执 */
export interface MergeReport {
  packageId: string;
  appliedAt: number;
  creates: number;
  updates: number;
  deletes: number;
  skips: number;
  labels: string[];
}

/** 掌子面的关键字段（两边都改时必须人工选择） */
export const FACE_KEY_FIELDS = new Set([
  'faceNo',
  'chainage',
  'mileageRange',
  'excavationMethod',
  'faceSize',
  'lithology',
  'weathering',
  'rockStrength',
  'attitude',
]);

/** 节理组关键字段 */
export const JOINT_KEY_FIELDS = new Set(['setNo', 'dipDirection', 'dipAngle']);

export const FIELD_LABELS: Record<EntityTable, Record<string, string>> = {
  faces: {
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
    recordedAt: '编录时间',
  },
  joints: {
    setNo: '组号',
    dipDirection: '倾向',
    dipAngle: '倾角',
    spacing: '间距(cm)',
    persistence: '延伸长度(m)',
    aperture: '张开度(mm)',
    fillMaterial: '充填物',
    roughness: '粗糙度',
    waterWet: '渗水状态',
    jointCount: '条数',
  },
  grades: {},
  waters: {},
  sketches: { segments: '素描线段' },
};

export function isKeyField(table: EntityTable, field: string): boolean {
  if (table === 'faces') return FACE_KEY_FIELDS.has(field);
  if (table === 'joints') return JOINT_KEY_FIELDS.has(field);
  return false;
}
