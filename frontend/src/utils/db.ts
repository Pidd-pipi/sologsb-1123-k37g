import Dexie, { type Table } from 'dexie';
import type { CameraPreset, Mission } from '../types/mission';
import type { Waypoint } from '../types/waypoint';
import type { FlightLine } from '../types/flightline';
import { makeThumbDataUrl, type AssetThumb, type ImageAsset } from '../types/imageasset';
import { newId } from './id';

export const DB_NAME = 'gbdronemap';
export const DB_VERSION = 3;
export const LS_VERSION_KEY = 'gbdronemap:db-version';

class DroneMapDB extends Dexie {
  missions!: Table<Mission, string>;
  waypoints!: Table<Waypoint, string>;
  lines!: Table<FlightLine, string>;
  assets!: Table<ImageAsset, string>;
  thumbs!: Table<AssetThumb, string>;
  presets!: Table<CameraPreset, string>;

  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      missions: 'id, missionNo, areaName, droneModel, flightDate, status, createdAt',
      waypoints: 'id, missionId, seq, action',
      lines: 'id, missionId, lineNo',
      assets: 'id, missionId, imageNo, quality',
      thumbs: 'id, missionId',
      presets: 'id, name, cameraModel',
    });
    this.version(2)
      .stores({
        missions: 'id, missionNo, areaName, droneModel, flightDate, status, purpose, createdAt',
        waypoints: 'id, missionId, seq, action, altitude',
        lines: 'id, missionId, lineNo, updatedAt',
        assets: 'id, missionId, imageNo, quality, shotAt',
        thumbs: 'id, missionId',
        presets: 'id, name, cameraModel',
      })
      .upgrade(async (tx) => {
        await tx
          .table('missions')
          .toCollection()
          .modify((row: any) => {
            if (!row.areaPolygon) row.areaPolygon = [];
            if (row.sensorWidth === undefined) row.sensorWidth = 13.2;
            if (row.sensorHeight === undefined) row.sensorHeight = 8.8;
            if (row.focalLength === undefined) row.focalLength = 8.8;
            if (row.pixelSize === undefined) row.pixelSize = 2.4;
          });
        await tx
          .table('lines')
          .toCollection()
          .modify((row: any) => {
            if (row.updatedAt === undefined) row.updatedAt = Date.now();
            if (row.batteryCount === undefined) row.batteryCount = 1;
          });
      });
    // v3：成果影像接入架次清单（批次/架次/确认状态/冲突对/航线参数版本）
    this.version(3)
      .stores({
        missions: 'id, missionNo, areaName, droneModel, flightDate, status, purpose, createdAt',
        waypoints: 'id, missionId, seq, action, altitude',
        lines: 'id, missionId, lineNo, updatedAt',
        assets: 'id, missionId, imageNo, quality, shotAt, batchId, status, conflictWith',
        thumbs: 'id, missionId',
        presets: 'id, name, cameraModel',
      })
      .upgrade(async (tx) => {
        const lineRows: FlightLine[] = await tx.table('lines').toCollection().toArray();
        const lineVersionOf = new Map<string, number>();
        lineRows.forEach((l: any) => {
          lineVersionOf.set(l.missionId, Number(l.updatedAt ?? 0));
        });
        await tx
          .table('assets')
          .toCollection()
          .modify((row: any) => {
            if (!row.batchId) row.batchId = 'LEGACY';
            if (row.importedAt === undefined) row.importedAt = Number(row.shotAt ?? Date.now());
            if (row.status !== '待确认' && row.status !== '已确认' && row.status !== '已归档') {
              row.status = '已确认';
            }
            if (row.qualityTouched === undefined) row.qualityTouched = true;
            if (row.lineVersion === undefined) row.lineVersion = lineVersionOf.get(row.missionId) ?? 0;
            if (!row.conflictWith) delete row.conflictWith;
          });
      });
  }
}

export const db = new DroneMapDB();

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

/** 读取某任务的航线参数（每任务一条） */
export async function loadFlightLine(missionId: string): Promise<FlightLine | undefined> {
  const rows = await db.lines.where('missionId').equals(missionId).toArray();
  return rows.sort((a, b) => a.lineNo - b.lineNo)[0];
}

/** 保存 / 更新航线参数 */
export async function saveFlightLine(line: FlightLine): Promise<void> {
  await db.lines.put(line);
}

/** 按航线参数把任务拆分为多架次（每架次按电池组数分组） */
export function splitSorties(line: FlightLine): { sortie: number; photos: number; durationMin: number }[] {
  const perSortie = 20; // 每组电池有效续航 20 min
  const count = Math.max(1, Math.ceil(line.estDuration / perSortie));
  const photosPer = Math.ceil(line.estPhotos / count);
  const durationPer = Math.round((line.estDuration / count) * 10) / 10;
  return Array.from({ length: count }, (_, i) => ({
    sortie: i + 1,
    photos: photosPer,
    durationMin: durationPer,
  }));
}

