import { useMemo, useState } from 'react';
import { Alert, Button, Input, Modal, Space, Table, Tag, Typography } from 'antd';
import { ImportOutlined } from '@ant-design/icons';
import { buildSortieTextFromWaypoints, parseSortieText } from '../../utils/sortie';
import type { SortieRowError, SortieRowInput } from '../../types/imageasset';
import type { Waypoint } from '../../types/waypoint';

export interface SortieImportModalProps {
  open: boolean;
  missionNo: string;
  waypoints: Waypoint[];
  gsd: number;
  defaultBatchId: string;
  onClose: () => void;
  /** 执行对账导入，返回导入结果 */
  onImport: (batchId: string, rows: SortieRowInput[]) => Promise<{ added: number; duplicated: number; merged: number; conflicted: number }>;
}

/**
 * 外业离线编目架次清单导入：
 * 支持粘贴或选择 .csv/.txt，列为 片号,经度,纬度,时间,GSD,重叠度,质量[,航高,倾角,架次,归档目录]；
 * 也可按航点一键生成示范清单。
 */
export default function SortieImportModal({
  open,
  missionNo,
  waypoints,
  gsd,
  defaultBatchId,
  onClose,
  onImport,
}: SortieImportModalProps) {
  const [batchId, setBatchId] = useState(defaultBatchId);
  const [sortie, setSortie] = useState(1);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const { rows, errors } = useMemo(
    () => (text.trim() ? parseSortieText(text, sortie || undefined) : { rows: [], errors: [] as SortieRowError[] }),
    [text, sortie],
  );

  const fillFromWaypoints = () => {
    if (waypoints.length === 0) {
      setError('该任务暂无航点，请先到「航点明细」录入');
      return;
    }
    if (!batchId.trim()) setBatchId(defaultBatchId);
    setText(buildSortieTextFromWaypoints(waypoints, gsd || 3.22, missionNo, sortie || 1));
    setError('');
  };

  const pickFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,.txt,text/csv,text/plain';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => setText(String(reader.result ?? ''));
      reader.readAsText(file, 'utf-8');
    };
    input.click();
  };

  const doImport = async () => {
    const trimmedBatch = batchId.trim();
    if (!trimmedBatch) {
      setError('请填写外业编目批次号（同批次重复导入不新增）');
      return;
    }
    if (rows.length === 0) {
      setError(errors.length ? '存在无法解析的行，请修正后再导入' : '请粘贴或选择架次清单');
      return;
    }
    setSubmitting(true);
    try {
      const r = await onImport(trimmedBatch, rows);
      const parts = [`新增 ${r.added}`, `重复跳过 ${r.duplicated}`, `合并更新 ${r.merged}`, `冲突 ${r.conflicted}`];
      Modal.success({
        title: '架次清单对账完成',
        content: (
          <Space direction="vertical" size={4}>
            <Typography.Text>{parts.join(' · ')}</Typography.Text>
            {r.conflicted > 0 ? <Typography.Text type="danger">冲突片请到成果页红色卡片逐条人工裁决。</Typography.Text> : null}
          </Space>
        ),
      });
      setText('');
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="导入外业架次清单（离线编目 → 内业对账）"
      width={860}
      onCancel={onClose}
      onOk={doImport}
      okText="导入并对账"
      confirmLoading={submitting}
      okButtonProps={{ icon: <ImportOutlined /> }}
      destroyOnClose
    >
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        {error ? <Alert type="error" showIcon message={error} /> : null}
        <Space wrap size={10}>
          <span>
            <Typography.Text type="secondary">批次号</Typography.Text>{' '}
            <Input style={{ width: 220 }} value={batchId} onChange={(e) => setBatchId(e.target.value)} placeholder="如 B-20261001-01" />
          </span>
          <span>
            <Typography.Text type="secondary">架次</Typography.Text>{' '}
            <Input style={{ width: 80 }} type="number" value={sortie} onChange={(e) => setSortie(Number(e.target.value) || 1)} />
          </span>
          <Button onClick={fillFromWaypoints}>按航点生成示范清单</Button>
          <Button onClick={pickFile}>选择 .csv / .txt</Button>
        </Space>
        <Alert
          type="info"
          showIcon
          message="列序：片号,经度,纬度,时间,GSD,重叠度,质量[,航高,倾角,架次,归档目录]；首行可为中文表头。同批次同片号不新增；不同批次同片号位置(≤2m)/时间(≤5s)一致则合并，否则列为冲突。人工标记过的质量不会被覆盖。"
        />
        <Input.TextArea
          rows={9}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'片号,经度,纬度,时间,GSD,重叠度,质量\nDJI_0001,116.39170,39.90710,2026-10-01 10:20:31,3.22,75,合格'}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />
        <Space size={10} wrap>
          <Tag color="blue">可解析 {rows.length} 行</Tag>
          <Tag color="red">错误 {errors.length} 行</Tag>
        </Space>
        {rows.length > 0 ? (
          <Table<SortieRowInput>
            size="small"
            rowKey={(r) => `${r.imageNo}-${r.shotAt}`}
            pagination={{ pageSize: 5, size: 'small' }}
            dataSource={rows}
            columns={[
              { title: '片号', dataIndex: 'imageNo', width: 110 },
              { title: '经度', dataIndex: 'lng', width: 100, render: (v: number) => v.toFixed(5) },
              { title: '纬度', dataIndex: 'lat', width: 100, render: (v: number) => v.toFixed(5) },
              { title: '时间', dataIndex: 'shotAt', width: 160, render: (v: number) => new Date(v).toLocaleString('zh-CN', { hour12: false }) },
              { title: 'GSD', dataIndex: 'gsd', width: 70 },
              { title: '重叠%', dataIndex: 'overlap', width: 70 },
              { title: '质量', dataIndex: 'quality', width: 70 },
            ]}
          />
        ) : null}
        {errors.length > 0 ? (
          <Table<SortieRowError>
            size="small"
            rowKey={(r) => `${r.line}-${r.reason}`}
            pagination={{ pageSize: 5, size: 'small' }}
            dataSource={errors}
            columns={[
              { title: '行号', dataIndex: 'line', width: 70 },
              { title: '原因', dataIndex: 'reason', width: 200 },
              { title: '原文', dataIndex: 'raw', ellipsis: true },
            ]}
          />
        ) : null}
      </Space>
    </Modal>
  );
}
