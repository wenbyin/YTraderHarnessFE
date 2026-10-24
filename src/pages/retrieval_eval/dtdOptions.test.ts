// src/pages/retrieval_eval/dtdOptions.test.ts
//
// DTD 显示名解析的接线条测试。
//
// 这一层看着像"纯 lookup"，但有三个容易静默错掉的地方：
//
//   1. 兜底文案**不能是 unknown**。真实后端的 DTD id 是随机 UUID，全屏 unknown
//      会让所有标签长得一模一样 —— 连"这两个是不是同一个 DTD"都看不出来。
//   2. 并发去重。三个页面（列表/详情/跑测）同时挂载会各触发一次加载；
//      没有 inflight 去重就是三个请求，其中两个纯属浪费。
//   3. **失败必须不抛**。DTD 名字只是展示层信息，拉不到应当退化成短 UUID，
//      而不是把一个辅助请求的失败升级成整页报错。
import { describe, expect, it, vi } from 'vitest';

const listDtdOptions = vi.fn();
vi.mock('./service', () => ({
  listDtdOptions: () => listDtdOptions(),
}));

/** 每个用例都要一份**全新的模块实例** —— 缓存是模块级的，不重置会串味。 */
async function freshModule() {
  vi.resetModules();
  return import('./dtdOptions');
}

const DEMO_DTD = '1d2b1f04-f4d1-4587-8a0f-5fc1c7c51e15';

describe('dtdLabel', () => {
  it('真实数据没到时：演示表里的 id 给 type_key，未知 id 给短 UUID（不是 unknown）', async () => {
    const { dtdLabel } = await freshModule();

    expect(dtdLabel(DEMO_DTD)).toBe('company_announcement');

    // 真实后端那种随机 UUID：显示前 8 位，而不是 'unknown'
    expect(dtdLabel('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe('aaaaaaaa…');

    // 空值不该显示成 '…'
    expect(dtdLabel('')).toBe('-');
  });

  it('加载真实 DTD 后能解析真实 id', async () => {
    listDtdOptions.mockResolvedValue({
      items: [
        {
          document_type_definition_id: 'real-dtd-1',
          type_key: 'real_type',
          name: '真实类型',
          modality_type: 'text',
        },
      ],
    });

    const { dtdLabel, loadDtdOptions } = await freshModule();
    await loadDtdOptions();

    expect(dtdLabel('real-dtd-1')).toBe('real_type');
  });

  it('并发加载只打一次接口', async () => {
    listDtdOptions.mockClear();
    listDtdOptions.mockResolvedValue({ items: [] });

    const { loadDtdOptions } = await freshModule();
    await Promise.all([loadDtdOptions(), loadDtdOptions(), loadDtdOptions()]);

    expect(listDtdOptions).toHaveBeenCalledTimes(1);
  });

  it('接口失败不抛错，标签退化成短 UUID', async () => {
    listDtdOptions.mockRejectedValue(new Error('boom'));

    const { dtdLabel, loadDtdOptions } = await freshModule();

    await expect(loadDtdOptions()).resolves.toEqual([]);
    expect(dtdLabel('real-dtd-1')).toBe('real-dtd…');
  });
});
