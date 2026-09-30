/** 出水类型 */
export type InflowType = '渗水' | '滴水' | '线流' | '股状';

export const INFLOW_TYPES: InflowType[] = ['渗水', '滴水', '线流', '股状'];

/** 变化趋势 */
export type ChangeTrend = '减小' | '稳定' | '增大' | '突增';

export const CHANGE_TRENDS: ChangeTrend[] = ['减小', '稳定', '增大', '突增'];

/** 涌水记录 */
export interface WaterInflow {
  id: string;
  faceId: string;
  /** 出水部位 */
  position: string;
  type: InflowType;
  /** 估算涌水量 L/min */
  estimatedFlow: number;
  /** 水温 ℃ */
  waterTemp: number;
  /** 水压 MPa */
  waterPressure: number;
  changeTrend: ChangeTrend;
  measuredAt: number;
  /** 沿里程位置（米），用于趋势折线 */
  chainage: number;
}

export type WaterInflowDraft = Omit<WaterInflow, 'id' | 'measuredAt'>;

/** 是否突变点（趋势突增或涌水量超过阈值） */
export function isSurge(point: WaterInflow, all: WaterInflow[]): boolean {
  if (point.changeTrend === '突增') return true;
  const sorted = [...all].sort((a, b) => a.chainage - b.chainage);
  const index = sorted.findIndex((p) => p.id === point.id);
  if (index <= 0) return false;
  const prev = sorted[index - 1];
  if (prev.estimatedFlow <= 0) return false;
  return point.estimatedFlow / prev.estimatedFlow >= 2;
}
