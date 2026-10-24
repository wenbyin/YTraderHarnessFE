// src/pages/skill/index.tsx
//
// 技能管理（卡片式）。契约见 YTraderHarness/design_skills/skill_management_openapi.yaml。
//
// 页面只回答两件事：
//   1. 有哪些 skill 定义、各自是什么状态；
//   2. 每个 skill 绑了哪些 capability（= 子 agent 能看到的工具范围）。
//
// 三个**由契约决定**的页面形态，不是设计偏好：
//
//   · **一次取满 + 前端筛选**。列表接口支持 status / q / capability_id 三个
//     服务端过滤，但页面同时要显示"全部 12 / 已启用 7 / 草稿 4 / 已停用 1"
//     这种计数 —— 走服务端过滤就得为每个状态各发一次请求，而且切筛选会闪。
//     skill 是配置项量级（几十个），一次取满在前端筛更稳。
//
//   · **列表拿到之后要补一次能力绑定**。`SkillSummary` 里没有 capabilities
//     （见 service.ts 头注释），但卡片不显示绑定就完全没有信息量。所以对当前页
//     逐条 GET 详情并缓存，最多 MAX_ENRICH 条。
//
//   · **没有"授权"这个概念**。绑定只决定工具可见性；页面文案不能出现
//     "权限 / 授权 / 允许访问"这类词，否则使用者会拿它去当权限系统用。
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  Alert,
  App,
  Button,
  Empty,
  Input,
  Segmented,
  Spin,
  Typography,
} from 'antd';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import CapabilitySelect from './components/CapabilitySelect';
import SkillCard from './components/SkillCard';
import SkillDrawer from './components/SkillDrawer';
import type {
  Capability,
  CapabilityRef,
  SkillDetail,
  SkillStatus,
  SkillSummary,
} from './data';
import { SKILL_STATUS_META, SKILL_STATUS_ORDER, toSummary } from './data';
import {
  enrichCapabilities,
  listCapabilities,
  listSkills,
  skillErrorMessage,
  USE_MOCK_SKILL,
} from './service';
import { useStyles } from './style';

/** 契约的 page_size 上限（200）。 */
const PAGE_SIZE = 200;

/**
 * 补能力绑定的条数上限。
 *
 * 补绑定是 N+1（列表不带 capabilities）。管理页流量低，几十条可以接受；
 * 上千条时会打出几百个请求，那就只补前一屏 —— 卡片上会显示"能力绑定未加载"，
 * 点进抽屉仍能看到真实绑定。
 */
const MAX_ENRICH = 60;

type StatusFilter = 'ALL' | SkillStatus;

