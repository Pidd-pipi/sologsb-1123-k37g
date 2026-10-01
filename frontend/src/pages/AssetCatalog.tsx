import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Input,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import { CheckOutlined, DownloadOutlined, FolderOpenOutlined, ImportOutlined } from '@ant-design/icons';
import { useMissionStore } from '../stores/missionStore';
import { useWaypointStore } from '../stores/waypointStore';
import { useAssetStore } from '../stores/assetStore';
import AssetGrid from '../components/common/AssetGrid';
import SortieImportModal from '../components/common/SortieImportModal';
import AmapRouteView from '../components/common/AmapRouteView';
import { IMAGE_QUALITIES, type AssetStatus, type ImageAsset, type ImageQuality, type SortieRowInput } from '../types/imageasset';
import { calcGsd, distanceMeters } from '../utils/geoCalc';
import { loadFlightLine } from '../utils/db';
import type { FlightLine } from '../types/flightline';

/** /missions/:id/assets 成果影像编目：架次清单导入对账、冲突裁决、确认归档、仅确认结果导出 */
export default function AssetCatalog() {
  const { id = '' } = useParams();
  const missions = useMissionStore((s) => s.items);
  const waypoints = useWaypointStore((s) => s.items);
  const assets = useAssetStore((s) => s.items);
  const thumbs = useAssetStore((s) => s.thumbs);
  const importSorties = useAssetStore((s) => s.importSorties);
  const markMany = useAssetStore((s) => s.markMany);
  const confirmMany = useAssetStore((s) => s.confirmMany);
  const archiveMany = useAssetStore((s) => s.archiveMany);
  const resolveConflict = useAssetStore((s) => s.resolveConflict);
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
  const [line, setLine] = useState<FlightLine | undefined>(undefined);
  useEffect(() => {
    if (!id) return;
    void loadFlightLine(id).then(setLine);
  }, [id, assets.length]);

  const currentLineVersion = line?.updatedAt ?? 0;

  const [selected, setSelected] = useState<string[]>([]);
  const [keyword, setKeyword] = useState('');
  const [qualityFilter, setQualityFilter] = useState<ImageQuality | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<AssetStatus | 'conflict' | 'stale' | 'all'>('all');
  const [batchFilter, setBatchFilter] = useState<string>('all');
  const [importOpen, setImportOpen] = useState(false);
  const [locateSeq, setLocateSeq] = useState<number | undefined>(undefined);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const conflictIds = useMemo(() => new Set(missionAssets.filter((a) => a.conflictWith).map((a) => a.id)), [missionAssets]);
  const peerOf = useMemo(() => {
    const map: Record<string, ImageAsset | undefined> = {};
    const byId = new Map(missionAssets.map((a) => [a.id, a]));
    missionAssets.forEach((a) => {
      if (a.conflictWith) map[a.id] = byId.get(a.conflictWith);
    });
    return map;
  }, [missionAssets]);

  /** 按批次汇总（页头标出批次、冲突和待确认数） */
  const batchSummary = useMemo(() => {
    const groups = new Map<string, { batchId: string; total: number; pending: number; conflicts: number; importedAt: number }>();
    missionAssets.forEach((a) => {
      const g = groups.get(a.batchId) ?? { batchId: a.batchId, total: 0, pending: 0, conflicts: 0, importedAt: a.importedAt };
      g.total += 1;
      if (a.status === '待确认') g.pending += 1;
      if (a.conflictWith) g.conflicts += 1;
      g.importedAt = Math.min(g.importedAt, a.importedAt);
      groups.set(a.batchId, g);
    });
    return Array.from(groups.values()).sort((a, b) => a.importedAt - b.importedAt);
  }, [missionAssets]);

  const pendingCount = missionAssets.filter((a) => a.status === '待确认').length;
  const conflictCount = conflictIds.size;
  const exportable = missionAssets.filter((a) => !a.conflictWith && (a.status === '已确认' || a.status === '已归档'));
  const gsd = calcGsd(mission?.pixelSize ?? 0, missionWaypoints[0]?.altitude ?? 120, mission?.focalLength ?? 1);

  const filtered = missionAssets.filter((a) => {
    if (qualityFilter !== 'all' && a.quality !== qualityFilter) return false;
    if (batchFilter !== 'all' && a.batchId !== batchFilter) return false;
    if (keyword && !a.imageNo.toLowerCase().includes(keyword.trim().toLowerCase())) return false;
    if (statusFilter === 'conflict' && !a.conflictWith) return false;
    if (statusFilter === 'stale') {
      if (a.conflictWith || a.status === '已归档' || a.lineVersion === currentLineVersion) return false;
    } else if (statusFilter !== 'all' && a.status !== statusFilter) return false;
    return true;
  });

  const defaultBatchId = useMemo(() => {
    const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `B-${d}-${String(batchSummary.length + 1).padStart(2, '0')}`;
  }, [batchSummary.length]);

  const handleImport = async (batchId: string, rows: SortieRowInput[]) => {
    return importSorties(id, batchId, rows, currentLineVersion, `/${mission?.missionNo ?? 'mission'}/100MEDIA`);
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

  /** 导出只带确认结果：已确认 + 已归档，且排除未裁决冲突 */
  const exportList = () => {
    const header = '批次,架次,片号,经度,纬度,航高m,GSDcm/px,重叠%,倾角°,拍摄时间,质量,确认状态,归档目录';
    const lines = exportable.map((a) =>
      [
        a.batchId,
        a.sortie ?? '',
        a.imageNo,
        a.lng,
        a.lat,
        a.altitude,
        a.gsd,
        a.overlap,
        a.tiltAngle,
        new Date(a.shotAt).toLocaleString('zh-CN', { hour12: false }),
        a.quality,
        a.status,
        a.folder,
      ].join(','),
    );
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `成果影像确认清单_${mission?.missionNo ?? 'mission'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setToast(`已导出 ${lines.length} 条确认结果（待确认与冲突未导出）`);
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
        <Tag color="purple">批次 {batchSummary.length} 个</Tag>
        <Tag color={conflictCount ? 'red' : 'default'}>冲突 {conflictCount}</Tag>
        <Tag color={pendingCount ? 'orange' : 'default'}>待确认 {pendingCount}</Tag>
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
      {conflictCount > 0 ? (
        <Alert
          type="error"
          showIcon
          message={`有 ${conflictCount} 条片号在不同批次间位置或时间不一致，已列为冲突；双方原值均保留，请在红色卡片上人工裁决，冲突记录不进入导出。`}
        />
      ) : null}
      {pendingCount > 0 && conflictCount === 0 ? (
        <Alert type="warning" showIcon message={`有 ${pendingCount} 条成果待确认；航线参数改动后未归档成果会回到待确认，已归档记录保留原值。`} />
      ) : null}

      <Row gutter={12}>
        <Col span={6}>
          <Card size="small">
            <Statistic title="导入批次" value={batchSummary.length} suffix="个" />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="待确认" value={pendingCount} suffix="张" valueStyle={{ color: pendingCount ? '#fa8c16' : undefined }} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="冲突" value={conflictCount} suffix="条" valueStyle={{ color: conflictCount ? '#ff4d4f' : undefined }} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="可导出确认结果" value={exportable.length} suffix="张" />
          </Card>
        </Col>
      </Row>

      <Card size="small" title="架次批次对账">
        <Table
          size="small"
          rowKey="batchId"
          pagination={false}
          dataSource={batchSummary}
          columns={[
            { title: '批次号', dataIndex: 'batchId' },
            {
              title: '导入时间',
              dataIndex: 'importedAt',
              render: (v: number) => new Date(v).toLocaleString('zh-CN', { hour12: false }),
            },
            { title: '条目', dataIndex: 'total', width: 80 },
            {
              title: '待确认',
              dataIndex: 'pending',
              width: 90,
              render: (v: number) => (v > 0 ? <Tag color="orange">{v}</Tag> : <Tag>0</Tag>),
            },
            {
              title: '冲突',
              dataIndex: 'conflicts',
              width: 90,
              render: (v: number) => (v > 0 ? <Tag color="red">{v}</Tag> : <Tag>0</Tag>),
            },
            {
              title: '操作',
              width: 110,
              render: (_, r) => (
                <Button size="small" type="link" onClick={() => setBatchFilter(r.batchId)}>
                  只看该批次
                </Button>
              ),
            },
          ]}
          locale={{ emptyText: '尚未导入任何架次清单' }}
        />
      </Card>

      <Card size="small">
        <Space wrap size={10}>
          <Button type="primary" icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>
            导入架次清单
          </Button>
          <Input
            allowClear
            style={{ width: 180 }}
            placeholder="按片号筛选"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Select
            style={{ width: 150 }}
            value={batchFilter}
            onChange={setBatchFilter}
            options={[{ value: 'all', label: '全部批次' }, ...batchSummary.map((b) => ({ value: b.batchId, label: b.batchId }))]}
          />
          <Select
            style={{ width: 140 }}
            value={qualityFilter}
            onChange={(v) => setQualityFilter(v as ImageQuality | 'all')}
            options={[{ value: 'all', label: '全部质量' }, ...IMAGE_QUALITIES.map((q) => ({ value: q, label: q }))]}
          />
          <Select
            style={{ width: 160 }}
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as typeof statusFilter)}
            options={[
              { value: 'all', label: '全部状态' },
              { value: '待确认', label: '待确认' },
              { value: '已确认', label: '已确认' },
              { value: '已归档', label: '已归档' },
              { value: 'conflict', label: '冲突' },
              { value: 'stale', label: '航线改动待重认' },
            ]}
          />
          <Button
            icon={<CheckOutlined />}
            disabled={selected.length === 0}
            onClick={async () => {
              await confirmMany(selected);
              setToast('已将选中条目确认为对账结果（质量原值保留）');
            }}
          >
            确认选中
          </Button>
          <Button
            icon={<FolderOpenOutlined />}
            disabled={selected.length === 0}
            onClick={async () => {
              await archiveMany(selected);
              setToast('已归档选中条目（后续航线改动不再要求重认）');
            }}
          >
            归档选中
          </Button>
          <Select
            style={{ width: 130 }}
            placeholder="标记质量"
            value={null}
            onChange={async (v: ImageQuality | null) => {
              if (!v || selected.length === 0) return;
              await markMany(selected, v);
              setToast(`已把 ${selected.length} 张标记为「${v}」，人工质量后续导入不再覆盖`);
            }}
            options={IMAGE_QUALITIES.map((q) => ({ value: q, label: `标记${q}` }))}
          />
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
          <Button type="primary" ghost icon={<DownloadOutlined />} onClick={exportList} disabled={exportable.length === 0}>
            导出确认清单（{exportable.length}）
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
              currentLineVersion={currentLineVersion}
              peerOf={peerOf}
              onToggle={(assetId) =>
                setSelected((prev) => (prev.includes(assetId) ? prev.filter((x) => x !== assetId) : [...prev, assetId]))
              }
              onToggleAll={(ids) => setSelected(ids)}
              onLocate={locate}
              onResolveKeep={async (asset) => {
                if (!asset.conflictWith) return;
                await resolveConflict(asset.id, asset.conflictWith);
                setSelected((prev) => prev.filter((x) => x !== asset.conflictWith));
                setToast(`冲突已裁决：保留 ${asset.imageNo}（${asset.batchId}），对端已删除`);
              }}
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
          <Card size="small" title="质量分布" style={{ marginTop: 12 }}>
            <Space size={8} wrap>
              {IMAGE_QUALITIES.map((q) => (
                <Tag key={q} color={q === '合格' ? 'green' : q === '模糊' ? 'gold' : 'red'}>
                  {q} {missionAssets.filter((a) => a.quality === q).length}
                </Tag>
              ))}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                当前航线 GSD {gsd.toFixed(2)} cm/px
              </Typography.Text>
            </Space>
          </Card>
        </Col>
      </Row>

      <SortieImportModal
        open={importOpen}
        missionNo={mission.missionNo}
        waypoints={missionWaypoints}
        gsd={gsd}
        defaultBatchId={defaultBatchId}
        onClose={() => setImportOpen(false)}
        onImport={handleImport}
      />
    </Space>
  );
}
