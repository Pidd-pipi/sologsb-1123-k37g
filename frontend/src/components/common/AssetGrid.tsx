import { Button, Card, Checkbox, Empty, Space, Tag, Tooltip, Typography } from 'antd';
import { AimOutlined, WarningOutlined } from '@ant-design/icons';
import type { ImageAsset, ImageQuality } from '../../types/imageasset';

export interface AssetGridProps {
  assets: ImageAsset[];
  thumbs: Record<string, string>;
  selectedIds: string[];
  /** 用于标注「航线参数已改动，待重新确认」的当前航线参数版本 */
  currentLineVersion?: number;
  /** 冲突对端查表：id → 对端条目 */
  peerOf?: Record<string, ImageAsset | undefined>;
  onToggle: (id: string) => void;
  onToggleAll?: (ids: string[]) => void;
  onLocate?: (asset: ImageAsset) => void;
  /** 解决冲突：保留该条、删除对端 */
  onResolveKeep?: (asset: ImageAsset) => void;
  emptyText?: string;
}

const QUALITY_COLOR: Record<ImageQuality, string> = {
  合格: 'green',
  模糊: 'gold',
  过曝: 'red',
};

const STATUS_COLOR: Record<ImageAsset['status'], string> = {
  待确认: 'orange',
  已确认: 'blue',
  已归档: 'purple',
};

function formatShotAt(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

/**
 * 成果影像格子：缩略图、片号、批次/架次、GSD、重叠、质量、确认状态与多选。
 * 被成果编目页（/missions/:id/assets）消费。
 */
export default function AssetGrid({
  assets,
  thumbs,
  selectedIds,
  currentLineVersion,
  peerOf,
  onToggle,
  onToggleAll,
  onLocate,
  onResolveKeep,
  emptyText = '暂无成果影像条目',
}: AssetGridProps) {
  if (assets.length === 0) {
    return <Empty description={emptyText} />;
  }

  const allSelected = selectedIds.length === assets.length;

  return (
    <div data-testid="asset-grid">
      <Space style={{ marginBottom: 10 }} size={10} wrap>
        <Checkbox
          checked={allSelected}
          indeterminate={selectedIds.length > 0 && !allSelected}
          onChange={() => onToggleAll?.(allSelected ? [] : assets.map((a) => a.id))}
        >
          全选（{assets.length} 张）
        </Checkbox>
        <Typography.Text type="secondary">已选 {selectedIds.length} 张</Typography.Text>
      </Space>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
          gap: 12,
        }}
      >
        {assets.map((asset) => {
          const selected = selectedIds.includes(asset.id);
          const conflicted = !!asset.conflictWith;
          const stale =
            asset.status !== '已归档' &&
            !conflicted &&
            currentLineVersion !== undefined &&
            asset.lineVersion !== currentLineVersion;
          const peer = peerOf?.[asset.id];
          return (
            <Card
              key={asset.id}
              size="small"
              hoverable
              style={{
                borderColor: conflicted ? '#ff4d4f' : stale ? '#fa8c16' : selected ? '#1677ff' : undefined,
              }}
              styles={{ body: { padding: 8 } }}
            >
              <div style={{ position: 'relative' }}>
                <img
                  src={thumbs[asset.id]}
                  alt={asset.imageNo}
                  style={{ width: '100%', display: 'block', borderRadius: 4, background: '#eef2f6' }}
                />
                <div style={{ position: 'absolute', top: 4, left: 4 }}>
                  <Checkbox checked={selected} onChange={() => onToggle(asset.id)} />
                </div>
                <div style={{ position: 'absolute', top: 4, right: 4, display: 'flex', gap: 4 }}>
                  {conflicted ? <Tag color="red" icon={<WarningOutlined />}>冲突</Tag> : null}
                  <Tag color={QUALITY_COLOR[asset.quality]}>{asset.quality}</Tag>
                </div>
              </div>
              <Typography.Text strong style={{ display: 'block', marginTop: 6 }}>
                {asset.imageNo}
              </Typography.Text>
              <Space size={4} wrap style={{ marginTop: 2 }}>
                <Tag color={STATUS_COLOR[asset.status]} style={{ marginInlineEnd: 0 }}>
                  {asset.status}
                </Tag>
                <Tooltip title={`导入时间 ${formatShotAt(asset.importedAt)}`}>
                  <Tag style={{ marginInlineEnd: 0 }}>{asset.batchId}</Tag>
                </Tooltip>
                {asset.sortie ? <Tag color="geekblue">第 {asset.sortie} 架次</Tag> : null}
                {stale ? <Tag color="orange">航线改动待重认</Tag> : null}
                {asset.qualityTouched ? <Tag color="cyan">质量已人工确认</Tag> : null}
              </Space>
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                {asset.lng.toFixed(5)}, {asset.lat.toFixed(5)}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                GSD {asset.gsd} cm/px · 重叠 {asset.overlap}% · 倾角 {asset.tiltAngle}°
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                航高 {asset.altitude} m · {formatShotAt(asset.shotAt)}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }} ellipsis>
                {asset.folder}
              </Typography.Text>
              {conflicted && peer ? (
                <div style={{ marginTop: 6, padding: 6, background: '#fff2f0', border: '1px solid #ffccc7', borderRadius: 4 }}>
                  <Typography.Text type="danger" style={{ fontSize: 12, display: 'block' }}>
                    与 {peer.batchId} 批次同片号记录位置/时间不一致
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                    对端：{peer.lng.toFixed(5)}, {peer.lat.toFixed(5)} · {formatShotAt(peer.shotAt)}
                  </Typography.Text>
                  <Space size={4} style={{ marginTop: 4 }} wrap>
                    <Tooltip title={peer.status === '已归档' ? '对端已归档，法定保留，不能删除' : undefined}>
                      <Button
                        size="small"
                        type="primary"
                        danger
                        disabled={peer.status === '已归档'}
                        onClick={() => onResolveKeep?.(asset)}
                      >
                        保留本条
                      </Button>
                    </Tooltip>
                  </Space>
                </div>
              ) : null}
              {onLocate ? (
                <Button size="small" type="link" icon={<AimOutlined />} onClick={() => onLocate(asset)}>
                  定位到图
                </Button>
              ) : null}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
