/**
 * 离线合并引擎 / 同步仓储端到端测试。
 * 用 fake-indexeddb 模拟浏览器库；同伴设备由测试手工构造 WorkPackage 表示。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db, getDeviceId, DB_VERSION } from '../utils/db';
import type { TunnelFace } from '../types/face';
import type { JointSet } from '../types/joint';
import type { WaterInflow } from '../types/water';
import type {
  LogOp,
  SyncEntity,
  SyncMeta,
  VersionVector,
  WorkPackage,
} from '../types/sync';
import { buildMergePlan, resolveConflicts, vvCmp, mergeVV, type ConflictDecision } from '../utils/merge';
import {
  applyMergePlan,
  buildWorkPackage,
  ensureSyncState,
  loadSnapshot,
  parseWorkPackage,
  putSketch,
  upsertEntity,
} from '../utils/syncRepo';

const REMOTE = 'dev_remoteAA';

function meta(deviceId: string, vv: VersionVector, at = Date.now()): SyncMeta {
  return { deviceId, vv, updatedAt: at };
}

/** 构造一条"对方设备"的操作日志 */
function remoteOp(
  seq: number,
  table: LogOp['table'],
  recordId: string,
  faceRef: string,
  after: SyncEntity | null,
  base: SyncEntity | null = null,
): LogOp {
  return {
    seq,
    deviceId: REMOTE,
    geologist: '闻溪山',
    table,
    recordId,
    faceRef,
    op: after ? 'upsert' : 'delete',
    after,
    base,
    at: Date.now(),
  };
}

function remotePkg(ops: LogOp[], faces: WorkPackage['faces'], schemaVersion = DB_VERSION): WorkPackage {
  return {
    kind: 'gbtunnelface-workpack',
    packageFormat: 1,
    schemaVersion,
    packageId: `pkg_test_${Math.random().toString(36).slice(2)}`,
    deviceId: REMOTE,
    geologist: '闻溪山',
    exportedAt: Date.now(),
    deviceSeq: ops.reduce((m, o) => Math.max(m, o.seq), 0),
    sinceSeq: ops[0]?.seq ?? 0,
    faces,
    ops,
  };
}

function faceVersionList(faceId: string, faceNo: string, faceVersion: VersionVector, touched = true) {
  return [{ faceId, faceNo, faceVersion, touched }];
}

async function resetDb() {
  await db.delete();
  await db.open();
  await ensureSyncState();
}

let seedFace: TunnelFace & { _sync: SyncMeta };

async function localUpsert<T extends object>(table: 'faces' | 'joints' | 'grades' | 'waters', row: T) {
  return upsertEntity(table, row as unknown as SyncEntity);
}

beforeEach(async () => {
  await resetDb();
  const deviceId = getDeviceId();
  seedFace = {
    id: 'face_seed',
    faceNo: 'ZK-201',
    chainage: 5000,
    mileageRange: [5000, 5003],
    excavationMethod: '台阶法',
    faceSize: '12.0×9.0',
    lithology: '砂岩',
    weathering: '弱风化',
    rockStrength: 45,
    attitude: { strike: 30, dipDirection: 120, dipAngle: 40 },
    recordedAt: Date.now() - 10000,
    geologist: '岑柏川',
    _sync: undefined as never,
  };
  await localUpsert('faces', seedFace);
  seedFace = (await db.faces.get("face_seed")) as TunnelFace & { _sync: SyncMeta };
});

describe('版本向量', () => {
  it('比较相等 / 领先 / 落后 / 分叉', () => {
    expect(vvCmp({ a: 1 }, { a: 1 })).toBe('equal');
    expect(vvCmp({ a: 2, b: 1 }, { a: 1, b: 1 })).toBe('ahead');
    expect(vvCmp({ a: 1 }, { a: 2 })).toBe('behind');
    expect(vvCmp({ a: 2, b: 1 }, { a: 1, b: 2 })).toBe('forked');
    expect(mergeVV({ a: 2, b: 1 }, { a: 1, b: 3 })).toEqual({ a: 2, b: 3 });
  });
});

