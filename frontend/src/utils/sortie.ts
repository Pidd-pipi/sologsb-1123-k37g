import {
  IMAGE_QUALITIES,
  SAME_PHOTO_DISTANCE_M,
  SAME_PHOTO_TIME_MS,
  type ImageQuality,
  type SortieRowError,
  type SortieRowInput,
} from '../types/imageasset';
import type { Waypoint } from '../types/waypoint';
import { distanceMeters } from './geoCalc';

/** 解析拍摄时间：支持 2026-09-12 10:20:31、2026/09/12T10:20:31、毫秒时间戳 */
export function parseShotAt(raw: string): number {
  const text = raw.trim();
  if (/^\d{10,13}$/.test(text)) {
    const n = Number(text);
    return text.length <= 10 ? n * 1000 : n;
  }
  const normalized = text.replace(/\//g, '-').replace('T', ' ').replace(/\.\d+$/, '');
  const ts = Date.parse(normalized.replace(' ', 'T'));
  return Number.isNaN(ts) ? NaN : ts;
}

/** 解析质量：合格/模糊/过曝，空值按合格 */
export function parseQuality(raw: string): ImageQuality | undefined {
  const text = raw.trim();
  if (!text) return '合格';
  return (IMAGE_QUALITIES as string[]).includes(text) ? (text as ImageQuality) : undefined;
}

const HEADER_ALIASES: Record<string, string> = {
  片号: 'imageNo',
  影像片号: 'imageNo',
  imageNo: 'imageNo',
  no: 'imageNo',
  经度: 'lng',
  lng: 'lng',
  纬度: 'lat',
  lat: 'lat',
  时间: 'shotAt',
  拍摄时间: 'shotAt',
  shotAt: 'shotAt',
  gsd: 'gsd',
  重叠: 'overlap',
  重叠度: 'overlap',
  overlap: 'overlap',
  质量: 'quality',
  quality: 'quality',
  航高: 'altitude',
  altitude: 'altitude',
  倾角: 'tiltAngle',
  tiltAngle: 'tiltAngle',
  架次: 'sortie',
  sortie: 'sortie',
  归档目录: 'folder',
  folder: 'folder',
};

type CellMap = Record<string, string | undefined>;

function splitLine(line: string): string[] {
  // 支持 CSV 引号转义与制表符分隔
  if (line.includes('\t')) return line.split('\t').map((c) => c.trim());
  const cells: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function toMap(cells: string[], header?: string[]): CellMap {
  if (header) {
    const map: CellMap = {};
    header.forEach((h, i) => {
      const key = HEADER_ALIASES[h] ?? HEADER_ALIASES[h.toLowerCase()];
      if (key) map[key] = cells[i];
    });
    return map;
  }
  // 无表头固定列序：片号,经度,纬度,时间,GSD,重叠,质量[,航高,倾角,架次,归档目录]
  return {
    imageNo: cells[0],
    lng: cells[1],
    lat: cells[2],
    shotAt: cells[3],
    gsd: cells[4],
    overlap: cells[5],
    quality: cells[6],
    altitude: cells[7],
    tiltAngle: cells[8],
    sortie: cells[9],
    folder: cells[10],
  };
}

/**
 * 解析外业离线编目清单文本。
 * 首行识别为表头（出现「片号」等别名时按列名取值），否则按固定列序解析。
 */
export function parseSortieText(text: string, defaultSortie?: number): { rows: SortieRowInput[]; errors: SortieRowError[] } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const rows: SortieRowInput[] = [];
  const errors: SortieRowError[] = [];
  if (lines.length === 0) return { rows, errors };

  let header: string[] | undefined;
  const firstCells = splitLine(lines[0]);
  if (firstCells.some((c) => HEADER_ALIASES[c] || HEADER_ALIASES[c.toLowerCase()])) {
    header = firstCells.map((c) => c.toLowerCase());
  }

  lines
    .slice(header ? 1 : 0)
    .forEach((line, idx) => {
      const lineNo = idx + (header ? 2 : 1);
      const m = toMap(splitLine(line), header);
      const imageNo = (m.imageNo ?? '').trim();
      const lng = Number(m.lng);
      const lat = Number(m.lat);
      const shotAt = parseShotAt(m.shotAt ?? '');
      const gsd = Number(m.gsd);
      const overlap = Number(m.overlap);
      const quality = parseQuality(m.quality ?? '');
      const fail = (reason: string) => errors.push({ line: lineNo, reason, raw: line });

      if (!imageNo) return fail('缺少片号');
      if (!Number.isFinite(lng) || Math.abs(lng) > 180) return fail('经度无效');
      if (!Number.isFinite(lat) || Math.abs(lat) > 90) return fail('纬度无效');
      if (!Number.isFinite(shotAt)) return fail('拍摄时间无法识别（支持 2026-09-12 10:20:31 或毫秒时间戳）');
      if (!Number.isFinite(gsd) || gsd <= 0) return fail('GSD 无效');
      if (!Number.isFinite(overlap) || overlap < 0 || overlap > 100) return fail('重叠度无效（0-100）');
      if (!quality) return fail('质量无法识别（合格/模糊/过曝）');

      const altitude = m.altitude === undefined || m.altitude === '' ? 0 : Number(m.altitude);
      const tiltAngle = m.tiltAngle === undefined || m.tiltAngle === '' ? 0 : Number(m.tiltAngle);
      const sortieRaw = m.sortie ?? '';
      const sortie = sortieRaw ? Number(sortieRaw) : defaultSortie;
      rows.push({
        imageNo,
        lng,
        lat,
        shotAt,
        gsd,
        overlap,
        quality,
        altitude: Number.isFinite(altitude) ? altitude : 0,
        tiltAngle: Number.isFinite(tiltAngle) ? tiltAngle : 0,
        folder: m.folder?.trim() || undefined,
        sortie: Number.isFinite(sortie) ? sortie : defaultSortie,
      });
    });

  return { rows, errors };
}

/** 按航点位置与当前航线 GSD 生成一份示范清单文本（供外业离线编目格式演示与快速填充） */
export function buildSortieTextFromWaypoints(
  waypoints: Waypoint[],
  gsd: number,
  missionNo: string,
  sortie: number,
): string {
  const start = Date.now();
  const head = '片号,经度,纬度,时间,GSD,重叠度,质量,航高,倾角,架次,归档目录';
  const body = waypoints.map((w, i) => {
    const shotAt = new Date(start + i * 12000).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
    return [
      `IMG_S${sortie}_${String(1001 + i)}`,
      w.lng,
      w.lat,
      shotAt,
      gsd.toFixed(2),
      75,
      '合格',
      w.altitude,
      Math.abs(w.gimbalPitch + 90),
      sortie,
      `/${missionNo}/S${sortie}/100MEDIA`,
    ].join(',');
  });
  return [head, ...body].join('\n');
}

/** 两条同片号记录是否为同一影像（位置与时间均接近） */
export function isSamePhoto(
  a: { lng: number; lat: number; shotAt: number },
  b: { lng: number; lat: number; shotAt: number },
): boolean {
  return (
    distanceMeters([a.lng, a.lat], [b.lng, b.lat]) <= SAME_PHOTO_DISTANCE_M &&
    Math.abs(a.shotAt - b.shotAt) <= SAME_PHOTO_TIME_MS
  );
}
