// src/utils/retrievalType.ts
// retrieval_type 的中文展示名。
//
// 后端 RetrievalType 枚举（document.yaml / pipeline.yaml）取值为
//   document / keyword / sparse_vector / dense_vector / graph
// 这些是**契约键**：入库、查接口、拼路径都用它，不能改。
// 只有面向人看的那一层才翻译成中文 —— 所以这里是「展示映射」，
// 不是别名，任何写回后端的场合都必须用原始 key。
//
// 文档页（版本抽屉的 tab、时间线扇出分支）与类型定义页（配置下拉）
// 共用这一份，避免两处翻译漂移。

export const RETRIEVAL_TYPE_TEXT: Record<string, string> = {
  document: '原文',
  keyword: '关键词',
  sparse_vector: '稀疏向量',
  dense_vector: '稠密向量',
  graph: '图结构',
};

/**
 * 只显示中文名。适合空间紧凑的位置（Tab 标签、表格格）。
 * 未收录的取值**原样返回** —— 后端以后加新类型时，宁可露出英文 key，
 * 也不要显示成「未知」把信息吃掉。
 */
export function retrievalTypeLabel(type?: string | null): string {
  if (!type) return '—';
  return RETRIEVAL_TYPE_TEXT[type] ?? type;
}

/**
 * 「key（中文）」的形式。适合下拉选项、需要让人同时看到 key 的场合 ——
 * 排查问题时用户要能对照后端里的原始取值。
 */
export function retrievalTypeText(type?: string | null): string {
  if (!type) return '—';
  const text = RETRIEVAL_TYPE_TEXT[type];
  return text ? `${type}（${text}）` : type;
}
