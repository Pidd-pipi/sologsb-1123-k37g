import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import {
  batchIdFor,
  makeThumbDataUrl,
  type AssetImportRow,
  type AssetStatus,
  type BatchInfo,
  type AssetThumb,
  type ImageAsset,
  type ImageAssetDraft,
  type ImageQuality,
} from '../types/imageasset';

interface ImportResult {
  added: number;
  skipped: number;
  conflicts: number;
}

interface AssetState {
  items: ImageAsset[];
  thumbs: Record<string, string>;
  loaded: boolean;
  load: () => Promise<void>;
  addMany: (drafts: ImageAssetDraft[]) => Promise<ImageAsset[]>;
  importBatch: (missionId: string, missionNo: string, batchNo: string, rows: AssetImportRow[]) => Promise<ImportResult>;
  update: (id: string, patch: Partial<ImageAsset>) => Promise<void>;
  markMany: (ids: string[], quality: ImageQuality) => Promise<void>;
  confirmMany: (ids: string[]) => Promise<void>;
  archiveMany: (ids: string[]) => Promise<void>;
  removeMany: (ids: string[]) => Promise<void>;
  /** 航线参数改动后：未归档（待确认/已确认）成果回到待确认；已归档与冲突保留原值 */
  resetForRouteChange: (missionId: string) => Promise<number>;
  byMission: (missionId: string) => ImageAsset[];
  qualityStats: (missionId: string) => { quality: ImageQuality; count: number }[];
  batchList: (missionId: string) => BatchInfo[];
}

function sortAssets(rows: ImageAsset[]): ImageAsset[] {
  return rows.sort((a, b) => a.imageNo.localeCompare(b.imageNo, 'zh-Hans-CN', { numeric: true }));
}

