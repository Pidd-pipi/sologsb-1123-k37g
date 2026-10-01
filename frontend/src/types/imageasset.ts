/** 成果影像质量 */
export type ImageQuality = '合格' | '模糊' | '过曝';

export const IMAGE_QUALITIES: ImageQuality[] = ['合格', '模糊', '过曝'];

/** 成果条目状态：待确认 / 已确认 / 冲突 / 已归档 */
export type AssetStatus = '待确认' | '已确认' | '冲突' | '已归档';

export const ASSET_STATUSES: AssetStatus[] = ['待确认', '已确认', '冲突', '已归档'];

export const STATUS_COLOR: Record<AssetStatus, string> = {
  待确认: 'orange',
  已确认: 'green',
  冲突: 'red',
  已归档: 'purple',
};

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
  /** 来源架次批次 id（由 missionId + batchNo 派生，同批次重复导入不新增） */
  batchId: string;
  /** 架次批次号（外业自编号，如「2024-09-12 上午架次」） */
  batchNo: string;
  /** 条目状态 */
  status: AssetStatus;
}

export type ImageAssetDraft = Omit<ImageAsset, 'id'>;

/** 缩略图（单独建表存放 dataUrl） */
export interface AssetThumb {
  /** 与影像条目 id 一一对应 */
  id: string;
  missionId: string;
  dataUrl: string;
}

/** 架次清单导入行（片号、时间、位置、GSD、重叠度、质量） */
export interface AssetImportRow {
  imageNo: string;
  shotAt: number;
  lng: number;
  lat: number;
  altitude: number;
  gsd: number;
  overlap: number;
  quality: ImageQuality;
}

/** 批次汇总信息（由同批次条目派生） */
export interface BatchInfo {
  batchId: string;
  batchNo: string;
  count: number;
  pendingCount: number;
  confirmedCount: number;
  conflictCount: number;
  archivedCount: number;
}

/** 把批次号转成稳定的批次 id（同 mission 下相同批次号视为同一架次） */
export function batchIdFor(missionId: string, batchNo: string): string {
  const slug = batchNo
    .trim()
    .replace(/[^\w一-龥]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `batch_${missionId}_${slug || 'x'}`;
}

function parseQuality(raw: string): ImageQuality {
  if (raw.includes('模糊')) return '模糊';
  if (raw.includes('过曝')) return '过曝';
  return '合格';
}

function parseTime(raw: string): number {
  const s = raw.trim();
  if (!s) return Date.now();
  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    return n > 1e12 ? n : n > 1e9 ? n * 1000 : Date.now();
  }
  const ms = Date.parse(s.replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : Date.now();
}

function toNumber(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

const HEADER_ALIASES: Record<string, keyof AssetImportRow | 'altitude'> = {
  片号: 'imageNo',
  影像号: 'imageNo',
  照片号: 'imageNo',
  编号: 'imageNo',
  imageNo: 'imageNo',
  photo: 'imageNo',
  时间: 'shotAt',
  拍摄时间: 'shotAt',
  时刻: 'shotAt',
  shotAt: 'shotAt',
  time: 'shotAt',
  date: 'shotAt',
  经度: 'lng',
  lng: 'lng',
  lon: 'lng',
  longitude: 'lng',
  纬度: 'lat',
  lat: 'lat',
  latitude: 'lat',
  航高: 'altitude',
  相对航高: 'altitude',
  altitude: 'altitude',
  alt: 'altitude',
  高度: 'altitude',
  gsd: 'gsd',
  地面分辨率: 'gsd',
  重叠度: 'overlap',
  重叠: 'overlap',
  overlap: 'overlap',
  质量: 'quality',
  品质: 'quality',
  quality: 'quality',
};

export interface ParseImportResult {
  rows: AssetImportRow[];
  errors: string[];
}

/**
 * 解析架次清单文本（CSV / TSV，可带中文表头）。
 * 列顺序（无表头时）：片号,时间,经度,纬度,航高,GSD,重叠度,质量
 */
export function parseImportText(text: string, defaultAltitude = 120): ParseImportResult {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const errors: string[] = [];
  if (lines.length === 0) return { rows: [], errors: ['清单内容为空'] };

  const delimiter = lines.some((l) => l.includes('\t')) ? '\t' : ',';
  const matrix = lines.map((l) => l.split(delimiter).map((c) => c.trim()));

  let colIndex: Partial<Record<keyof AssetImportRow | 'altitude', number>> = {};
  let dataStart = 0;
  const first = matrix[0].map((c) => c.toLowerCase());
  const hasHeader = first.some((c) => HEADER_ALIASES[c] !== undefined);
  if (hasHeader) {
    first.forEach((c, i) => {
      const key = HEADER_ALIASES[c];
      if (key && colIndex[key] === undefined) colIndex[key] = i;
    });
    dataStart = 1;
  } else {
    // 无表头：按固定位置映射
    const positional: (keyof AssetImportRow | 'altitude')[] = [
      'imageNo',
      'shotAt',
      'lng',
      'lat',
      'altitude',
      'gsd',
      'overlap',
      'quality',
    ];
    positional.forEach((key, i) => {
      colIndex[key] = i;
    });
  }

  const get = (cells: string[], key: keyof AssetImportRow | 'altitude'): string => {
    const i = colIndex[key];
    return i === undefined ? '' : cells[i] ?? '';
  };

  const rows: AssetImportRow[] = [];
  for (let r = dataStart; r < matrix.length; r += 1) {
    const cells = matrix[r];
    const imageNo = get(cells, 'imageNo');
    if (!imageNo) {
      errors.push(`第 ${r + 1} 行缺少片号，已跳过`);
      continue;
    }
    const lng = toNumber(get(cells, 'lng'));
    const lat = toNumber(get(cells, 'lat'));
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
      errors.push(`第 ${r + 1} 行（${imageNo}）经纬度无效，已跳过`);
      continue;
    }
    const altitude = toNumber(get(cells, 'altitude')) || defaultAltitude;
    rows.push({
      imageNo,
      shotAt: parseTime(get(cells, 'shotAt')),
      lng,
      lat,
      altitude,
      gsd: toNumber(get(cells, 'gsd')),
      overlap: toNumber(get(cells, 'overlap')),
      quality: parseQuality(get(cells, 'quality')),
    });
  }
  return { rows, errors };
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