/** 影响成果确认的航线参数签名：改动后未归档成果需重新确认 */
export function lineSignature(line: Pick<FlightLine, 'spacing' | 'photoInterval' | 'overlapForward' | 'overlapSide' | 'gsd' | 'estPhotos' | 'estDuration' | 'batteryCount' | 'heading'>): string {
  return [
    line.spacing,
    line.photoInterval,
    line.overlapForward,
    line.overlapSide,
    line.gsd,
    line.estPhotos,
    line.estDuration,
    line.batteryCount,
    line.heading,
  ].join('|');
}

/** 首次进入灌入示范任务、航点、航线参数与成果影像条目 */
export async function ensureSeedData(): Promise<void> {
  const count = await db.missions.count();
  if (count > 0) return;

  const now = Date.now();
  const day = 24 * 3600 * 1000;

  const missionA = newId('mission');
  const missionB = newId('mission');

  const polygonA: [number, number][] = [
    [116.3912, 39.9075],
    [116.3978, 39.9075],
    [116.3978, 39.9032],
    [116.3912, 39.9032],
  ];
  const polygonB: [number, number][] = [
    [121.4726, 31.2321],
    [121.4789, 31.2334],
    [121.4796, 31.2288],
  ];

  const missions: Mission[] = [
    {
      id: missionA,
      missionNo: 'DM-2024-018',
      name: '中心城区正射影像采集',
      areaName: '北京东城测区',
      areaPolygon: polygonA,
      purpose: '正射',
      droneModel: 'Mavic 3E',
      cameraModel: 'DJI 4/3 CMOS 20MP',
      sensorWidth: 17.3,
      sensorHeight: 13,
      focalLength: 12.29,
      pixelSize: 3.3,
      flightDate: '2024-09-12',
      pilot: '穆清和',
      status: '已飞行',
      createdAt: now - 30 * day,
    },
    {
      id: missionB,
      missionNo: 'DM-2024-021',
      name: '滨江带状倾斜摄影',
      areaName: '上海浦东滨江带',
      areaPolygon: polygonB,
      purpose: '带状',
      droneModel: 'M300 RTK',
      cameraModel: 'Zenmuse P1',
      sensorWidth: 35.9,
      sensorHeight: 24,
      focalLength: 35,
      pixelSize: 4.4,
      flightDate: '2024-09-20',
      pilot: '纪长风',
      status: '待飞行',
      createdAt: now - 8 * day,
    },
  ];

  const waypoints: Waypoint[] = [];
  // 示范任务 A：4 个航点形成一条覆盖测区的折线
  const wpsA: [number, number][] = [
    [116.3912, 39.9075],
    [116.3978, 39.9075],
    [116.3978, 39.9032],
    [116.3912, 39.9032],
  ];
  wpsA.forEach(([lng, lat], index) => {
    waypoints.push({
      id: newId('wp'),
      missionId: missionA,
      seq: index + 1,
      lng,
      lat,
      altitude: 120,
      speed: 8,
      heading: 90,
      gimbalPitch: -90,
      action: index === wpsA.length - 1 ? '悬停' : '拍照',
      hoverSec: index === wpsA.length - 1 ? 5 : 0,
    });
  });
  waypoints.push({
    id: newId('wp'),
    missionId: missionB,
    seq: 1,
    lng: 121.4726,
    lat: 31.2321,
    altitude: 150,
    speed: 10,
    heading: 45,
    gimbalPitch: -60,
    action: '拍照',
    hoverSec: 0,
  });

  const lines: FlightLine[] = [
    {
      id: newId('line'),
      missionId: missionA,
      lineNo: 1,
      spacing: 62.5,
      photoInterval: 24.8,
      overlapForward: 75,
      overlapSide: 70,
      gsd: 3.22,
      estPhotos: 12,
      estDuration: 3.6,
      batteryCount: 1,
      heading: 90,
      updatedAt: now - 30 * day,
    },
    {
      id: newId('line'),
      missionId: missionB,
      lineNo: 1,
      spacing: 92.3,
      photoInterval: 42.1,
      overlapForward: 70,
      overlapSide: 65,
      gsd: 1.89,
      estPhotos: 9,
      estDuration: 4.2,
      batteryCount: 1,
      heading: 45,
      updatedAt: now - 8 * day,
    },
  ];

  const assets: ImageAsset[] = [];
  const thumbs: AssetThumb[] = [];
  const lineVersionA = lines[0].updatedAt;
  const batch1 = 'B-20240912-01';
  const batch2 = 'B-20240912-02';
  const importedAt1 = lineVersionA + 2 * 3600 * 1000;
  const importedAt2 = lineVersionA + 6 * 3600 * 1000;
  // 预先分配 id，便于冲突对互相引用
  const ids = Array.from({ length: 6 }, () => newId('asset'));

  /** 建一条成果影像（v3：带批次、架次、确认状态与航线参数版本） */
  const pushAsset = (
    id: string,
    batchId: string,
    importedAt: number,
    sortie: number,
    index: number,
    extra: Partial<ImageAsset>,
  ) => {
    const lng = 116.3916 + index * 0.0012;
    const lat = 39.9071 - (index % 2) * 0.0009;
    const quality: ImageAsset['quality'] = extra.quality ?? '合格';
    const imageNo = extra.imageNo ?? `IMG_${String(1001 + index)}`;
    const asset: ImageAsset = {
      id,
      missionId: missionA,
      imageNo,
      lng: extra.lng ?? lng,
      lat: extra.lat ?? lat,
      altitude: 120,
      gsd: 3.22,
      overlap: 76 - index,
      tiltAngle: 2 + index,
      shotAt: extra.shotAt ?? now - 30 * day + index * 12000,
      quality,
      folder: `/DM-2024-018/S${sortie}/100MEDIA`,
      batchId,
      sortie,
      importedAt,
      status: extra.status ?? '待确认',
      qualityTouched: extra.qualityTouched ?? false,
      lineVersion: extra.lineVersion ?? lineVersionA,
      conflictWith: extra.conflictWith,
    };
    assets.push(asset);
    thumbs.push({ id, missionId: missionA, dataUrl: makeThumbDataUrl(imageNo, quality, asset.lng, asset.lat) });
  };

  // 第一架次（01 批次）：已确认 / 已归档 / 航线改动后待重认 / 待确认冲突片
  pushAsset(ids[0], batch1, importedAt1, 1, 0, { status: '已确认', qualityTouched: true, quality: '合格' });
  pushAsset(ids[1], batch1, importedAt1, 1, 1, { status: '已归档', qualityTouched: true, quality: '合格' });
  pushAsset(ids[2], batch1, importedAt1, 1, 2, {
    status: '待确认',
    quality: '模糊',
    qualityTouched: false,
    lineVersion: lineVersionA - 5 * day, // 早于当前航线参数 → 需重新确认
  });
  pushAsset(ids[3], batch1, importedAt1, 1, 3, {
    status: '待确认',
    quality: '合格',
    qualityTouched: false,
    conflictWith: ids[4],
  });
  // 第二架次（02 批次）：同片号 IMG_1004 位置/时间不一致 → 冲突；另带一条已确认过曝片
  pushAsset(ids[4], batch2, importedAt2, 2, 3, {
    status: '待确认',
    quality: '合格',
    qualityTouched: false,
    lng: 116.3916 + 3 * 0.0012 + 0.0006,
    lat: 39.9071 - 0.0014,
    shotAt: now - 30 * day + 3 * 12000 + 22 * 60000,
    conflictWith: ids[3],
  });
  pushAsset(ids[5], batch2, importedAt2, 2, 4, { status: '已确认', quality: '过曝', qualityTouched: true });

  const presets: CameraPreset[] = [
    {
      id: newId('preset'),
      name: 'Mavic 3E 广角',
      cameraModel: 'DJI 4/3 CMOS 20MP',
      sensorWidth: 17.3,
      sensorHeight: 13,
      focalLength: 12.29,
      pixelSize: 3.3,
    },
    {
      id: newId('preset'),
      name: 'Zenmuse P1 35mm',
      cameraModel: 'Zenmuse P1',
      sensorWidth: 35.9,
      sensorHeight: 24,
      focalLength: 35,
      pixelSize: 4.4,
    },
    {
      id: newId('preset'),
      name: 'Phantom 4 RTK',
      cameraModel: 'FC6310R',
      sensorWidth: 13.2,
      sensorHeight: 8.8,
      focalLength: 8.8,
      pixelSize: 2.4,
    },
  ];

  // 六张表超过 Dexie 位置参数上限，改用数组形式声明事务范围
  await db.transaction('rw', [db.missions, db.waypoints, db.lines, db.assets, db.thumbs, db.presets], async () => {
    await db.missions.bulkPut(missions);
    await db.waypoints.bulkPut(waypoints);
    await db.lines.bulkPut(lines);
    await db.assets.bulkPut(assets);
    await db.thumbs.bulkPut(thumbs);
    await db.presets.bulkPut(presets);
  });
}