export const useAssetStore = create<AssetState>((set, get) => ({
  items: [],
  thumbs: {},
  loaded: false,
  async load() {
    const rows = await db.assets.toArray();
    sortAssets(rows);
    const thumbRows = await db.thumbs.toArray();
    const thumbs: Record<string, string> = {};
    thumbRows.forEach((t) => {
      thumbs[t.id] = t.dataUrl;
    });
    set({ items: rows, thumbs, loaded: true });
  },
  async addMany(drafts) {
    const records: ImageAsset[] = drafts.map((d) => ({ ...d, id: newId('asset') }));
    const thumbRecords: AssetThumb[] = records.map((r) => ({
      id: r.id,
      missionId: r.missionId,
      dataUrl: makeThumbDataUrl(r.imageNo, r.quality, r.lng, r.lat),
    }));
    // 缩略图单独建表存放
    await db.assets.bulkPut(records);
    await db.thumbs.bulkPut(thumbRecords);
    const nextThumbs = { ...get().thumbs };
    thumbRecords.forEach((t) => {
      nextThumbs[t.id] = t.dataUrl;
    });
    set({ items: sortAssets([...get().items, ...records]), thumbs: nextThumbs });
    return records;
  },
  async importBatch(missionId, missionNo, batchNo, rows) {
    const batchId = batchIdFor(missionId, batchNo);
    const folder = `/${missionNo}/100MEDIA`;
    const owned: ImageAsset[] = get().items.filter((a) => a.missionId === missionId);
    const newRecords: ImageAsset[] = [];
    const newThumbs: AssetThumb[] = [];
    const statusChanges: { id: string; status: AssetStatus }[] = [];
    let added = 0;
    let skipped = 0;
    let conflicts = 0;

    const makeRecord = (row: AssetImportRow, status: AssetStatus): ImageAsset => {
      const id = newId('asset');
      return {
        id,
        missionId,
        imageNo: row.imageNo,
        lng: row.lng,
        lat: row.lat,
        altitude: row.altitude,
        gsd: row.gsd,
        overlap: row.overlap,
        tiltAngle: 0,
        shotAt: row.shotAt,
        quality: row.quality,
        folder,
        batchId,
        batchNo,
        status,
      };
    };

    for (const row of rows) {
      const same = owned.filter((a) => a.imageNo === row.imageNo);
      // 同批次重复导入：不新增
      if (same.some((a) => a.batchId === batchId)) {
        skipped += 1;
        continue;
      }
      if (same.length > 0) {
        // 不同批次同片号：位置或时间不同即列为冲突
        const isConflict = same.some(
          (a) =>
            Math.abs(a.lng - row.lng) > 1e-6 ||
            Math.abs(a.lat - row.lat) > 1e-6 ||
            Math.abs(a.shotAt - row.shotAt) > 1000,
        );
        if (isConflict) {
          const rec = makeRecord(row, '冲突');
          newRecords.push(rec);
          newThumbs.push({ id: rec.id, missionId, dataUrl: makeThumbDataUrl(rec.imageNo, rec.quality, rec.lng, rec.lat) });
          conflicts += 1;
          // 已有的待确认记录一并置为冲突；已确认/已归档保留原值不动
          same.forEach((a) => {
            if (a.status === '待确认') {
              statusChanges.push({ id: a.id, status: '冲突' });
            }
          });
          owned.push(rec);
          continue;
        }
        // 位置时间一致：视为重复架次，跳过
        skipped += 1;
        continue;
      }
      const rec = makeRecord(row, '待确认');
      newRecords.push(rec);
      newThumbs.push({ id: rec.id, missionId, dataUrl: makeThumbDataUrl(rec.imageNo, rec.quality, rec.lng, rec.lat) });
      owned.push(rec);
      added += 1;
    }

    if (newRecords.length > 0) {
      await db.assets.bulkPut(newRecords);
      await db.thumbs.bulkPut(newThumbs);
    }
    for (const change of statusChanges) {
      await db.assets.update(change.id, { status: change.status });
    }

    const nextThumbs = { ...get().thumbs };
    newThumbs.forEach((t) => {
      nextThumbs[t.id] = t.dataUrl;
    });
    const changedIds = new Set(statusChanges.map((c) => c.id));
    const nextItems = sortAssets(
      get()
        .items.map((it) => (changedIds.has(it.id) ? { ...it, status: '冲突' as AssetStatus } : it))
        .concat(newRecords),
    );
    set({ items: nextItems, thumbs: nextThumbs });
    return { added, skipped, conflicts };
  },
  async update(id, patch) {
    await db.assets.update(id, patch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  },
  async markMany(ids, quality) {
    for (const id of ids) {
      await db.assets.update(id, { quality, status: '已确认' });
    }
    set({
      items: get().items.map((it) => (ids.includes(it.id) ? { ...it, quality, status: '已确认' as AssetStatus } : it)),
    });
  },
  async confirmMany(ids) {
    for (const id of ids) {
      await db.assets.update(id, { status: '已确认' });
    }
    set({ items: get().items.map((it) => (ids.includes(it.id) ? { ...it, status: '已确认' as AssetStatus } : it)) });
  },
  async archiveMany(ids) {
    for (const id of ids) {
      await db.assets.update(id, { status: '已归档' });
    }
    set({ items: get().items.map((it) => (ids.includes(it.id) ? { ...it, status: '已归档' as AssetStatus } : it)) });
  },
  async removeMany(ids) {
    await db.assets.bulkDelete(ids);
    await db.thumbs.bulkDelete(ids);
    const nextThumbs = { ...get().thumbs };
    ids.forEach((id) => {
      delete nextThumbs[id];
    });
    set({ items: get().items.filter((it) => !ids.includes(it.id)), thumbs: nextThumbs });
  },
  async resetForRouteChange(missionId) {
    const targets = get().items.filter(
      (a) => a.missionId === missionId && a.status !== '已归档' && a.status !== '冲突',
    );
    for (const t of targets) {
      await db.assets.update(t.id, { status: '待确认' });
    }
    set({
      items: get().items.map((it) =>
        targets.some((t) => t.id === it.id) ? { ...it, status: '待确认' as AssetStatus } : it,
      ),
    });
    return targets.length;
  },
  byMission(missionId) {
    return get().items.filter((it) => it.missionId === missionId);
  },
  qualityStats(missionId) {
    const list = get().items.filter((it) => it.missionId === missionId);
    return (['合格', '模糊', '过曝'] as ImageQuality[]).map((quality) => ({
      quality,
      count: list.filter((it) => it.quality === quality).length,
    }));
  },
  batchList(missionId) {
    const list = get().items.filter((it) => it.missionId === missionId);
    const map = new Map<string, BatchInfo>();
    list.forEach((a) => {
      let info = map.get(a.batchId);
      if (!info) {
        info = { batchId: a.batchId, batchNo: a.batchNo, count: 0, pendingCount: 0, confirmedCount: 0, conflictCount: 0, archivedCount: 0 };
        map.set(a.batchId, info);
      }
      info.count += 1;
      if (a.status === '待确认') info.pendingCount += 1;
      else if (a.status === '已确认') info.confirmedCount += 1;
      else if (a.status === '冲突') info.conflictCount += 1;
      else if (a.status === '已归档') info.archivedCount += 1;
    });
    return Array.from(map.values()).sort((a, b) => a.batchNo.localeCompare(b.batchNo, 'zh-Hans-CN', { numeric: true }));
  },
}));
