/** 成果影像质量 */
export type ImageQuality = '合格' | '模糊' | '过曝';

export const IMAGE_QUALITIES: ImageQuality[] = ['合格', '模糊', '过曝'];

/** 成果确认状态：冲突不单独设状态，由 conflictWith 标记，原值与原状态保留 */
export type AssetStatus = '待确认' | '已确认' | '已归档';

export const ASSET_STATUSES: AssetStatus[] = ['待确认', '已确认', '已归档'];

/** 成果影像条目 */
export interface ImageAsset {
  id: string;
  missionId: string;
  /** 影像片号 */
  imageNo: string;
  lng: number;
  lat: number;
  /** 航高 m */
  altitude: number;
  /** 实际 GSD cm/px */
  gsd: number;
  /** 实际重叠 % */
  overlap: number;
  /** 倾角 ° */
  tiltAngle: number;
  shotAt: number;
  quality: ImageQuality;
  /** 归档目录 */
  folder: string;
  /** 外业离线编目批次号（同批次重复导入不新增） */
  batchId: string;
  /** 架次号 */
  sortie?: number;
  /** 入库时间 */
  importedAt: number;
  /** 对账状态 */
  status: AssetStatus;
  /** 质量是否经人工确认/标记（合并与重导不覆盖） */
  qualityTouched: boolean;
  /** 导入时对应的航线参数版本（FlightLine.updatedAt，0 表示无航线参数） */
  lineVersion: number;
  /** 冲突对端条目 id；非空表示该条正处于「不同批次同片号位置/时间不一致」冲突中 */
  conflictWith?: string;
}

export type ImageAssetDraft = Omit<
  ImageAsset,
  'id' | 'batchId' | 'importedAt' | 'status' | 'qualityTouched' | 'lineVersion' | 'conflictWith'
>;

/** 架次清单解析后的一行（外业离线编目结果） */
export interface SortieRowInput {
  imageNo: string;
  lng: number;
  lat: number;
  shotAt: number;
  gsd: number;
  overlap: number;
  quality: ImageQuality;
  altitude: number;
  tiltAngle: number;
  folder?: string;
  sortie?: number;
}

/** 清单解析错误行 */
export interface SortieRowError {
  line: number;
  reason: string;
  raw: string;
}

/** 架次清单导入对账结果 */
export interface SortieImportResult {
  added: number;
  duplicated: number;
  merged: number;
  conflicted: number;
  invalid: SortieRowError[];
}

/** 同片号判为同一影像的阈值：位置 2 m、时间 5 s（RTK/相机时钟轻微偏差） */
export const SAME_PHOTO_DISTANCE_M = 2;
export const SAME_PHOTO_TIME_MS = 5_000;

/** 缩略图（单独建表存放 dataUrl） */
export interface AssetThumb {
  /** 与影像条目 id 一一对应 */
  id: string;
  missionId: string;
  dataUrl: string;
}

/** 本地生成缩略图（不依赖网络） */
export function makeThumbDataUrl(imageNo: string, quality: ImageQuality, lng: number, lat: number): string {
  const tone = quality === '合格' ? '#2f6f4f' : quality === '模糊' ? '#8a6d1f' : '#8a3b2f';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160">
  <rect width="240" height="160" fill="${tone}"/>
  <path d="M0 120 L60 96 L120 126 L180 84 L240 110 L240 160 L0 160 Z" fill="#20303a" opacity="0.55"/>
  <circle cx="196" cy="34" r="16" fill="#f2d98a" opacity="0.85"/>
  <text x="10" y="26" font-size="15" fill="#ffffff" font-family="sans-serif">${imageNo}</text>
  <text x="10" y="48" font-size="12" fill="#e6f0ff" font-family="sans-serif">${quality} · ${lng.toFixed(5)}, ${lat.toFixed(5)}</text>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
