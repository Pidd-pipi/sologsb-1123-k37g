import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Tag,
  Typography,
  Upload,
} from 'antd';
import {
  CheckCircleOutlined,
  DownloadOutlined,
  ExclamationCircleOutlined,
  PlusOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import type { UploadProps } from 'antd';
import { useMissionStore } from '../stores/missionStore';
import { useWaypointStore } from '../stores/waypointStore';
import { useAssetStore } from '../stores/assetStore';
import AssetGrid from '../components/common/AssetGrid';
import AmapRouteView from '../components/common/AmapRouteView';
import {
  ASSET_STATUSES,
  IMAGE_QUALITIES,
  parseImportText,
  STATUS_COLOR,
  type AssetStatus,
  type ImageAsset,
  type ImageAssetDraft,
  type ImageQuality,
} from '../types/imageasset';
import { calcGsd, distanceMeters } from '../utils/geoCalc';

const IMPORT_TEMPLATE = `片号,时间,经度,纬度,航高,GSD,重叠度,质量
IMG_1001,2024-09-12 09:30:00,116.39160,39.90710,120,3.22,75,合格
IMG_1002,2024-09-12 09:31:00,116.39280,39.90620,120,3.22,75,模糊`;

/** /missions/:id/assets 成果影像编目：架次清单导入、批次/冲突/待确认管理、多选标记、定位到图、只导出确认结果 */
export default function AssetCatalog() {
  const { id = '' } = useParams();
  const missions = useMissionStore((s) => s.items);
  const waypoints = useWaypointStore((s) => s.items);
  const assets = useAssetStore((s) => s.items);
  const thumbs = useAssetStore((s) => s.thumbs);
  const addMany = useAssetStore((s) => s.addMany);
  const importBatch = useAssetStore((s) => s.importBatch);
  const markMany = useAssetStore((s) => s.markMany);
  const confirmMany = useAssetStore((s) => s.confirmMany);
  const archiveMany = useAssetStore((s) => s.archiveMany);
  const removeMany = useAssetStore((s) => s.removeMany);

  const mission = missions.find((m) => m.id === id);
  const missionAssets = useMemo(
    () => assets.filter((a) => a.missionId === id).sort((a, b) => a.imageNo.localeCompare(b.imageNo, 'zh-Hans-CN', { numeric: true })),
    [assets, id],
  );
  const missionWaypoints = useMemo(
    () => waypoints.filter((w) => w.missionId === id).sort((a, b) => a.seq - b.seq),
    [waypoints, id],
  );
  const batches = useAssetStore((s) => s.batchList(id));

  const [selected, setSelected] = useState<string[]>([]);
  const [keyword, setKeyword] = useState('');
  const [qualityFilter, setQualityFilter] = useState<ImageQuality | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<AssetStatus | 'all'>('all');
  const [batchFilter, setBatchFilter] = useState<string>('all');
  const [locateSeq, setLocateSeq] = useState<number | undefined>(undefined);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  const [importOpen, setImportOpen] = useState(false);
  const [importBatchNo, setImportBatchNo] = useState('');
  const [importText, setImportText] = useState('');
  const [importErrors, setImportErrors] = useState<string[]>([]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const filtered = missionAssets.filter((a) => {
    if (qualityFilter !== 'all' && a.quality !== qualityFilter) return false;
    if (statusFilter !== 'all' && a.status !== statusFilter) return false;
    if (batchFilter !== 'all' && a.batchId !== batchFilter) return false;
    if (keyword && !a.imageNo.toLowerCase().includes(keyword.trim().toLowerCase())) return false;
    return true;
  });

  const stats = IMAGE_QUALITIES.map((quality) => ({
    quality,
    count: missionAssets.filter((a) => a.quality === quality).length,
  }));

  const statusCounts = useMemo(
    () => ({
      待确认: missionAssets.filter((a) => a.status === '待确认').length,
      已确认: missionAssets.filter((a) => a.status === '已确认').length,
      冲突: missionAssets.filter((a) => a.status === '冲突').length,
      已归档: missionAssets.filter((a) => a.status === '已归档').length,
    }),
    [missionAssets],
  );

  /** 批量编目：按航点位置与当前航线 GSD 生成影像条目 */
  const catalogFromWaypoints = async () => {
    if (!mission) return;
    if (missionWaypoints.length === 0) {
      setError('该任务暂无航点，请先到「航点明细」录入或点击网格新增');
      return;
    }
    const gsd = calcGsd(mission.pixelSize, missionWaypoints[0].altitude, mission.focalLength);
    const startNo = missionAssets.length + 1;
    const drafts: ImageAssetDraft[] = missionWaypoints.map((w, index) => ({
      missionId: mission.id,
      imageNo: `IMG_${String(2000 + startNo + index)}`,
      lng: w.lng,
      lat: w.lat,
      altitude: w.altitude,
      gsd: calcGsd(mission.pixelSize, w.altitude, mission.focalLength) || gsd,
      overlap: 75,
      tiltAngle: Math.abs(w.gimbalPitch + 90),
      shotAt: Date.now() + index * 1000,
      quality: '合格' as ImageQuality,
      folder: `/${mission.missionNo}/100MEDIA`,
      batchId: `batch_${mission.id}_waypoints`,
      batchNo: '航点编目',
      status: '待确认',
    }));
    await addMany(drafts);
    setError('');
    setToast(`已按 ${drafts.length} 个航点批量编目影像条目（GSD ${gsd} cm/px）`);
  };

  const openImport = () => {
    setImportBatchNo(`架次 ${batches.length + 1}`);
    setImportText('');
    setImportErrors([]);
    setImportOpen(true);
  };

  const submitImport = async () => {
    if (!mission) return;
    const { rows, errors: parseErrors } = parseImportText(importText, missionWaypoints[0]?.altitude ?? 120);
    if (rows.length === 0) {
      setImportErrors(parseErrors.length > 0 ? parseErrors : ['未解析到有效条目，请检查清单格式']);
      return;
    }
    const batchNo = importBatchNo.trim() || `架次 ${batches.length + 1}`;
    const result = await importBatch(mission.id, mission.missionNo, batchNo, rows);
    setImportErrors(parseErrors);
    setToast(
      `架次「${batchNo}」导入 ${rows.length} 条：新增 ${result.added} 张，跳过重复 ${result.skipped} 张，冲突 ${result.conflicts} 张`,
    );
    if (parseErrors.length === 0) setImportOpen(false);
  };

  const uploadProps: UploadProps = {
    accept: '.csv,.txt,text/csv,text/plain',
    showUploadList: false,
    beforeUpload: (file) => {
      const reader = new FileReader();
      reader.onload = () => {
        setImportText(String(reader.result ?? ''));
        setImportErrors([]);
      };
      reader.readAsText(file);
      return false;
    },
  };

  const downloadTemplate = () => {
    const blob = new Blob([IMPORT_TEMPLATE], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '架次清单模板.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const locate = (asset: ImageAsset) => {
    if (missionWaypoints.length === 0) return;
    let best = missionWaypoints[0];
    let bestDist = Number.POSITIVE_INFINITY;
    missionWaypoints.forEach((w) => {
      const d = distanceMeters([asset.lng, asset.lat], [w.lng, w.lat]);
      if (d < bestDist) {
        bestDist = d;
        best = w;
      }
    });
    setLocateSeq(best.seq);
    setToast(`已定位到航点 #${best.seq}（距离 ${bestDist.toFixed(1)} m）`);
  };

  /** 导出只带确认结果（已确认 + 已归档），待确认与冲突不导出 */
  const exportList = () => {
    const exportable = missionAssets.filter((a) => a.status === '已确认' || a.status === '已归档');
    const header = '片号,批次,状态,经度,纬度,航高m,GSDcm/px,重叠%,倾角°,质量,归档目录';
    const lines = exportable.map((a) =>
      [a.imageNo, a.batchNo, a.status, a.lng, a.lat, a.altitude, a.gsd, a.overlap, a.tiltAngle, a.quality, a.folder].join(','),
    );
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `成果影像清单_${mission?.missionNo ?? 'mission'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setToast(`已导出 ${lines.length} 条确认结果（待确认 ${statusCounts.待确认} 张、冲突 ${statusCounts.冲突} 张未导出）`);
  };

  if (!mission) {
    return (
      <Space direction="vertical">
        <Alert type="warning" showIcon message="未找到该任务" />
        <Link to="/missions">返回任务台账</Link>
      </Space>
    );
  }

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          成果影像编目 · {mission.missionNo}
        </Typography.Title>
        <Tag color="cyan">{mission.purpose}</Tag>
        <Tag>条目 {missionAssets.length} 张</Tag>
        <Tag color={STATUS_COLOR.待确认}>待确认 {statusCounts.待确认}</Tag>
        <Tag color={STATUS_COLOR.已确认}>已确认 {statusCounts.已确认}</Tag>
        <Tag color={STATUS_COLOR.冲突}>冲突 {statusCounts.冲突}</Tag>
        <Tag color={STATUS_COLOR.已归档}>已归档 {statusCounts.已归档}</Tag>
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to={`/missions/${mission.id}/route`}>航线规划</Link>
        </Button>
        <Button type="link">
          <Link to={`/missions/${mission.id}/waypoints`}>航点明细</Link>
        </Button>
        <Button type="link">
          <Link to="/missions">返回台账</Link>
        </Button>
      </Space>

      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}

      {statusCounts.冲突 > 0 ? (
        <Alert
          type="error"
          showIcon
          icon={<ExclamationCircleOutlined />}
          message={`检测到 ${statusCounts.冲突} 张冲突条目：不同架次同片号但位置或时间不一致，请逐张核对后确认或删除`}
        />
      ) : null}
      {statusCounts.待确认 > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`有 ${statusCounts.待确认} 张成果待确认（含新导入与航线参数改动后需重新确认的条目），确认后才会导出`}
        />
      ) : null}

      <Row gutter={12}>
        {stats.map((s) => (
          <Col span={6} key={s.quality}>
            <Card size="small">
              <Statistic title={`${s.quality}影像`} value={s.count} suffix="张" />
            </Card>
          </Col>
        ))}
        <Col span={6}>
          <Card size="small">
            <Statistic title="航点数量" value={missionWaypoints.length} suffix="个" />
          </Card>
        </Col>
      </Row>

      <Card size="small">
        <Space wrap size={10}>
          <Input
            allowClear
            style={{ width: 180 }}
            placeholder="按片号筛选"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Select
            style={{ width: 130 }}
            value={qualityFilter}
            onChange={(v) => setQualityFilter(v as ImageQuality | 'all')}
            options={[{ value: 'all', label: '全部质量' }, ...IMAGE_QUALITIES.map((q) => ({ value: q, label: q }))]}
          />
          <Select
            style={{ width: 130 }}
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as AssetStatus | 'all')}
            options={[{ value: 'all', label: '全部状态' }, ...ASSET_STATUSES.map((s) => ({ value: s, label: s }))]}
          />
          <Select
            style={{ width: 180 }}
            value={batchFilter}
            onChange={(v) => setBatchFilter(v)}
            options={[
              { value: 'all', label: '全部批次' },
              ...batches.map((b) => ({ value: b.batchId, label: `${b.batchNo}（${b.count}）` })),
            ]}
          />
          <Button type="primary" icon={<UploadOutlined />} onClick={openImport}>
            导入架次清单
          </Button>
          <Button icon={<PlusOutlined />} onClick={catalogFromWaypoints}>
            按航点批量编目
          </Button>
          <Button
            icon={<CheckCircleOutlined />}
            disabled={selected.length === 0}
            onClick={async () => {
              await confirmMany(selected);
              setToast(`已确认 ${selected.length} 张成果，质量保持不变`);
            }}
          >
            确认选中
          </Button>
          <Button
            disabled={selected.length === 0}
            onClick={async () => {
              await markMany(selected, '合格');
              setToast(`已把 ${selected.length} 张标记为「合格」并确认`);
            }}
          >
            标记合格
          </Button>
          <Button
            disabled={selected.length === 0}
            onClick={async () => {
              await markMany(selected, '模糊');
              setToast(`已把 ${selected.length} 张标记为「模糊」并确认`);
            }}
          >
            标记模糊
          </Button>
          <Button
            disabled={selected.length === 0}
            onClick={async () => {
              await markMany(selected, '过曝');
              setToast(`已把 ${selected.length} 张标记为「过曝」并确认`);
            }}
          >
            标记过曝
          </Button>
          <Button
            disabled={selected.length === 0}
            onClick={async () => {
              await archiveMany(selected);
              setToast(`已归档 ${selected.length} 张，归档后保留原值且不再随航线改动重新确认`);
            }}
          >
            归档选中
          </Button>
          <Button
            danger
            disabled={selected.length === 0}
            onClick={async () => {
              await removeMany(selected);
              setToast(`已删除 ${selected.length} 条影像条目`);
              setSelected([]);
            }}
          >
            删除选中
          </Button>
          <Button icon={<DownloadOutlined />} onClick={exportList} disabled={missionAssets.length === 0}>
            导出成果清单
          </Button>
        </Space>
      </Card>

      <Row gutter={14}>
        <Col span={16}>
          <Card size="small" title={`影像格子（筛选后 ${filtered.length} 张）`}>
            <AssetGrid
              assets={filtered}
              thumbs={thumbs}
              selectedIds={selected}
              onToggle={(assetId) =>
                setSelected((prev) => (prev.includes(assetId) ? prev.filter((x) => x !== assetId) : [...prev, assetId]))
              }
              onToggleAll={(ids) => setSelected(ids)}
              onLocate={locate}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small" title="定位到图">
            <AmapRouteView
              mission={mission}
              waypoints={missionWaypoints}
              altitude={missionWaypoints[0]?.altitude ?? 120}
              height={340}
              highlightSeq={locateSeq}
            />
          </Card>
        </Col>
      </Row>

      <Modal
        title="导入架次清单"
        open={importOpen}
        onOk={submitImport}
        onCancel={() => setImportOpen(false)}
        okText="导入并合并"
        cancelText="取消"
        width={680}
      >
        <Space direction="vertical" size={10} style={{ width: '100%', marginTop: 8 }}>
          <Alert
            type="info"
            showIcon
            message="外业离线编目后，把本架次清单粘贴进来（或上传 CSV）。同批次重复导入不新增；不同批次同片号但位置或时间不同会列为冲突；已人工确认的质量不会被覆盖。"
          />
          <Space wrap size={10}>
            <span>
              架次批次号{' '}
              <Input style={{ width: 220 }} value={importBatchNo} onChange={(e) => setImportBatchNo(e.target.value)} placeholder="如 2024-09-12 上午架次" />
            </span>
            <Upload {...uploadProps}>
              <Button icon={<UploadOutlined />}>上传 CSV 文件</Button>
            </Upload>
            <Button type="link" onClick={downloadTemplate}>
              下载模板
            </Button>
          </Space>
          <Typography.Text type="secondary">
            列：片号、时间、经度、纬度、航高、GSD、重叠度、质量（支持中文表头，逗号或 Tab 分隔）
          </Typography.Text>
          <Input.TextArea
            rows={10}
            value={importText}
            onChange={(e) => {
              setImportText(e.target.value);
              setImportErrors([]);
            }}
            placeholder={IMPORT_TEMPLATE}
          />
          {importErrors.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              message={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {importErrors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              }
            />
          ) : null}
        </Space>
      </Modal>
    </Space>
  );
}
