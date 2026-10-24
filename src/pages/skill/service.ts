// src/pages/skill/service.ts
//
// 对接 design_skills/skill_management_openapi.yaml（v1.0.0）的 7 条路由：
//
//   POST   /api/v1/skills                          → 201 SkillDetail
//   GET    /api/v1/skills                          → 200 { items, page, page_size, total }
//   GET    /api/v1/skills/{skill_id}               → 200 SkillDetail / 404
//   PATCH  /api/v1/skills/{skill_id}               → 200 SkillDetail
//   DELETE /api/v1/skills/{skill_id}               → 204 / 409（被其它表引用）
//   GET    /api/v1/skills/{skill_id}/capabilities  → 200 CapabilityRef[]
//   PUT    /api/v1/skills/{skill_id}/capabilities  → 200 CapabilityRef[]
//
// 后端已落地：`app/api/v1/skills.py`（2026-10-20）。默认走真实接口。
// 需要离线看页面 / 跑视觉验收时，把 `localStorage['skill:mock']` 设成 '1'
// 就会切到 `mockData.ts` 的内存实现（页面头部会显式打「本地模拟」标签）。
//
// ⚠️ 列表接口**不返回 capabilities**（SkillSummary 里没有这个字段，已核对
//    app/services/skill/domain/schemas/skill.py），但技能页离开"绑了哪些能力"
//    就没信息量了。所以拿到 summary 之后对每条补一次 detail
//    （`Promise.allSettled`）。这等于 N+1 —— 取舍是管理页流量低、卡片必须能
//    看出绑定关系；等后端把 capabilities 加进 SkillSummary（或给个批量端点），
//    删掉 enrichCapabilities 即可。
import { request } from '@umijs/max';

import type {
  Capability,
  CapabilityRef,
  SkillCreate,
  SkillDetail,
  SkillListParams,
  SkillListResponse,
  SkillPatch,
  SkillSummary,
} from './data';
import * as mock from './mockData';

const SKILLS = '/api/v1/skills';
const CAPABILITIES = '/api/v1/capabilities';

const DEFAULT_USE_MOCK = false;

function resolveUseMock(): boolean {
  try {
    const flag = window.localStorage.getItem('skill:mock');
    if (flag === '0') return false;
    if (flag === '1') return true;
  } catch {
    // 隐私模式 / SSR：读不到 localStorage 就用默认值
  }
  return DEFAULT_USE_MOCK;
}

/** 当前是否走本地内存实现（页面头部会显示这件事）。 */
export const USE_MOCK_SKILL = resolveUseMock();

