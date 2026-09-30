import { defineStore } from 'pinia';
import {
  applyMerge,
  buildPackage,
  captureBaseSnapshot,
  listImports,
  previewMerge,
} from '../utils/merge';
import type { ConflictResolutions, ImportRecord, MergePreview, WorkPackage } from '../types/package';

interface MergeState {
  /** 当前正在预览的作业包 */
  pkg: WorkPackage | null;
  /** 预览结果 */
  preview: MergePreview | null;
  /** 冲突选择：key -> 'local' | 'incoming' */
  resolutions: ConflictResolutions;
  /** 导入历史 */
  imports: ImportRecord[];
  loaded: boolean;
}

export const useMergeStore = defineStore('merge', {
  state: (): MergeState => ({
    pkg: null,
    preview: null,
    resolutions: {},
    imports: [],
    loaded: false,
  }),
  getters: {
    /** 是否存在未解决的冲突 */
    hasConflicts: (state) => (state.preview?.conflicts.length ?? 0) > 0,
    /** 是否存在过期掌子面 */
    hasStale: (state) => (state.preview?.staleFaces.length ?? 0) > 0,
    /** 是否可以合并：所有冲突（含过期掌子面）都已选择保留方式，且非重复/错误 */
    canMerge: (state) => {
      if (!state.preview || state.preview.status === 'duplicate' || state.preview.status === 'error') return false;
      return state.preview.conflicts.every((c) => state.resolutions[`${c.table}:${c.id}`]);
    },
  },
  actions: {
    async loadImports() {
      this.imports = await listImports();
      this.loaded = true;
    },
    /** 采集当前数据为基准快照 */
    async captureBase() {
      await captureBaseSnapshot();
    },
    /** 构建作业包 */
    async buildPackage(geologist: string, note = ''): Promise<WorkPackage> {
      return await buildPackage(geologist, note);
    },
    /** 解析作业包并预览 */
    async runPreview(pkg: WorkPackage) {
      this.pkg = pkg;
      this.resolutions = {};
      this.preview = await previewMerge(pkg);
      return this.preview;
    },
    /** 选择冲突解决方式 */
    setResolution(key: string, value: 'local' | 'incoming') {
      this.resolutions = { ...this.resolutions, [key]: value };
    },
    /** 一键全部保留本机 */
    resolveAllLocal() {
      const next: ConflictResolutions = {};
      for (const c of this.preview?.conflicts ?? []) {
        next[`${c.table}:${c.id}`] = 'local';
      }
      this.resolutions = next;
    },
    /** 一键全部采用作业包 */
    resolveAllIncoming() {
      const next: ConflictResolutions = {};
      for (const c of this.preview?.conflicts ?? []) {
        next[`${c.table}:${c.id}`] = 'incoming';
      }
      this.resolutions = next;
    },
    /** 应用合并 */
    async apply() {
      if (!this.pkg) throw new Error('未加载作业包');
      const result = await applyMerge(this.pkg, this.resolutions);
      this.pkg = null;
      this.preview = null;
      this.resolutions = {};
      await this.loadImports();
      return result;
    },
    /** 重置预览 */
    resetPreview() {
      this.pkg = null;
      this.preview = null;
      this.resolutions = {};
    },
  },
});
