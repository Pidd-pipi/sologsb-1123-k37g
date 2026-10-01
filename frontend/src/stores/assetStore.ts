import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { isSamePhoto } from '../utils/sortie';
import {
  makeThumbDataUrl,
  type AssetThumb,
  type ImageAsset,
  type SortieImportResult,
  type SortieRowInput,
} from '../types/imageasset';

interface AssetState {
  items: ImageAsset[];
  thumbs: Record<string, string>;
  loaded: boolean;
  load: () => Promise<void>;
  /**
   * 架次清单接进成果页并与台账对账：
   * - 同批次同片号：重复导入不新增
   * - 不同批次同片号且位置/时间一致：合并更新（人工确认过的质量不动）
   * - 不同批次同片号且位置或时间不同：双方列为冲突，原值全部保留
   */
  importSorties: (
    missionId: string,
    batchId: string,
    rows: SortieRowInput[],
    lineVersion: number,
    folderFallback: string,
  ) => Promise<SortieImportResult>;
  update: (id: string, patch: Partial<ImageAsset>) => Promise<void>;
  /** 多选标记质量：标记即视为人工确认，后续合并/重导不再覆盖 */
  markMany: (ids: string[], quality: ImageAsset['quality']) => Promise<void>;
  /** 确认通过（状态 → 已确认，不改动质量） */
  confirmMany: (ids: string[]) => Promise<void>;
  /** 归档（已归档与冲突记录保留原值，归档记录不参与航线改动重认） */
  archiveMany: (ids: string[]) => Promise<void>;
  /**
   * 解决「同片号冲突」：保留 winner、删除 loser；
   * 已归档的一方法定保留，不能被删除。
   */
  resolveConflict: (winnerId: string, loserId: string) => Promise<void>;
  /**
   * 航线参数改动后：未归档且非冲突的成果回退为待确认，
   * 已归档与冲突记录保留原值。返回受影响条数。
   */
  invalidateForLineChange: (missionId: string, lineUpdatedAt: number) => Promise<number>;
  removeMany: (ids: string[]) => Promise<void>;
  byMission: (missionId: string) => ImageAsset[];
  qualityStats: (missionId: string) => { quality: ImageAsset['quality']; count: number }[];
}

