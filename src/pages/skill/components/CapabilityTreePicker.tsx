// src/pages/skill/components/CapabilityTreePicker.tsx
//
// 技能 → 能力绑定。**刻意做成工具页「业务分类」页签（ClassEditor）的同款**：
// 树形多选、父子互不联动、停用项标出来。两个页面绑的是同一棵 capability 树，
// 长得不一样只会让人以为是两套数据。
//
// 三个与契约强相关、不能"优化"掉的点：
//
//  1. **checkStrictly**。antd Tree 默认父子联动（勾父自动勾子），但绑定的语义是
//     **精确匹配**：勾「检索」不等于勾「检索 / 全文召回」，运行时解析工具也
//     不沿 parent_id 递归。父子必须能独立勾选。
//     反过来这也解决了"父能力本身要不要能绑"的问题 —— checkStrictly 下父节点
//     就是普通可勾项（父能力的 code 也可能直接挂着工具）。
//
//  2. **is_active=false 仍留在树里**，但要标「已停用」。它还在绑定表里，
//     删掉会让人以为绑定丢了；可解析时它按未绑定处理，所以必须让人看见
//     "勾了也没用"。
//
//  3. **不做"勾父自动补子"**。工具的 PUT 是全量替换，多勾一个就是多绑一个，
//     真按父→子展开，用户会莫名其妙多出一堆他没点过的绑定。
import { Empty, Tag, Tooltip, Tree, Typography } from 'antd';
import type { DataNode } from 'antd/es/tree';
import React, { useMemo } from 'react';
import type { Capability, TreeNode } from '../data';
import { buildTree } from '../data';
import { useStyles } from '../style';

interface CapabilityTreePickerProps {
  capabilities: readonly Capability[];
  /** 已勾选的能力 id（受控，配合 Form.Item 的 value/onChange） */
  value?: string[];
  onChange?: (value: string[]) => void;
  disabled?: boolean;
}

/**
 * 树节点 → antd treeData。名称 + code + 停用标记，与工具页一致。
 *
 * ⚠️ 标题里**不要**套 inline-flex / display:block 的容器：antd Tree 的展开箭头是
 *    用 float 摆的，名称一旦成为原子盒子，宽度放不下就会整块掉到下一行、箭头
 *    孤零零留在上一行（这一点在工具页的 style.ts 里已经踩过）。
 *    所以这里全部用行内元素 + margin，靠文本自然折行。
 */
function toDataNodes(nodes: TreeNode<Capability>[]): DataNode[] {
  return nodes.map(({ node, children }) => ({
    key: node.id,
    title: (
      <>
        <span>{node.name}</span>
        <Typography.Text
          type="secondary"
          style={{ fontSize: 11, marginInlineStart: 4 }}
        >
          {node.code}
        </Typography.Text>
        {node.is_active === false ? (
          <Tooltip title="is_active = false：解析工具时按未绑定处理，勾上去等于白勾">
            <Tag color="warning" style={{ fontSize: 10, marginInlineStart: 4 }}>
              已停用
            </Tag>
          </Tooltip>
        ) : null}
      </>
    ),
    children: toDataNodes(children),
  }));
}

const CapabilityTreePicker: React.FC<CapabilityTreePickerProps> = ({
  capabilities,
  value,
  onChange,
  disabled,
}) => {
  const { styles } = useStyles();
  const treeData = useMemo(
    () => toDataNodes(buildTree(capabilities)),
    [capabilities],
  );

  if (treeData.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="还没有任何能力 —— 先在「工具定义 → 业务分类」里建一棵树"
      />
    );
  }

  return (
    <div className={styles.treePanel}>
      <Tree
        checkable
        checkStrictly
        disabled={disabled}
        treeData={treeData}
        // 能力字典是异步来的：不给 defaultExpandAll 的话，树在数据到位前就挂载了，
        // 之后永远是收起状态，用户会以为树是空的。用 key 跟着字典重建一次。
        key={capabilities.length}
        defaultExpandAll
        checkedKeys={value ?? []}
        onCheck={(checked) => {
          const ids = Array.isArray(checked)
            ? checked
            : ((checked as { checked: React.Key[] }).checked ?? []);
          onChange?.(ids.map(String));
        }}
      />
    </div>
  );
};

export default CapabilityTreePicker;
