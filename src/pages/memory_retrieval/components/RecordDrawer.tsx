// src/pages/memory_retrieval/components/RecordDrawer.tsx
//
// L1 / L2 表格点某一行之后拉起来的**右侧抽屉**：显示那一行的全文。
//
// ⚠️ 两层的"全文"来源不一样，别合成一条路：
//   · **L1（fact）**：`/query/l1` 本来就返回**完整正文**（浏览端点不截断），所以这一
//     行的数据已经在手上了 —— 抽屉**不发请求**，`FactRecord` 直接带过来即可。
//   · **L2（scene）**：列表恒为 `SceneSummary`（**没有 content**），正文必须另一趟
//     `/query/l2/detail`，而且**找不到就 404** —— 所以那一分支有 loading / error /
//     data 三态，由页面拿着。
//
// 为什么要放在这里而不是 L1View / L2View 各自一份：两个列表都会开它，而它在这页里
// **只有一个实例**（页面上同一时刻只可能有一篇正在看的全文）。各画一份会得到两个
// 抽屉 DOM、两套尖加载状态，而且 `_mock` / 探针要同时管两个。
import { Alert, Drawer, Space, Typography } from 'antd';
import React from 'react';

import type { FactRecord, SceneDetail } from '../data';
import { shortId } from '../utils';
import { FactDetailBody, SceneDetailBody } from './ResultViews';

/**
 * 抽屉里当前那条。**`kind` 决定要不要再发请求**（见文件头）。
 *
 * ⚠️ 用判别联合而不是 `{ fact?: FactRecord; scene?: SceneSummary }` ——
 *    后者允许"两个都有"这种页面里发不出来的形态。
 */
export type RecordRef =
  | { kind: 'fact'; record: FactRecord }
  | { kind: 'scene'; filename: string };

/** `/query/l2/detail` 那一趟的三态。只有 L2 用得上，L1 永远是全空。 */
export interface SceneFullState {
  loading: boolean;
  error: string | null;
  data: SceneDetail | null;
}

export const EMPTY_SCENE_FULL: SceneFullState = {
  loading: false,
  error: null,
  data: null,
};

export interface RecordDrawerProps {
  /** null = 抽屉关着。 */
  opened: RecordRef | null;
  scene: SceneFullState;
  onClose: () => void;
}

/** 卡头：先说清看的是什么的全文，再补那个在这一层唯一的标识。 */
const titleOf = (ref: RecordRef) => {
  if (ref.kind === 'fact') {
    return (
      <Space size={6}>
        <span>原子记忆全文</span>
        <Typography.Text
          type="secondary"
          style={{ fontSize: 12, fontFamily: 'monospace' }}
          title={ref.record.record_id}
        >
          {shortId(ref.record.record_id)}
        </Typography.Text>
      </Space>
    );
  }
  return (
    <Space size={6}>
      <span>场景全文</span>
      <Typography.Text
        type="secondary"
        style={{ fontSize: 12, fontFamily: 'monospace' }}
      >
        {ref.filename}
      </Typography.Text>
    </Space>
  );
};

export const RecordDrawer: React.FC<RecordDrawerProps> = ({
  opened,
  scene,
  onClose,
}) => {
  const body = () => {
    if (!opened) return null;

    if (opened.kind === 'fact') {
      return <FactDetailBody record={opened.record} />;
    }

    if (scene.error) {
      return (
        <Alert
          type="error"
          showIcon
          title="取场景全文失败"
          description={scene.error}
        />
      );
    }
    if (scene.loading) {
      return <Typography.Text type="secondary">正在取全文…</Typography.Text>;
    }
    return scene.data ? <SceneDetailBody scene={scene.data} /> : null;
  };

  return (
    <Drawer
      open={opened !== null}
      size={760}
      placement="right"
      title={opened ? titleOf(opened) : null}
      onClose={onClose}
      destroyOnHidden
    >
      {body()}
    </Drawer>
  );
};
