// src/pages/tool/components/ClassEditor.tsx
// 业务分类绑定 —— 树形多选，N:N。
//
// 三个容易做错的点：
//
//  1. **checkStrictly = true**。antd Tree 默认父子联动（勾父自动勾子），
//     但契约里 classifications 是一个**扁平的 id 列表**，勾「行情数据」
//     并不等于勾了它下面每一个子类。父子必须能独立勾选 ——
//     列表筛选用的 classification_code 只精确匹配单个节点，
//     两种语义混在一个控件里迟早出鬼。
//
//  2. **PUT 全量替换**（replaceToolClassifications）：没带回来的 id = 解绑。
//     所以保存一律提交当前草稿全集，不做增量。
//
//  3. is_active=false 的分类仍在树里可选，但要**显著标出** ——
//     它不再参与 LLM 路由，勾上去等于白勾，不能让人以为是勾成功了。
import {
  Button,
  Card,
  Empty,
  Space,
  Tag,
  Tooltip,
  Tree,
  Typography,
} from 'antd';
import type { DataNode } from 'antd/es/tree';
import React, { useMemo } from 'react';
import {
  buildTree,
  type Capability,
  classificationMap,
  classPath,
  type TreeNode,
} from '../data';
import { useStyles } from '../style';

interface ClassEditorProps {
  /** 全部分类（用来建树） */
  classifications: Capability[];
  /** 已保存的绑定 */
  saved: Capability[];
  /** 草稿（classification_id 列表） */
  draft: string[];
  dirty: boolean;
  saving: boolean;
  onDraftChange: (ids: string[]) => void;
  onSave: () => void;
  onReset: () => void;
}

/** 把我们的树节点转成 antd Tree 的 treeData。停用的分类加后缀标记。 */
function toDataNodes(nodes: TreeNode<Capability>[]): DataNode[] {
  return nodes.map(({ node, children }) => ({
    key: node.id,
    title: (
      <Space size={4}>
        <span>{node.name}</span>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {node.code}
        </Typography.Text>
        {node.is_active === false ? (
          <Tooltip title="is_active = false：不再参与 LLM 路由，勾上去等于白勾">
            <Tag color="warning" style={{ fontSize: 10 }}>
              已停用
            </Tag>
          </Tooltip>
        ) : null}
      </Space>
    ),
    children: toDataNodes(children),
  }));
}

const ClassEditor: React.FC<ClassEditorProps> = ({
  classifications,
  saved,
  draft,
  dirty,
  saving,
  onDraftChange,
  onSave,
  onReset,
}) => {
  const { styles } = useStyles();
  const map = useMemo(
    () => classificationMap(classifications),
    [classifications],
  );
  const treeData = useMemo(
    () => toDataNodes(buildTree(classifications)),
    [classifications],
  );

  const inactiveChosen = draft.filter((id) => map[id]?.is_active === false);

  return (
    <>
      <div className={styles.docBlock}>
        <div className={styles.docBlockHead}>
          <Typography.Text strong>当前绑定</Typography.Text>
          <span style={{ flex: 1 }} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {saved.length} 个
          </Typography.Text>
        </div>
        {saved.length ? (
          <Space size={6} wrap>
            {saved.map((c) => (
              <Tag
                key={c.id}
                color={c.is_active === false ? 'orange' : 'blue'}
                title={`${c.code}${c.description ? ` · ${c.description}` : ''}`}
              >
                {classPath(c.id, map)}
              </Tag>
            ))}
          </Space>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            还没挂任何分类 —— LLM 路由时它不会被优先选中。
          </Typography.Text>
        )}
        {inactiveChosen.length ? (
          <div
            className={styles.hint}
            style={{ marginTop: 6, color: '#d46b08' }}
          >
            草稿里有 {inactiveChosen.length} 个<b>已停用</b>的分类，
            它们不再参与路由 —— 勾上去等于白勾。
          </div>
        ) : null}
      </div>

      <div className={styles.docBlock}>
        <div className={styles.docBlockHead}>
          <Typography.Text strong>编辑绑定</Typography.Text>
          <Tag>PUT /tools/&#123;id&#125;/classifications</Tag>
          <span style={{ flex: 1 }} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            父子互不联动
          </Typography.Text>
        </div>

        {treeData.length ? (
          <div className={styles.treePanel}>
            <Tree
              checkable
              checkStrictly
              treeData={treeData}
              checkedKeys={draft}
              onCheck={(checked) => {
                const ids = Array.isArray(checked)
                  ? checked
                  : ((checked as { checked: React.Key[] }).checked ?? []);
                onDraftChange(ids.map(String));
              }}
            />
          </div>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="还没有任何分类 —— 先在右上「分类体系」里建一棵"
          />
        )}

        <div className={styles.caption}>
          父子可以<b>同时勾</b>：勾「行情数据 / A股行情」时把父节点也勾上，
          路由按父分类兜底时才命中得了它 —— 列表接口的{' '}
          <span className={styles.mono}>classification_code</span>{' '}
          只精确匹配一个节点，<b>不含子分类</b>。
        </div>
      </div>

      <Card size="small" title="PUT 请求体预览" style={{ marginTop: 12 }}>
        <pre className={styles.jsonBlock}>
          {JSON.stringify({ classification_ids: draft }, null, 2)}
        </pre>
      </Card>

      {/* 操作行与处理链页签同一套：状态居左、按钮右对齐（styles.actionsRow） */}
      <div className={styles.actionsRow}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {dirty ? '有未保存的修改' : '已与服务端一致'}
        </Typography.Text>
        <span style={{ flex: 1 }} />
        <Button disabled={!dirty} onClick={onReset}>
          放弃修改
        </Button>
        <Button
          type="primary"
          loading={saving}
          disabled={!dirty}
          onClick={onSave}
        >
          保存（全量替换）
        </Button>
      </div>
    </>
  );
};

export default ClassEditor;
