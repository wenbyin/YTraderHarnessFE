// src/components/SchemaForm/schema.test.ts
//
// 纯函数层单测。
//
// ⚠️ 写这批测试的原因：这一层**以前完全没有测试**（原先的 schemaForm.ts 只被 UI 间接覆盖），
// 所以「数组默认值」那一支漏到 2026-10-05 才被用户发现 —— 而那天三项检查全绿。
// 这正是「边界要在纯函数上钉死，别指望组件测试能等到」那条规矩的实例。
//
// 断言的形态全部照抄 pydantic v2 model_json_schema() 的真实输出，
// 不是拍脑袋写的简化版（比如 default_factory=list **不产出 default 键**这一点很关键）。

import { describe, expect, it } from 'vitest';
import {
  baseType,
  buildDefaults,
  deref,
  effective,
  isDict,
  isNullable,
  parseConfigText,
  reconcile,
  sanitize,
  typeName,
} from './schema';

describe('buildDefaults', () => {
  it('pydantic 的 default_factory=list 不产出 default 键，也要给 []', () => {
    // AuthConfig.require_roles 的真实形态：没有 default 键
    const schema = {
      properties: {
        require_roles: {
          type: 'array',
          items: { type: 'string' },
          title: '要求的角色',
        },
      },
    };
    const cfg = buildDefaults(schema);
    expect(Array.isArray(cfg.require_roles)).toBe(true);
    expect(cfg.require_roles).toEqual([]);
    // 明确排除老实现那个「兜底成空字符串」的行为
    expect(cfg.require_roles).not.toBe('');
  });

  it('各类型的兜底值：串 / 布尔 / 数字（含 minimum）/ 数组', () => {
    const schema = {
      properties: {
        s: { type: 'string' },
        b: { type: 'boolean' },
        n: { type: 'integer' },
        f: { type: 'number', minimum: 1.5 },
        a: { type: 'array', items: { type: 'string' } },
      },
    };
    expect(buildDefaults(schema)).toEqual({
      s: '',
      b: false,
      n: 0,
      f: 1.5,
      a: [],
    });
  });

  it('可空标量默认 null；非可空默认空串', () => {
    const schema = {
      properties: {
        nullable: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        plain: { type: 'string' },
      },
    };
    expect(buildDefaults(schema)).toEqual({ nullable: null, plain: '' });
  });

  it('嵌套 object 递归造默认值（不是给个 {} 了事）', () => {
    const schema = {
      properties: {
        ocr: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            langs: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    };
    expect(buildDefaults(schema)).toEqual({
      ocr: { enabled: false, langs: [] },
    });
  });

  it('显式 default 优先；可空字段的 default: null 也算显式', () => {
    const schema = {
      properties: {
        retry: { type: 'integer', default: 3 },
        tags: { type: 'array', items: { type: 'string' }, default: ['a'] },
        maybe: { anyOf: [{ type: 'string' }, { type: 'null' }], default: null },
      },
    };
    expect(buildDefaults(schema)).toEqual({
      retry: 3,
      tags: ['a'],
      maybe: null,
    });
  });

  it('$ref 指向的子模型也会递归展开', () => {
    const schema = {
      $defs: {
        OcrCfg: {
          type: 'object',
          properties: { enabled: { type: 'boolean' } },
        },
      },
      properties: { ocr: { $ref: '#/$defs/OcrCfg' } },
    };
    expect(buildDefaults(schema)).toEqual({ ocr: { enabled: false } });
  });
});

describe('deref / effective / baseType', () => {
  const root = {
    $defs: {
      OcrCfg: {
        type: 'object',
        description: 'OCR 参数',
        properties: { enabled: { type: 'boolean' } },
      },
    },
  };

  it('$ref 解到 $defs，并回填 _refName 供 UI 显示', () => {
    const p = deref({ $ref: '#/$defs/OcrCfg' }, root);
    expect(p.type).toBe('object');
    expect(p._refName).toBe('OcrCfg');
    expect(p.properties?.enabled).toBeTruthy();
  });

  it('在 $ref 上挂 title/description 会输出 allOf[$ref]，外层要覆盖内层', () => {
    const p = deref(
      {
        allOf: [{ $ref: '#/$defs/OcrCfg' }],
        title: '识别设置',
        description: '外层说明',
      },
      root,
    );
    expect(p.title).toBe('识别设置');
    expect(p.description).toBe('外层说明');
    // 内层结构没丢
    expect(p.properties?.enabled).toBeTruthy();
  });

  it('anyOf[T, null] 的非 null 分支才是「有效子 schema」', () => {
    const p = deref(
      { anyOf: [{ $ref: '#/$defs/OcrCfg' }, { type: 'null' }] },
      root,
    );
    expect(baseType(p)).toBe('object');
    expect(effective(p).properties?.enabled).toBeTruthy();
    expect(isNullable(p)).toBe(true);
  });

  it('baseType 认 anyOf / 联合数组 / 裸 properties', () => {
    expect(baseType({ anyOf: [{ type: 'boolean' }, { type: 'null' }] })).toBe(
      'boolean',
    );
    expect(baseType({ type: ['string', 'null'] })).toBe('string');
    expect(baseType({ properties: {} })).toBe('object');
    // 什么都认不出来时兜底 string（宁可给个能输入的，也别崩）
    expect(baseType({})).toBe('string');
  });

  it('typeName 从联合数组里挑非 null 的那个', () => {
    expect(typeName(['integer', 'null'])).toBe('integer');
    expect(typeName('boolean')).toBe('boolean');
    expect(typeName(undefined)).toBeUndefined();
  });

  it('isDict 只认「有 additionalProperties、没有 properties」的 object', () => {
    expect(
      isDict({ type: 'object', additionalProperties: { type: 'string' } }),
    ).toBe(true);
    expect(
      isDict({
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: { type: 'string' },
      }),
    ).toBe(false);
    expect(isDict({ type: 'object' })).toBe(false);
  });
});

describe('reconcile', () => {
  const schema = {
    properties: {
      require_roles: { type: 'array', items: { type: 'string' } },
      require_group: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      retry: { type: 'integer' },
    },
  };

  it('类型不符的旧值被丢弃，并补上默认值', () => {
    // 旧值把数组写成了字符串（就是老 UI 造出来的脏数据）
    const { value, dropped } = reconcile({ require_roles: 'admin' }, schema);
    expect(dropped).toContain('require_roles');
    expect(value.require_roles).toEqual([]);
  });

  it('类型相符的旧值保留', () => {
    const { value, dropped } = reconcile(
      { require_roles: ['a', 'b'], retry: 5 },
      schema,
    );
    expect(dropped).toEqual([]);
    expect(value).toEqual({
      require_roles: ['a', 'b'],
      require_group: null,
      retry: 5,
    });
  });

  it('可空字段的 null 是合法值，不算类型不符', () => {
    const { value, dropped } = reconcile({ require_group: null }, schema);
    expect(dropped).toEqual([]);
    expect(value.require_group).toBeNull();
  });

  it('schema 里没有的键进 dropped，不进 value', () => {
    const { value, dropped } = reconcile({ gone: 1 }, schema);
    expect(dropped).toContain('gone');
    expect('gone' in value).toBe(false);
  });
});

describe('sanitize', () => {
  it('数字被清空时回落到 default / minimum，避免写出 null', () => {
    const schema = {
      properties: {
        retry: { type: 'integer', default: 3 },
        limit: { type: 'integer', minimum: 1 },
      },
    };
    const v = sanitize({ retry: null, limit: undefined }, schema);
    expect(v.retry).toBe(3);
    expect(v.limit).toBe(1);
  });

  it('非空数字原样保留', () => {
    const schema = { properties: { retry: { type: 'integer' } } };
    expect(sanitize({ retry: 7 }, schema).retry).toBe(7);
  });
});

describe('parseConfigText', () => {
  it('空串 / 纯空白视为 {}', () => {
    expect(parseConfigText('')).toEqual({});
    expect(parseConfigText('   ')).toEqual({});
  });

  it('非法 JSON 返回 null（调用方据此提示）', () => {
    expect(parseConfigText('{oops')).toBeNull();
  });

  it('数组顶层不算对象，返回 null', () => {
    expect(parseConfigText('[1,2]')).toBeNull();
  });

  it('正常对象解析出来', () => {
    expect(parseConfigText('{"a":1}')).toEqual({ a: 1 });
  });
});