const SkillPage: React.FC = () => {
  const { styles } = useStyles();
  const { message } = App.useApp();

  const [rows, setRows] = useState<SkillSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [capsById, setCapsById] = useState<Record<string, CapabilityRef[]>>({});
  const [capsLoading, setCapsLoading] = useState(false);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [status, setStatus] = useState<StatusFilter>('ALL');
  const [keyword, setKeyword] = useState('');
  const [capFilter, setCapFilter] = useState<string | undefined>(undefined);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerSkillId, setDrawerSkillId] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setLoadError(null);

    try {
      const response = await listSkills({ page: 1, page_size: PAGE_SIZE });
      setRows(response.items);
      setTotal(response.total);

      // 绑定单独补：失败不影响列表本身（enrich 内部用 allSettled）
      setCapsLoading(true);
      const enriched = await enrichCapabilities(
        response.items.slice(0, MAX_ENRICH),
      );
      setCapsById((prev) => (silent ? { ...prev, ...enriched } : enriched));
    } catch (error: unknown) {
      setLoadError(skillErrorMessage(error, '加载技能列表失败'));
    } finally {
      setCapsLoading(false);
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 能力字典：一次拉全，抽屉里的绑定与工具栏的筛选共用同一份。
  useEffect(() => {
    let cancelled = false;
    listCapabilities()
      .then((list) => {
        if (!cancelled) setCapabilities(list);
      })
      .catch(() => {
        if (cancelled) return;
        setCapabilities([]);
        message.warning('能力字典加载失败，暂时无法绑定或按能力筛选');
      });
    return () => {
      cancelled = true;
    };
  }, [message]);

  const inactiveIds = useMemo(
    () =>
      new Set(
        capabilities
          .filter((item) => item.is_active === false)
          .map((item) => item.id),
      ),
    [capabilities],
  );

  /** 关键词 + 能力两种筛选（不含状态），用来算各状态的计数。 */
  const nonStatusMatched = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return rows.filter((item) => {
      if (kw !== '') {
        const haystack =
          `${item.skill_key} ${item.name} ${item.description}`.toLowerCase();
        if (!haystack.includes(kw)) return false;
      }
      if (capFilter) {
        const bound = capsById[item.id];
        // 绑定还没补到时不算命中：宁可漏，也不要给一条"看起来符合"的错结果
        if (!bound?.some((cap) => cap.id === capFilter)) return false;
      }
      return true;
    });
  }, [rows, keyword, capFilter, capsById]);

  const counts = useMemo(() => {
    const base: Record<StatusFilter, number> = {
      ALL: nonStatusMatched.length,
      ACTIVE: 0,
      DRAFT: 0,
      DISABLED: 0,
    };
    for (const item of nonStatusMatched) base[item.status] += 1;
    return base;
  }, [nonStatusMatched]);

  const filtered = useMemo(
    () =>
      status === 'ALL'
        ? nonStatusMatched
        : nonStatusMatched.filter((item) => item.status === status),
    [nonStatusMatched, status],
  );

  const openCreate = useCallback(() => {
    setDrawerSkillId(null);
    setDrawerOpen(true);
  }, []);

  const openSkill = useCallback((skill: SkillSummary) => {
    setDrawerSkillId(skill.id);
    setDrawerOpen(true);
  }, []);

  const handleSaved = useCallback(
    async (saved: SkillDetail) => {
      // 先本地插/替，抽屉关掉的瞬间列表就是新的；再静默拉一次，把排序（updated_at）
      // 和可能变化的筛选结果对齐。
      setRows((prev) => {
        const summary = toSummary(saved);
        return prev.some((item) => item.id === saved.id)
          ? prev.map((item) => (item.id === saved.id ? summary : item))
          : [summary, ...prev];
      });
      setCapsById((prev) => ({ ...prev, [saved.id]: saved.capabilities }));
      setDrawerOpen(false);
      await load(true);
    },
    [load],
  );

  const handleDeleted = useCallback(
    async (skillId: string) => {
      setRows((prev) => prev.filter((item) => item.id !== skillId));
      setCapsById((prev) => {
        const next = { ...prev };
        delete next[skillId];
        return next;
      });
      setDrawerOpen(false);
      await load(true);
    },
    [load],
  );

  const statusOptions = (['ALL', ...SKILL_STATUS_ORDER] as StatusFilter[]).map(
    (value) => ({
      value,
      label:
        value === 'ALL'
          ? `全部 ${counts.ALL}`
          : `${SKILL_STATUS_META[value].label} ${counts[value]}`,
    }),
  );

  return (
    <PageContainer
      title="技能管理"
      subTitle="skill 定义与 capability 绑定；绑定只决定子 agent 能看到哪些工具，不是授权。"
      extra={[
        <Button
          key="create"
          type="primary"
          icon={<PlusOutlined />}
          onClick={openCreate}
        >
          新建技能
        </Button>,
      ]}
    >
      {USE_MOCK_SKILL ? (
        <Alert
          className={styles.mockAlert}
          type="warning"
          showIcon
          title="当前是本地模拟数据"
          description="localStorage['skill:mock']='1' · 刷新即复位"
        />
      ) : null}

      <div className={styles.toolbar}>
        <Segmented
          value={status}
          onChange={(value) => setStatus(value as StatusFilter)}
          options={statusOptions}
        />
        <Input.Search
          className={styles.keyword}
          allowClear
          placeholder="搜 skill_key / 名称 / 描述"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
        />
        <CapabilitySelect
          className={styles.capFilter}
          capabilities={capabilities}
          value={capFilter}
          onChange={setCapFilter}
        />
        <div className={styles.toolbarPush} />
        <Button
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={() => void load()}
        >
          刷新
        </Button>
      </div>

      {loadError ? (
        <Alert
          type="error"
          showIcon
          title="加载技能列表失败"
          description={loadError}
          action={
            <Button size="small" onClick={() => void load()}>
              重试
            </Button>
          }
        />
      ) : (
        <Spin spinning={loading}>
          {filtered.length === 0 ? (
            <Empty
              description={
                rows.length === 0
                  ? '还没有任何技能。技能是子 agent 的定义，主 agent 只会看到「已启用」的那些。'
                  : '没有符合筛选条件的技能'
              }
            >
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={openCreate}
              >
                新建技能
              </Button>
            </Empty>
          ) : (
            <div className={styles.grid}>
              {filtered.map((skill) => (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  capabilities={capsById[skill.id]}
                  capsLoading={capsLoading}
                  inactiveIds={inactiveIds}
                  onOpen={openSkill}
                />
              ))}
            </div>
          )}

          {total > rows.length ? (
            <Typography.Text type="secondary" className={styles.gridNote}>
              仅显示前 {rows.length} 条（共 {total}{' '}
              条）。请用搜索或能力筛选缩小范围。
            </Typography.Text>
          ) : null}
        </Spin>
      )}

      <SkillDrawer
        open={drawerOpen}
        skillId={drawerSkillId}
        capabilities={capabilities}
        onClose={() => setDrawerOpen(false)}
        onSaved={handleSaved}
        onDeleted={handleDeleted}
      />
    </PageContainer>
  );
};

export default SkillPage;
