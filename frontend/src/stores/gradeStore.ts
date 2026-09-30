import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { removeEntity, upsertEntity } from '../utils/syncRepo';
import type { SyncEntity } from '../types/sync';
import type { RockMassGrade, RockMassGradeDraft } from '../types/grade';
import type { WaterInflow, WaterInflowDraft } from '../types/water';

interface GradeState {
  items: RockMassGrade[];
  waters: WaterInflow[];
  loaded: boolean;
}

export const useGradeStore = defineStore('grade', {
  state: (): GradeState => ({ items: [], waters: [], loaded: false }),
  getters: {
    byFace: (state) => (faceId: string) =>
      state.items.filter((it) => it.faceId === faceId).sort((a, b) => b.judgedAt - a.judgedAt),
    latestByFace: (state) => (faceId: string) =>
      state.items.filter((it) => it.faceId === faceId).sort((a, b) => b.judgedAt - a.judgedAt)[0],
    watersByFace: (state) => (faceId: string) =>
      state.waters.filter((it) => it.faceId === faceId).sort((a, b) => a.chainage - b.chainage),
  },
  actions: {
    async load() {
      const grades = await db.grades.toArray();
      this.items = grades.sort((a, b) => b.judgedAt - a.judgedAt) as RockMassGrade[];
      const waters = await db.waters.toArray();
      this.waters = waters.sort((a, b) => a.chainage - b.chainage) as WaterInflow[];
      this.loaded = true;
    },
    async addGrade(draft: RockMassGradeDraft) {
      const record = { ...toPlain(draft), id: newId('grade'), judgedAt: Date.now() };
      const saved = (await upsertEntity('grades', record as unknown as SyncEntity)) as unknown as RockMassGrade;
      this.items = [saved, ...this.items];
      return saved;
    },
    async addWater(draft: WaterInflowDraft) {
      const record = { ...toPlain(draft), id: newId('water'), measuredAt: Date.now() };
      const saved = (await upsertEntity('waters', record as unknown as SyncEntity)) as unknown as WaterInflow;
      this.waters = [...this.waters, saved].sort((a, b) => a.chainage - b.chainage);
      return saved;
    },
    async removeWater(id: string) {
      await removeEntity('waters', id);
      this.waters = this.waters.filter((it) => it.id !== id);
    },
  },
});
