// src/pages/document/chunkSample.ts
//
// ⚠️ 本文件是「前端示例数据」，只用于驱动版本抽屉里的 Chunk 列表。
//
// 背景：它是 versionResult.ts 里 useVersionChunks 的**降级兜底** —— 只在
// GET /document-versions/{vid}/retrievals/{rid}/chunks 取失败时才被用到。
// 那个接口后端已经实装（2026-09-21 实测 200 + 真实 chunk），所以正常路径下
// 走不到这里；留着是为了后端出故障时抽屉不至于整块开天窗。
import type { ChunkItem, ChunkListResult } from './data';

const CHUNK_SAMPLES = [
  '本季度产品发布说明覆盖了核心链路的重构：解析层改为按文件扩展名匹配 Loader，分块策略下沉到 RetrievalDefinition，索引绑定与存储后端解耦。',
  '在评估集上，新的切分策略将召回率从 71.4% 提升到 83.9%，同时单文档的 token 消耗下降约 18%，长文档的尾部信息丢失问题得到明显缓解。',
  '版本快照保留了当次执行时使用的完整 pipeline 配置，包括 loader、processor mode 与 config、实际绑定的 retrieval 以及 index / storage，用于结果复现。',
  '当同一文件被重复上传时，后端会比对 checksum 并返回 409 冲突，避免产生无意义的空版本；切换生效版本不会创建新的 DocumentVersion。',
  '失败版本不会自动重试，需要人工确认原因后重新上传文件或切换回上一个可用版本，历史版本的配置快照始终保留以便追溯。',
];

/** FNV-1a：让同一个版本每次渲染得到稳定的示例数据。 */
function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 异步分页获取版本 + retrieval 下的 Chunk（示例数据）。 */
export async function listVersionChunks(params: {
  documentVersionId: string;
  retrievalType: string;
  page: number;
  pageSize: number;
}): Promise<ChunkListResult> {
  const { documentVersionId, retrievalType, page, pageSize } = params;
  const seed = hashString(`${documentVersionId}:${retrievalType}`);
  const total = (seed % 37) + 6;

  const items = Array.from(
    { length: pageSize },
    (_, offset): ChunkItem | null => {
      const index = (page - 1) * pageSize + offset;
      if (index >= total) return null;
      const sample = CHUNK_SAMPLES[(seed + index) % CHUNK_SAMPLES.length];
      return {
        chunk_index: index,
        content: `#${index} ${sample}`,
        token_count: 180 + ((seed + index * 7) % 220),
        char_count: 420 + ((seed + index * 11) % 480),
        metadata: {
          retrieval_type: retrievalType,
          start_index: index * 512,
          end_index: index * 512 + 420,
          source: `v-seed-${(seed % 97) + 1}`,
        },
      };
    },
  ).filter((item): item is ChunkItem => item !== null);

  return { items, total };
}