export const useAssetStore = create<AssetState>((set, get) => ({
  items: [],
  thumbs: {},
  loaded: false,
  async load() {
    const rows = await db.assets.toArray();
    rows.sort((a, b) => a.imageNo.localeCompare(b.imageNo, 'zh-Hans-CN', { numeric: true }));
    const thumbRows = await db.thumbs.toArray();
    const thumbs: Record<string, string> = {};
    thumbRows.forEach((t) => {
      thumbs[t.id] = t.dataUrl;
    });
    set({ items: rows, thumbs, loaded: true });
  },
  async importSorties(missionId, batchId, rows, lineVersion, folderFallback) {
    const result: SortieImportResult = { added: 0, duplicated: 0, merged: 0, conflicted: 0, invalid: [] };
    const existing = await db.assets.where('missionId').equals(missionId).toArray();
    const byImageNo = new Map<string, ImageAsset[]>();
    existing.forEach((a) => {
      const list = byImageNo.get(a.imageNo) ?? [];
      list.push(a);
      byImageNo.set(a.imageNo, list);
    });

    const newRecords: ImageAsset[] = [];
    const newThumbs: AssetThumb[] = [];
    const putRecords: ImageAsset[] = [];
    const now = Date.now();

    rows.forEach((row, index) => {
      const peers = byImageNo.get(row.imageNo) ?? [];

      // 同批次重复导入：整行不新增
      if (peers.some((p) => p.batchId === batchId)) {
        result.duplicated += 1;
        return;
      }

      const samePhoto = peers.find((p) => !p.conflictWith && isSamePhoto(p, row));
      if (samePhoto) {
        // 同一影像的重飞/补传：更新测量值，人工确认的质量与原状态保留
        const merged: ImageAsset = {
          ...samePhoto,
          lng: row.lng,
          lat: row.lat,
          shotAt: row.shotAt,
          altitude: row.altitude || samePhoto.altitude,
          gsd: row.gsd,
          overlap: row.overlap,
          tiltAngle: row.tiltAngle || samePhoto.tiltAngle,
          quality: samePhoto.qualityTouched ? samePhoto.quality : row.quality,
          folder: samePhoto.folder || row.folder || folderFallback,
        };
        putRecords.push(merged);
        newThumbs.push({ id: merged.id, missionId, dataUrl: makeThumbDataUrl(merged.imageNo, merged.quality, merged.lng, merged.lat) });
        byImageNo.set(row.imageNo, peers.map((p) => (p.id === samePhoto.id ? merged : p)));
        result.merged += 1;
        return;
      }

      const record: ImageAsset = {
        id: newId('asset'),
        missionId,
        imageNo: row.imageNo,
        lng: row.lng,
        lat: row.lat,
        altitude: row.altitude,
        gsd: row.gsd,
        overlap: row.overlap,
        tiltAngle: row.tiltAngle,
        shotAt: row.shotAt,
        quality: row.quality,
        folder: row.folder || folderFallback,
        batchId,
        sortie: row.sortie,
        importedAt: now + index,
        status: '待确认',
        qualityTouched: false,
        lineVersion,
      };
      newRecords.push(record);
      newThumbs.push({ id: record.id, missionId, dataUrl: makeThumbDataUrl(record.imageNo, record.quality, record.lng, record.lat) });

      // 不同批次同片号但位置或时间不同 → 与对端互相标记冲突，双方原值保留
      const conflictPeer = peers.find((p) => !p.conflictWith);
      if (conflictPeer) {
        record.conflictWith = conflictPeer.id;
        const flaggedPeer: ImageAsset = { ...conflictPeer, conflictWith: record.id };
        putRecords.push(flaggedPeer);
        byImageNo.set(row.imageNo, peers.map((p) => (p.id === conflictPeer.id ? flaggedPeer : p)).concat(record));
        result.conflicted += 1;
      } else {
        byImageNo.set(row.imageNo, peers.concat(record));
        result.added += 1;
      }
    });

    await db.transaction('rw', [db.assets, db.thumbs], async () => {
      if (newRecords.length) await db.assets.bulkPut(newRecords);
      if (putRecords.length) await db.assets.bulkPut(putRecords);
      if (newThumbs.length) await db.thumbs.bulkPut(newThumbs);
    });
    await get().load();
    return result;
  },
  async update(id, patch) {
    await db.assets.update(id, patch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  },
  async markMany(ids, quality) {
    const updates = get()
      .items.filter((it) => ids.includes(it.id))
      .map((it) => ({ ...it, quality, qualityTouched: true }));
    await db.assets.bulkPut(updates);
    set({
      items: get().items.map((it) => (ids.includes(it.id) ? { ...it, quality, qualityTouched: true } : it)),
    });
  },
  async confirmMany(ids) {
    const targets = get()
      .items.filter((it) => ids.includes(it.id) && it.status !== '已归档' && !it.conflictWith)
      .map((it) => ({ ...it, status: '已确认' as const }));
    await db.assets.bulkPut(targets);
    set({
      items: get().items.map((it) =>
        ids.includes(it.id) && it.status !== '已归档' && !it.conflictWith ? { ...it, status: '已确认' } : it,
      ),
    });
  },
  async archiveMany(ids) {
    const targets = get()
      .items.filter((it) => ids.includes(it.id) && !it.conflictWith)
      .map((it) => ({ ...it, status: '已归档' as const }));
    await db.assets.bulkPut(targets);
    set({
      items: get().items.map((it) => (ids.includes(it.id) && !it.conflictWith ? { ...it, status: '已归档' } : it)),
    });
  },
  async resolveConflict(winnerId, loserId) {
    const winner = get().items.find((it) => it.id === winnerId);
    const loser = get().items.find((it) => it.id === loserId);
    if (!winner || !loser || winner.conflictWith !== loser.id || loser.conflictWith !== winner.id) return;
    // 已归档一方法定保留：不允许删除归档记录
    if (loser.status === '已归档') return;
    const kept: ImageAsset = {
      ...winner,
      conflictWith: undefined,
      // 冲突解决即完成对账；保留方原本已归档的继续归档，其余进入已确认
      status: winner.status === '已归档' ? '已归档' : '已确认',
    };
    await db.transaction('rw', [db.assets, db.thumbs], async () => {
      await db.assets.put(kept);
      await db.assets.delete(loserId);
      await db.thumbs.delete(loserId);
    });
    const nextThumbs = { ...get().thumbs };
    delete nextThumbs[loserId];
    set({
      items: get()
        .items.filter((it) => it.id !== loserId)
        .map((it) => (it.id === winnerId ? kept : it)),
      thumbs: nextThumbs,
    });
  },
  async invalidateForLineChange(missionId, lineUpdatedAt) {
    const targets = get()
      .items.filter((it) => it.missionId === missionId && it.status !== '已归档' && !it.conflictWith)
      .map((it) => ({ ...it, status: '待确认' as const, lineVersion: lineUpdatedAt }));
    if (targets.length === 0) return 0;
    await db.assets.bulkPut(targets);
    const idSet = new Set(targets.map((t) => t.id));
    set({
      items: get().items.map((it) =>
        idSet.has(it.id) ? { ...it, status: '待确认', lineVersion: lineUpdatedAt } : it,
      ),
    });
    return targets.length;
  },
  async removeMany(ids) {
    // 删除一条冲突记录时，解除对端的冲突标记（对端回到待确认，原值保留）
    const unlinked = get()
      .items.filter((it) => ids.includes(it.conflictWith ?? ''))
      .map((it) => ({
        ...it,
        conflictWith: undefined,
        status: (it.status === '已归档' ? '已归档' : '待确认') as ImageAsset['status'],
      }));
    await db.assets.bulkPut(unlinked);
    await db.assets.bulkDelete(ids);
    await db.thumbs.bulkDelete(ids);
    const nextThumbs = { ...get().thumbs };
    ids.forEach((id) => {
      delete nextThumbs[id];
    });
    const unlinkMap = new Map(unlinked.map((u) => [u.id, u]));
    set({
      items: get()
        .items.filter((it) => !ids.includes(it.id))
        .map((it) => unlinkMap.get(it.id) ?? it),
      thumbs: nextThumbs,
    });
  },
  byMission(missionId) {
    return get().items.filter((it) => it.missionId === missionId);
  },
  qualityStats(missionId) {
    const list = get().items.filter((it) => it.missionId === missionId);
    return (['合格', '模糊', '过曝'] as ImageAsset['quality'][]).map((quality) => ({
      quality,
      count: list.filter((it) => it.quality === quality).length,
    }));
  },
}));
