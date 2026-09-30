import type { Attitude } from '../types/face';
import type { JointSet } from '../types/joint';
import { round } from './id';

/** 里程桩号格式化：1234 m → K1+234 */
export function formatChainage(meters: number): string {
  if (!Number.isFinite(meters)) return '—';
  const sign = meters < 0 ? '-' : '';
  const abs = Math.abs(Math.round(meters));
  const km = Math.floor(abs / 1000);
  const m = abs % 1000;
  return `${sign}K${km}+${String(m).padStart(3, '0')}`;
}

/** 解析 K1+234 / 1234 两种写法 */
export function parseChainage(text: string): number {
  const t = text.trim().toUpperCase();
  const kmMatch = t.match(/^-?K?(\d+)\+(\d{1,3})$/);
  if (kmMatch) {
    const km = Number(kmMatch[1]);
    const m = Number(kmMatch[2]);
    const value = km * 1000 + m;
    return t.startsWith('-') ? -value : value;
  }
  const num = Number(t.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(num) ? num : 0;
}

/** 视倾角换算：由真倾角与剖面方向夹角求视倾角（°） */
export function apparentDip(dipAngle: number, angleBetween: number): number {
  const rad = (v: number) => (v * Math.PI) / 180;
  const value = Math.atan(Math.tan(rad(dipAngle)) * Math.sin(rad(angleBetween)));
  return round((value * 180) / Math.PI, 1);
}

/** 由倾向与走向求夹角（°） */
export function angleBetweenStrikeAndDirection(strike: number, direction: number): number {
  let diff = Math.abs(strike - direction) % 180;
  if (diff > 90) diff = 180 - diff;
  return round(diff, 1);
}

/** 产状规范化：倾向 0~360，倾角 0~90 */
export function normalizeAttitude(attitude: Attitude): Attitude {
  let { strike, dipDirection, dipAngle } = attitude;
  strike = ((strike % 360) + 360) % 360;
  dipDirection = ((dipDirection % 360) + 360) % 360;
  if (!Number.isFinite(dipAngle) || dipAngle < 0) dipAngle = 0;
  if (dipAngle > 90) dipAngle = 90;
  return { strike: round(strike, 1), dipDirection: round(dipDirection, 1), dipAngle: round(dipAngle, 1) };
}

/** 产状文字化：倾向/倾角 */
export function attitudeText(dipDirection: number, dipAngle: number): string {
  return `${Math.round(dipDirection)}° ∠ ${Math.round(dipAngle)}°`;
}

/**
 * 节理组聚类：按倾向（30° 一簇）归并，返回每簇的组号、平均倾向/倾角、条数。
 * 用于「同组产状合并」。
 */
export interface JointCluster {
  clusterNo: number;
  dipDirection: number;
  dipAngle: number;
  count: number;
  jointCount: number;
  members: string[];
}

export function clusterJoints(joints: JointSet[], bucket = 30): JointCluster[] {
  const map = new Map<number, JointSet[]>();
  joints.forEach((j) => {
    const key = Math.floor((((j.dipDirection % 360) + 360) % 360) / bucket);
    const list = map.get(key) ?? [];
    list.push(j);
    map.set(key, list);
  });
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, list], index) => ({
      clusterNo: index + 1,
      dipDirection: round(list.reduce((s, j) => s + j.dipDirection, 0) / list.length, 1),
      dipAngle: round(list.reduce((s, j) => s + j.dipAngle, 0) / list.length, 1),
      count: list.length,
      jointCount: list.reduce((s, j) => s + j.jointCount, 0),
      members: list.map((j) => `J${j.setNo}`),
    }));
}

/** 极点图坐标：等面积投影（Schmidt 网） */
export function polarPoint(dipDirection: number, dipAngle: number, radius = 100): { x: number; y: number } {
  const r = radius * Math.SQRT2 * Math.sin(((90 - dipAngle) * Math.PI) / 360);
  const theta = ((dipDirection - 90) * Math.PI) / 180;
  return { x: round(r * Math.cos(theta), 2), y: round(r * Math.sin(theta), 2) };
}

/** 走向玫瑰图分桶（10° 一桶） */
export function roseBuckets(joints: JointSet[], bucket = 10): { label: string; count: number }[] {
  const map = new Map<number, number>();
  joints.forEach((j) => {
    const key = Math.floor((((j.dipDirection % 360) + 360) % 360) / bucket) * bucket;
    map.set(key, (map.get(key) ?? 0) + j.jointCount);
  });
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([deg, count]) => ({ label: `${deg}°`, count }));
}

/** 节理体密度 Jv 近似：按平均间距换算（条/m³） */
export function estimateJv(joints: JointSet[]): number {
  if (joints.length === 0) return 0;
  const sum = joints.reduce((s, j) => s + (j.spacing > 0 ? 100 / j.spacing : 0), 0);
  return round(sum / joints.length, 2);
}