describe('离线合并', () => {
  it('不同对象直接并入（对方新建掌子面）', async () => {
    const newFace: TunnelFace & { _sync: SyncMeta } = {
      id: 'face_new',
      faceNo: 'ZK-202',
      chainage: 5010,
      mileageRange: [5010, 5013],
      excavationMethod: '全断面',
      faceSize: '12×9',
      lithology: '花岗岩',
      weathering: '微风化',
      rockStrength: 80,
      attitude: { strike: 0, dipDirection: 90, dipAngle: 60 },
      recordedAt: Date.now(),
      geologist: '闻溪山',
      _sync: meta(REMOTE, { [REMOTE]: 1 }),
    };
    const pkg = remotePkg(
      [remoteOp(1, 'faces', 'face_new', 'face_new', newFace)],
      faceVersionList('face_new', 'ZK-202', { [REMOTE]: 1 }),
    );
    const plan = buildMergePlan(pkg, await loadSnapshot());
    expect(plan.status).toBe('ready');
    expect(plan.summary.creates).toBe(1);
    await applyMergePlan(plan);
    expect(await db.faces.get('face_new')).toBeTruthy();
    // 台账读到同一份结果
    const list = await db.faces.toArray();
    expect(list.length).toBe(2);
  });

  it('同一掌子面关键字段两边改：必须先选冲突，选后按选择合并', async () => {
    const localRow = (await db.faces.get('face_seed'))!;
    // 本机改岩性
    await localUpsert('faces', { ...localRow, lithology: '泥岩' });
    const localAfter = (await db.faces.get('face_seed'))!;

    // 对方也改岩性 + 非关键字段地质员
    const remoteRow: SyncEntity = {
      ...JSON.parse(JSON.stringify(localRow)),
      lithology: '页岩',
      geologist: '闻溪山',
      _sync: meta(REMOTE, { [getDeviceId()]: 1, [REMOTE]: 1 }),
    };
    const pkg = remotePkg(
      [remoteOp(1, 'faces', 'face_seed', 'face_seed', remoteRow, JSON.parse(JSON.stringify(localRow)))],
      faceVersionList('face_seed', 'ZK-201', remoteRow._sync.vv),
    );

    const plan = buildMergePlan(pkg, await loadSnapshot());
    expect(plan.status).toBe('conflicts');
    const conflict = plan.conflicts[0];
    expect(conflict.kind).toBe('field');
    const keyFields = conflict.fields.filter((f) => f.key).map((f) => f.field);
    expect(keyFields).toContain('lithology');
    // 地质员只有对方改了 → 不属于冲突，自动取对方值
    expect(conflict.fields.map((f) => f.field)).not.toContain('geologist');

    // 未选择时拒绝执行
    await expect(applyMergePlan(plan)).rejects.toThrow(/冲突/);

    const decisions = new Map<string, ConflictDecision>();
    decisions.set('faces:face_seed', { fields: { lithology: 'remote' } });
    const finalized = resolveConflicts(plan, decisions, getDeviceId());
    expect(finalized.status).toBe('ready');
    await applyMergePlan(finalized);
    const merged = (await db.faces.get('face_seed'))!;
    expect(merged.lithology).toBe('页岩');
    expect(merged.geologist).toBe('闻溪山');
    // 版本向量汇聚双方
    expect(merged._sync!.vv[REMOTE]).toBe(1);
  });

  it('同一节理组关键字段（组号/产状）两边改：冲突；仅非关键字段一边改：自动取改方', async () => {
    const deviceId = getDeviceId();
    const joint: JointSet = {
      id: 'joint_1',
      faceId: 'face_seed',
      setNo: 1,
      dipDirection: 100,
      dipAngle: 50,
      spacing: 40,
      persistence: 3,
      aperture: 1,
      fillMaterial: '无',
      roughness: '粗糙',
      waterWet: '干燥',
      jointCount: 5,
    };
    await localUpsert('joints', joint);
    const base = (await db.joints.get('joint_1'))!;

    // 场景 A：本机改倾角，对方改倾角 → 冲突
    await localUpsert('joints', { ...base, dipAngle: 55 });
    const remoteA: SyncEntity = {
      ...JSON.parse(JSON.stringify(base)),
      dipAngle: 60,
      _sync: meta(REMOTE, { [deviceId]: 1, [REMOTE]: 1 }),
    };
    const pkgA = remotePkg(
      [remoteOp(1, 'joints', 'joint_1', 'face_seed', remoteA, JSON.parse(JSON.stringify(base)))],
      faceVersionList('face_seed', 'ZK-201', mergeVV(base._sync!.vv, { [REMOTE]: 1 })),
    );
    const planA = buildMergePlan(pkgA, await loadSnapshot());
    expect(planA.status).toBe('conflicts');
    expect(planA.conflicts[0].fields[0].field).toBe('dipAngle');
    expect(planA.conflicts[0].fields[0].key).toBe(true);
    const decisions = new Map<string, ConflictDecision>();
    decisions.set('joints:joint_1', { fields: { dipAngle: 'local' } });
    await applyMergePlan(resolveConflicts(planA, decisions, deviceId));
    expect((await db.joints.get('joint_1'))!.dipAngle).toBe(55);

    // 场景 B：本机未改的另一节理组，对方只改非关键字段 spacing → 自动快进，无冲突
    const joint2: JointSet = {
      ...joint,
      id: 'joint_2',
      setNo: 2,
      spacing: 40,
    };
    await localUpsert('joints', joint2);
    const base2 = (await db.joints.get('joint_2'))!;
    const remoteB: SyncEntity = {
      ...JSON.parse(JSON.stringify(base2)),
      spacing: 88,
      _sync: meta(REMOTE, mergeVV(base2._sync!.vv, { [REMOTE]: 1 })),
    };
    // 此刻本机掌子面的聚合版本：掌子面 {dev:1} + 场景 A 的 joint_1 {dev:2,REMOTE:1} + 新建的 joint_2 {dev:3}
    const mergedFaceVV: VersionVector = { [deviceId]: 3, [REMOTE]: 1 };
    const pkgB = remotePkg(
      [remoteOp(2, 'joints', 'joint_2', 'face_seed', remoteB, JSON.parse(JSON.stringify(base2)))],
      faceVersionList('face_seed', 'ZK-201', mergeVV(mergedFaceVV, { [REMOTE]: 1 })),
    );
    const planB = buildMergePlan(pkgB, await loadSnapshot());
    expect(planB.status).toBe('ready');
    await applyMergePlan(planB);
    expect((await db.joints.get('joint_2'))!.spacing).toBe(88);
    // 场景 A 的本机倾角选择未被影响
    expect((await db.joints.get('joint_1'))!.dipAngle).toBe(55);
  });

  it('重复导入不重复计数', async () => {
    const newFace: SyncEntity = {
      ...JSON.parse(JSON.stringify(seedFace)),
      id: 'face_dup',
      faceNo: 'ZK-299',
      _sync: meta(REMOTE, { [REMOTE]: 1 }),
    } as SyncEntity;
    const pkg = remotePkg(
      [remoteOp(1, 'faces', 'face_dup', 'face_dup', newFace)],
      faceVersionList('face_dup', 'ZK-299', { [REMOTE]: 1 }),
    );
    await applyMergePlan(buildMergePlan(pkg, await loadSnapshot()));
    expect(await db.faces.where('faceNo').equals('ZK-299').count()).toBe(1);

    const plan2 = buildMergePlan(pkg, await loadSnapshot());
    expect(plan2.status).toBe('duplicate');
    expect(plan2.reason).toMatch(/重复导入/);
    await expect(applyMergePlan(plan2)).rejects.toThrow(/重复导入|已合并过/);
    expect(await db.faces.where('faceNo').equals('ZK-299').count()).toBe(1);
  });

  it('掌子面版本过期：拒绝合并并列出受影响内容', async () => {
    const deviceId = getDeviceId();
    const base = (await db.faces.get('face_seed'))!;

    // 模拟真实流程：对方先导出过"一版"（REMOTE:1，改岩性为泥岩），本机已合并
    const remoteV1: SyncEntity = {
      ...JSON.parse(JSON.stringify(base)),
      lithology: '泥岩',
      _sync: meta(REMOTE, { [deviceId]: 1, [REMOTE]: 1 }),
    };
    const pkgV1 = remotePkg(
      [remoteOp(1, 'faces', 'face_seed', 'face_seed', remoteV1, JSON.parse(JSON.stringify(base)))],
      faceVersionList('face_seed', 'ZK-201', remoteV1._sync.vv),
    );
    await applyMergePlan(buildMergePlan(pkgV1, await loadSnapshot()));
    const merged = (await db.faces.get('face_seed'))!;
    expect(merged.lithology).toBe('泥岩');
    expect(merged._sync!.vv[REMOTE]).toBe(1);

    // 现在对方又误拿出导出更早的旧包（REMOTE:1 之前的内容），其声称版本严格落后本机
    const staleRow: SyncEntity = {
      ...JSON.parse(JSON.stringify(base)),
      weathering: '强风化',
      _sync: meta(REMOTE, { [deviceId]: 1, [REMOTE]: 0 }),
    };
    const claimed: VersionVector = { [deviceId]: 1, [REMOTE]: 0 };
    expect(vvCmp(claimed, merged._sync!.vv)).toBe('behind');

    // 用一个全新 packageId、水位从 0 开始的包重放旧内容
    const stalePkg = remotePkg(
      [
        {
          seq: 0,
          deviceId: REMOTE,
          geologist: '闻溪山',
          table: 'faces',
          recordId: 'face_seed',
          faceRef: 'face_seed',
          op: 'upsert',
          after: staleRow,
          base: null,
          at: Date.now(),
        },
      ],
      faceVersionList('face_seed', 'ZK-201', claimed),
    );
    stalePkg.packageId = 'pkg_stale';
    const plan = buildMergePlan(stalePkg, await loadSnapshot());
    expect(plan.status).toBe('rejected');
    expect(plan.reason).toContain('过期');
    expect(plan.affected.join('\n')).toContain('ZK-201');
    await expect(applyMergePlan(plan)).rejects.toThrow(/不可合并|过期/);
    // 本机原记录保留
    expect((await db.faces.get('face_seed'))!.lithology).toBe('泥岩');
    expect((await db.faces.get('face_seed'))!.weathering).toBe('弱风化');
  });

  it('作业包结构版本更高：拒绝', async () => {
    const pkg = remotePkg([], [], DB_VERSION + 1);
    pkg.ops.push(
      remoteOp(1, 'faces', 'face_x', 'face_x', {
        ...JSON.parse(JSON.stringify(seedFace)),
        id: 'face_x',
        faceNo: 'ZK-300',
        _sync: meta(REMOTE, { [REMOTE]: 1 }),
      } as SyncEntity),
    );
    pkg.deviceSeq = 1;
    const plan = buildMergePlan(pkg, await loadSnapshot());
    expect(plan.status).toBe('rejected');
    expect(plan.reason).toContain('结构');
    expect(await db.faces.get('face_x')).toBeUndefined();
  });

  it('水位已覆盖：拒绝为空包过期', async () => {
    const newFace: SyncEntity = {
      ...JSON.parse(JSON.stringify(seedFace)),
      id: 'face_w',
      faceNo: 'ZK-301',
      _sync: meta(REMOTE, { [REMOTE]: 1 }),
    } as SyncEntity;
    const pkg = remotePkg(
      [remoteOp(1, 'faces', 'face_w', 'face_w', newFace)],
      faceVersionList('face_w', 'ZK-301', { [REMOTE]: 1 }),
    );
    await applyMergePlan(buildMergePlan(pkg, await loadSnapshot()));
    const plan2 = buildMergePlan({ ...pkg, packageId: 'pkg_second' }, await loadSnapshot());
    expect(plan2.status).toBe('rejected');
    expect(plan2.reason).toContain('过期');
  });

  it('对方删除、本机改过：冲突，可选保留或删除', async () => {
    const base = (await db.faces.get('face_seed'))!;
    await localUpsert('faces', { ...base, lithology: '泥岩' });
    const localAfter = (await db.faces.get('face_seed'))!;

    const pkg = remotePkg(
      [remoteOp(1, 'faces', 'face_seed', 'face_seed', null, JSON.parse(JSON.stringify(base)))],
      faceVersionList('face_seed', 'ZK-201', { [getDeviceId()]: 1, [REMOTE]: 1 }),
    );
    const plan = buildMergePlan(pkg, await loadSnapshot());
    expect(plan.status).toBe('conflicts');
    expect(plan.conflicts[0].kind).toBe('delete-update');
    void localAfter;

    // 选保留本机
    const decisions = new Map<string, ConflictDecision>();
    decisions.set('faces:face_seed', { recordChoice: 'local' });
    await applyMergePlan(resolveConflicts(plan, decisions, getDeviceId()));
    expect(await db.faces.get('face_seed')).toBeTruthy();
  });

  it('素描不同线段并集', async () => {
    const deviceId = getDeviceId();
    await putSketch('face_seed', [
      { id: 'seg_a', x: 1, y: 1, dipAngle: 40, dipDirection: 120, length: 10, label: 'Ja' },
    ]);
    const localDoc = (await db.sketches.get('face_seed'))!;
    const remoteDoc: SyncEntity = {
      id: 'face_seed',
      faceId: 'face_seed',
      segments: [
        { id: 'seg_a', x: 1, y: 1, dipAngle: 40, dipDirection: 120, length: 10, label: 'Ja' },
        { id: 'seg_b', x: 2, y: 2, dipAngle: 41, dipDirection: 121, length: 11, label: 'Jb' },
      ],
      _sync: meta(REMOTE, mergeVV(localDoc._sync.vv, { [REMOTE]: 1 })),
    };
    const pkg = remotePkg(
      [remoteOp(1, 'sketches', 'face_seed', 'face_seed', remoteDoc, JSON.parse(JSON.stringify(localDoc)))],
      faceVersionList('face_seed', 'ZK-201', remoteDoc._sync.vv),
    );
    const plan = buildMergePlan(pkg, await loadSnapshot());
    expect(plan.status).toBe('ready');
    await applyMergePlan(plan);
    const merged = await db.sketches.get('face_seed');
    expect(merged!.segments.map((s) => s.id).sort()).toEqual(['seg_a', 'seg_b']);
    void deviceId;
  });

  it('同编号各自新建（无共同基线）：冲突二选一', async () => {
    const deviceId = getDeviceId();
    // 对方用不同 id 建了同编号 ZK-201
    const remoteFace: SyncEntity = {
      ...JSON.parse(JSON.stringify(seedFace)),
      id: 'face_otherid',
      lithology: '石灰岩',
      geologist: '闻溪山',
      _sync: meta(REMOTE, { [REMOTE]: 3 }),
    } as SyncEntity;
    const pkg = remotePkg(
      [remoteOp(3, 'faces', 'face_otherid', 'face_otherid', remoteFace)],
      faceVersionList('face_otherid', 'ZK-201', { [REMOTE]: 3 }),
    );
    const plan = buildMergePlan(pkg, await loadSnapshot());
    expect(plan.status).toBe('conflicts');
    expect(plan.conflicts[0].kind).toBe('create-create');
    const decisions = new Map<string, ConflictDecision>();
    decisions.set('faces:face_seed', { recordChoice: 'remote' });
    await applyMergePlan(resolveConflicts(plan, decisions, deviceId));
    // 沿用本机 id，内容换成对方
    const merged = await db.faces.get('face_seed');
    expect(merged!.lithology).toBe('石灰岩');
    expect(await db.faces.get('face_otherid')).toBeUndefined();
  });
});

