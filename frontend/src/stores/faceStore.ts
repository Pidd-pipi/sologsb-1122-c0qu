import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { removeEntity, upsertEntity } from '../utils/syncRepo';
import type { SyncEntity } from '../types/sync';
import type { TunnelFace, TunnelFaceDraft } from '../types/face';

interface FaceState {
  items: TunnelFace[];
  loaded: boolean;
}

export const useFaceStore = defineStore('face', {
  state: (): FaceState => ({ items: [], loaded: false }),
  getters: {
    byId: (state) => (id: string) => state.items.find((it) => it.id === id),
    latest: (state) =>
      [...state.items].sort((a, b) => b.chainage - a.chainage)[0],
  },
  actions: {
    async load() {
      const rows = await db.faces.toArray();
      rows.sort((a, b) => b.chainage - a.chainage);
      this.items = rows as TunnelFace[];
      this.loaded = true;
    },
    async add(draft: TunnelFaceDraft) {
      const record = { ...toPlain(draft), id: newId('face'), recordedAt: Date.now() };
      const saved = (await upsertEntity('faces', record as unknown as SyncEntity)) as unknown as TunnelFace;
      this.items = [...this.items, saved].sort((a, b) => b.chainage - a.chainage);
      return saved;
    },
    async update(id: string, patch: Partial<TunnelFace>) {
      const current = await db.faces.get(id);
      if (!current) return;
      const merged = { ...toPlain(current), ...toPlain(patch) } as unknown as SyncEntity;
      const saved = (await upsertEntity('faces', merged)) as unknown as TunnelFace;
      this.items = this.items.map((it) => (it.id === id ? saved : it));
    },
    async remove(id: string) {
      // 连带子记录（节理/级别/涌水/素描）由同步仓储统一删除并各自记操作日志
      await removeEntity('faces', id);
      this.items = this.items.filter((it) => it.id !== id);
    },
    /** 复制上一循环（里程更小的最近一个掌子面）的信息作为草稿 */
    previousDraft(id: string): TunnelFaceDraft | undefined {
      const current = this.items.find((it) => it.id === id);
      if (!current) return undefined;
      const prev = [...this.items]
        .filter((it) => it.chainage < current.chainage)
        .sort((a, b) => b.chainage - a.chainage)[0];
      if (!prev) return undefined;
      const { id: _omit, recordedAt: _omit2, ...draft } = prev;
      return toPlain(draft);
    },
  },
});
