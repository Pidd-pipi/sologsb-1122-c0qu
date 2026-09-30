import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { removeEntity, upsertEntity } from '../utils/syncRepo';
import type { SyncEntity } from '../types/sync';
import type { JointSet, JointSetDraft } from '../types/joint';

interface JointState {
  items: JointSet[];
  loaded: boolean;
}

export const useJointStore = defineStore('joint', {
  state: (): JointState => ({ items: [], loaded: false }),
  getters: {
    byFace: (state) => (faceId: string) =>
      state.items.filter((it) => it.faceId === faceId).sort((a, b) => a.setNo - b.setNo),
  },
  actions: {
    async load() {
      const rows = await db.joints.toArray();
      rows.sort((a, b) => a.setNo - b.setNo);
      this.items = rows as JointSet[];
      this.loaded = true;
    },
    async add(draft: JointSetDraft) {
      const record = { ...toPlain(draft), id: newId('joint') };
      const saved = (await upsertEntity('joints', record as unknown as SyncEntity)) as unknown as JointSet;
      this.items = [...this.items, saved];
      return saved;
    },
    async update(id: string, patch: Partial<JointSet>) {
      const current = await db.joints.get(id);
      if (!current) return;
      const merged = { ...toPlain(current), ...toPlain(patch) } as unknown as SyncEntity;
      const saved = (await upsertEntity('joints', merged)) as unknown as JointSet;
      this.items = this.items.map((it) => (it.id === id ? saved : it));
    },
    async remove(id: string) {
      await removeEntity('joints', id);
      this.items = this.items.filter((it) => it.id !== id);
    },
    /** 把同组产状合并到指定组：把被合并组的条数累加到目标组并删除被合并组 */
    async mergeInto(targetId: string, sourceIds: string[]) {
      const target = this.items.find((it) => it.id === targetId);
      if (!target) return;
      const sources = this.items.filter((it) => sourceIds.includes(it.id));
      const extra = sources.reduce((s, j) => s + j.jointCount, 0);
      await this.update(targetId, { jointCount: target.jointCount + extra });
      for (const s of sources) {
        await this.remove(s.id);
      }
    },
  },
});