describe('导出/导入往返与失败保护', () => {
  it('本机导出的作业包可被解析并自识别为重复', async () => {
    const { pkg } = await buildWorkPackage();
    const reparsed = parseWorkPackage(JSON.stringify(pkg));
    expect(reparsed.packageId).toBe(pkg.packageId);
    // 自己导出的包再导回：设备相同 → 全部 seq ≤ 水位 → 过期拒绝（不覆盖自己）
    const plan = buildMergePlan(reparsed, await loadSnapshot());
    expect(['rejected', 'duplicate']).toContain(plan.status);
  });

  it('涌水记录作为不同对象并入后，趋势数据读到合并结果', async () => {
    const water: WaterInflow & { _sync: SyncMeta } = {
      id: 'water_1',
      faceId: 'face_seed',
      position: '拱顶',
      type: '线流',
      estimatedFlow: 33,
      waterTemp: 15,
      waterPressure: 0.2,
      changeTrend: '增大',
      measuredAt: Date.now(),
      chainage: 5002,
      _sync: meta(REMOTE, { [REMOTE]: 1 }),
    };
    const pkg = remotePkg(
      [remoteOp(1, 'waters', 'water_1', 'face_seed', water)],
      faceVersionList('face_seed', 'ZK-201', mergeVV(seedFace._sync.vv, { [REMOTE]: 1 })),
    );
    await applyMergePlan(buildMergePlan(pkg, await loadSnapshot()));
    const rows = await db.waters.where('faceId').equals('face_seed').toArray();
    expect(rows.length).toBe(1);
    expect(rows[0].estimatedFlow).toBe(33);
  });

  it('非法文件被拒绝', () => {
    expect(() => parseWorkPackage('{oops')).toThrow(/JSON/);
    expect(() => parseWorkPackage(JSON.stringify({ kind: 'other' }))).toThrow(/作业包标识/);
  });
});