/** 从 umi request 的异常里取 HTTP 状态码。 */
export function skillErrorStatus(error: unknown): number | undefined {
  const status = (error as { response?: { status?: number } })?.response
    ?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * 把后端错误翻成一句能读的话。
 *
 * 这个模块的契约（openapi.yaml）里错误体是 `{ code, message, details }`，
 * 但 FastAPI 自己抛的 422 是 `{ detail: "..." }` 或 `{ detail: [{loc,msg}] }`。
 * 两种都得认，否则表单填错时用户只会看到 "422"。
 * mock 抛的 `MockApiError` 自带 message，直接透传。
 */
export function skillErrorMessage(
  error: unknown,
  fallback = '操作失败',
): string {
  if (error instanceof mock.MockApiError) return error.message;

  const response = (error as { response?: { data?: unknown } })?.response;
  const body = response?.data as
    | { detail?: unknown; message?: unknown }
    | undefined;

  if (typeof body?.detail === 'string' && body.detail.trim() !== '') {
    return body.detail;
  }

  if (Array.isArray(body?.detail)) {
    const messages = body.detail
      .map((item) => {
        const entry = item as { loc?: unknown; msg?: unknown };
        const loc = Array.isArray(entry.loc)
          ? entry.loc.filter((part) => part !== 'body').join('.')
          : '';
        const msg = String(entry.msg ?? '').replace(/^Value error,\s*/, '');
        return msg ? (loc ? `${loc}: ${msg}` : msg) : '';
      })
      .filter(Boolean);
    if (messages.length > 0) return messages.join('；');
  }

  // 本模块契约的错误体（409 重名 / 被引用时走这条）
  if (typeof body?.message === 'string' && body.message.trim() !== '') {
    return body.message;
  }

  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export async function listSkills(
  params: SkillListParams = {},
): Promise<SkillListResponse> {
  if (USE_MOCK_SKILL) return mock.mockListSkills(params);

  return request<SkillListResponse>(SKILLS, {
    method: 'GET',
    params,
    skipErrorHandler: true,
  });
}

export async function getSkill(skillId: string): Promise<SkillDetail> {
  if (USE_MOCK_SKILL) return mock.mockGetSkill(skillId);

  return request<SkillDetail>(`${SKILLS}/${skillId}`, {
    method: 'GET',
    skipErrorHandler: true,
  });
}

export async function createSkill(body: SkillCreate): Promise<SkillDetail> {
  if (USE_MOCK_SKILL) return mock.mockCreateSkill(body);

  return request<SkillDetail>(SKILLS, { method: 'POST', data: body });
}

export async function updateSkill(
  skillId: string,
  body: SkillPatch,
): Promise<SkillDetail> {
  if (USE_MOCK_SKILL) return mock.mockPatchSkill(skillId, body);

  return request<SkillDetail>(`${SKILLS}/${skillId}`, {
    method: 'PATCH',
    data: body,
  });
}

export async function deleteSkill(skillId: string): Promise<void> {
  if (USE_MOCK_SKILL) {
    mock.mockDeleteSkill(skillId);
    return;
  }

  await request<void>(`${SKILLS}/${skillId}`, { method: 'DELETE' });
}

export async function listSkillCapabilities(
  skillId: string,
): Promise<CapabilityRef[]> {
  if (USE_MOCK_SKILL) {
    return mock.mockGetSkill(skillId).capabilities;
  }

  return request<CapabilityRef[]>(`${SKILLS}/${skillId}/capabilities`, {
    method: 'GET',
    skipErrorHandler: true,
  });
}

export async function replaceSkillCapabilities(
  skillId: string,
  capabilityIds: string[],
): Promise<CapabilityRef[]> {
  if (USE_MOCK_SKILL)
    return mock.mockReplaceCapabilities(skillId, capabilityIds);

  return request<CapabilityRef[]>(`${SKILLS}/${skillId}/capabilities`, {
    method: 'PUT',
    data: { capability_ids: capabilityIds },
  });
}

/**
 * 能力树（`GET /api/v1/capabilities`）。
 *
 * 这不是技能模块的实体，但绑定时必须能选 —— 契约里 PUT 收的是 capability_id。
 * 不分页：能力是给路由用的字典，量级几十上百，一次拉全再自己建树更快。
 */
export async function listCapabilities(): Promise<Capability[]> {
  if (USE_MOCK_SKILL) return mock.mockCapabilities();

  return request<Capability[]>(CAPABILITIES, {
    method: 'GET',
    skipErrorHandler: true,
  });
}

/**
 * 给当前页的技能补上能力绑定（列表接口不带 capabilities，见文件头）。
 *
 * 单条失败**不影响整页**：拿不到就当作"未加载"，卡片不显示能力区，
 * 详情抽屉打开时还会再拉一次。用 allSettled 而不是 all，就是为了这一点。
 */
export async function enrichCapabilities(
  items: readonly SkillSummary[],
): Promise<Record<string, CapabilityRef[]>> {
  const settled = await Promise.allSettled(
    items.map((item) => getSkill(item.id)),
  );

  const result: Record<string, CapabilityRef[]> = {};
  settled.forEach((entry, index) => {
    if (entry.status === 'fulfilled') {
      result[items[index].id] = entry.value.capabilities;
    }
  });
  return result;
}
