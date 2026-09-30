import Dexie, { type Table } from 'dexie';
import type { TunnelFace } from '../types/face';
import type { JointSet } from '../types/joint';
import type { RockMassGrade } from '../types/grade';
import type { WaterInflow } from '../types/water';
import type {
  AppliedPackage,
  LogOp,
  SketchDoc,
  SyncEntity,
  SyncMeta,
  VersionVector,
} from '../types/sync';
import { newId } from './id';

export const DB_NAME = 'gbtunnelface';
export const DB_VERSION = 3;
export const LS_VERSION_KEY = 'gbtunnelface:db-version';
export const LS_DEVICE_KEY = 'gbtunnelface:device-id';
export const LS_GEOLOGIST_KEY = 'gbtunnelface:geologist';

/** 本机设备标识（浏览器清站点数据才会换） */
export function getDeviceId(): string {
  try {
    let id = window.localStorage.getItem(LS_DEVICE_KEY);
    if (!id) {
      id = `dev_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      window.localStorage.setItem(LS_DEVICE_KEY, id);
    }
    return id;
  } catch {
    return `dev_${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** 本机地质员姓名（写入操作日志，导出作业包时展示） */
export function getLocalGeologist(): string {
  try {
    return window.localStorage.getItem(LS_GEOLOGIST_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setLocalGeologist(name: string): void {
  try {
    window.localStorage.setItem(LS_GEOLOGIST_KEY, name);
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

class TunnelFaceDB extends Dexie {
  faces!: Table<TunnelFace & { _sync?: SyncMeta }, string>;
  joints!: Table<JointSet & { _sync?: SyncMeta }, string>;
  grades!: Table<RockMassGrade & { _sync?: SyncMeta }, string>;
  waters!: Table<WaterInflow & { _sync?: SyncMeta }, string>;
  sketches!: Table<SketchDoc, string>;
  oplog!: Table<LogOp, string>;
  applied!: Table<AppliedPackage, string>;
  kv!: Table<{ key: string; value: unknown }, string>;

  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      faces: 'id, faceNo, chainage, lithology, excavationMethod, recordedAt',
      joints: 'id, faceId, setNo, dipDirection, dipAngle',
      grades: 'id, faceId, grade, judgedAt',
      waters: 'id, faceId, chainage, type',
    });
    this.version(2)
      .stores({
        faces: 'id, faceNo, chainage, lithology, excavationMethod, weathering, recordedAt',
        joints: 'id, faceId, setNo, dipDirection, dipAngle, fillMaterial',
        grades: 'id, faceId, grade, judgedAt, bqValue',
        waters: 'id, faceId, chainage, type, changeTrend',
      })
      .upgrade(async (tx) => {
        await tx
          .table('faces')
          .toCollection()
          .modify((row: any) => {
            if (!row.attitude) row.attitude = { strike: 0, dipDirection: 0, dipAngle: 0 };
            if (row.mileageRange === undefined) row.mileageRange = [row.chainage ?? 0, row.chainage ?? 0];
          });
        await tx
          .table('grades')
          .toCollection()
          .modify((row: any) => {
            if (row.correctedBq === undefined) row.correctedBq = row.bqValue ?? 0;
            if (row.manualAdjusted === undefined) row.manualAdjusted = false;
          });
        await tx
          .table('waters')
          .toCollection()
          .modify((row: any) => {
            if (row.chainage === undefined) row.chainage = 0;
          });
      });
    // v3：离线协作——每条业务记录补版本向量，素描线段从 localStorage 迁入 IndexedDB，
    // 新增 oplog（操作日志）、applied（已合并作业包）、kv（同步状态）三张表。
    this.version(3)
      .stores({
        faces: 'id, faceNo, chainage, lithology, excavationMethod, weathering, recordedAt',
        joints: 'id, faceId, setNo, dipDirection, dipAngle, fillMaterial',
        grades: 'id, faceId, grade, judgedAt, bqValue',
        waters: 'id, faceId, chainage, type, changeTrend',
        sketches: 'id, faceId',
        oplog: '[deviceId+seq], deviceId, table, faceRef',
        applied: 'packageId, deviceId, appliedAt',
        kv: 'key',
      })
      .upgrade(async (tx) => {
        const deviceId = getDeviceId();
        const stamp = (vv: VersionVector = {}): SyncMeta => ({
          deviceId,
          vv: { ...vv, [deviceId]: (vv[deviceId] ?? 0) + 1 },
          updatedAt: Date.now(),
        });
        const migratedFaces: string[] = [];
        await tx
          .table('faces')
          .toCollection()
          .modify((row: any) => {
            if (!row._sync) row._sync = stamp();
            migratedFaces.push(row.id as string);
          });
        for (const name of ['joints', 'grades', 'waters']) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: any) => {
              if (!row._sync) row._sync = stamp();
            });
        }
        // 把 localStorage 里的素描线段搬到 sketches 表（每个掌子面一条）
        const sketchTable = tx.table('sketches');
        const ls = window.localStorage;
        for (const faceId of migratedFaces) {
          const raw = ls.getItem(`gbtunnelface:sketch:${faceId}`);
          if (raw) {
            try {
              const segments = JSON.parse(raw);
              if (Array.isArray(segments) && segments.length > 0) {
                await sketchTable.put({ id: faceId, faceId, segments, _sync: stamp() });
              }
            } catch {
              /* 损坏的素描缓存忽略 */
            }
          }
        }
      });
  }
}

export const db = new TunnelFaceDB();

/**
 * 把 Vue 响应式代理转成可结构化克隆的普通对象。
 * IndexedDB 的 put/add 无法克隆 Proxy，否则抛 DataCloneError。
 */
export function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function markDbVersion(): void {
  try {
    window.localStorage.setItem(LS_VERSION_KEY, String(DB_VERSION));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export function readDbVersion(): number {
  try {
    const raw = window.localStorage.getItem(LS_VERSION_KEY);
    return raw ? Number(raw) : DB_VERSION;
  } catch {
    return DB_VERSION;
  }
}

/** 取一条记录的同步元数据（老数据兜底） */
export function syncMetaOf(row: SyncEntity | Record<string, unknown> | null | undefined): SyncMeta | null {
  const meta = (row as { _sync?: SyncMeta } | null | undefined)?._sync;
  return meta ?? null;
}

/** 首次进入灌入示范掌子面数据（v3 起带版本向量） */
export async function ensureSeedData(): Promise<void> {
  const count = await db.faces.count();
  if (count > 0) return;

  const deviceId = getDeviceId();
  let seq = 0;
  const now = Date.now();
  const hour = 3600 * 1000;
  const day = 24 * hour;

  const face1 = newId('face');
  const face2 = newId('face');

  const stamp = (at: number): SyncMeta => ({ deviceId, vv: { [deviceId]: ++seq }, updatedAt: at });
  const seedOps: LogOp[] = [];
  const log = (
    table: LogOp['table'],
    recordId: string,
    faceRef: string,
    after: SyncEntity | null,
    at: number,
    geologist = '岑柏川',
    base: SyncEntity | null = null,
  ): void => {
    seedOps.push({ seq: ++seq, deviceId, geologist, table, recordId, faceRef, op: 'upsert', after, base, at });
  };

  const faceRow1: TunnelFace & { _sync: SyncMeta } = {
    id: face1,
    faceNo: 'ZK-102',
    chainage: 12480,
    mileageRange: [12480, 12483],
    excavationMethod: '台阶法',
    faceSize: '12.6×9.8',
    lithology: '石灰岩',
    weathering: '微风化',
    rockStrength: 62,
    attitude: { strike: 42, dipDirection: 132, dipAngle: 34 },
    recordedAt: now - 2 * day,
    geologist: '岑柏川',
    _sync: stamp(now - 2 * day),
  };
  const faceRow2: TunnelFace & { _sync: SyncMeta } = {
    id: face2,
    faceNo: 'ZK-103',
    chainage: 12483,
    mileageRange: [12483, 12486],
    excavationMethod: '台阶法',
    faceSize: '12.6×9.8',
    lithology: '泥岩',
    weathering: '强风化',
    rockStrength: 18,
    attitude: { strike: 48, dipDirection: 138, dipAngle: 28 },
    recordedAt: now - 6 * hour,
    geologist: '岑柏川',
    _sync: stamp(now - 6 * hour),
  };
  log('faces', face1, face1, faceRow1, now - 2 * day);
  log('faces', face2, face2, faceRow2, now - 6 * hour);

  const joints: Array<JointSet & { _sync: SyncMeta }> = [
    {
      id: newId('joint'),
      faceId: face1,
      setNo: 1,
      dipDirection: 128,
      dipAngle: 72,
      spacing: 42,
      persistence: 3.6,
      aperture: 1.2,
      fillMaterial: '方解石',
      roughness: '粗糙',
      waterWet: '潮湿',
      jointCount: 9,
      _sync: stamp(now - 2 * day),
    },
    {
      id: newId('joint'),
      faceId: face1,
      setNo: 2,
      dipDirection: 216,
      dipAngle: 46,
      spacing: 68,
      persistence: 2.4,
      aperture: 0.6,
      fillMaterial: '泥质',
      roughness: '平整',
      waterWet: '滴水',
      jointCount: 5,
      _sync: stamp(now - 2 * day),
    },
    {
      id: newId('joint'),
      faceId: face1,
      setNo: 3,
      dipDirection: 312,
      dipAngle: 84,
      spacing: 25,
      persistence: 4.1,
      aperture: 2.4,
      fillMaterial: '无',
      roughness: '起伏粗糙',
      waterWet: '干燥',
      jointCount: 12,
      _sync: stamp(now - 2 * day),
    },
    {
      id: newId('joint'),
      faceId: face2,
      setNo: 1,
      dipDirection: 140,
      dipAngle: 22,
      spacing: 120,
      persistence: 5.2,
      aperture: 3.1,
      fillMaterial: '泥质',
      roughness: '平直光滑',
      waterWet: '线流',
      jointCount: 4,
      _sync: stamp(now - 6 * hour),
    },
  ];
  for (const j of joints) log('joints', j.id, j.faceId, j, j._sync.updatedAt);

  const grades: Array<RockMassGrade & { _sync: SyncMeta }> = [
    {
      id: newId('grade'),
      faceId: face1,
      grade: 'Ⅲ',
      bqValue: 358,
      rqd: 78,
      jv: 6.2,
      kv: 0.61,
      groundwater: '点滴状出水',
      spanWidth: 12.6,
      correction: 0.1,
      correctedBq: 348,
      supportSuggestion: '系统锚杆（φ25，L=3.0 m，间距 1.0 m）+ 喷射混凝土 12 cm + 钢筋网',
      manualAdjusted: false,
      judgedAt: now - 2 * day,
      _sync: stamp(now - 2 * day),
    },
  ];
  for (const g of grades) log('grades', g.id, g.faceId, g, g._sync.updatedAt);

  const waters: Array<WaterInflow & { _sync: SyncMeta }> = [
    {
      id: newId('water'),
      faceId: face1,
      position: '拱顶右侧 3 m',
      type: '滴水',
      estimatedFlow: 6,
      waterTemp: 14,
      waterPressure: 0.12,
      changeTrend: '稳定',
      measuredAt: now - 2 * day,
      chainage: 12478,
      _sync: stamp(now - 2 * day),
    },
    {
      id: newId('water'),
      faceId: face1,
      position: '拱腰右侧',
      type: '线流',
      estimatedFlow: 22,
      waterTemp: 15,
      waterPressure: 0.32,
      changeTrend: '增大',
      measuredAt: now - day,
      chainage: 12481,
      _sync: stamp(now - day),
    },
    {
      id: newId('water'),
      faceId: face1,
      position: '拱脚左侧',
      type: '股状',
      estimatedFlow: 68,
      waterTemp: 16,
      waterPressure: 0.58,
      changeTrend: '突增',
      measuredAt: now - 4 * hour,
      chainage: 12484,
      _sync: stamp(now - 4 * hour),
    },
  ];
  for (const w of waters) log('waters', w.id, w.faceId, w, w._sync.updatedAt);

  await db.transaction(
    'rw',
    [db.faces, db.joints, db.grades, db.waters, db.sketches, db.oplog, db.kv],
    async () => {
      await db.faces.bulkPut([faceRow1, faceRow2]);
      await db.joints.bulkPut(joints);
      await db.grades.bulkPut(grades);
      await db.waters.bulkPut(waters);
      await db.oplog.bulkPut(seedOps);
      await db.kv.put({
        key: 'syncState',
        value: {
          deviceId,
          geologist: '岑柏川',
          seq,
          lastExportSeq: 0,
          ops: [],
          appliedSeqs: {},
        },
      });
    },
  );
  setLocalGeologist('岑柏川');
}
