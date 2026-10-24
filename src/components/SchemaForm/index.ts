// src/components/SchemaForm/index.ts
// 公共 JSON Schema 表单模块的出口。
//
// 消费方一律从这里 import：
//   import { SchemaForm } from '@/components/SchemaForm';
//   import { buildDefaults, type JsonSchema } from '@/components/SchemaForm';

export {
  ArrayEditor,
  DictEditor,
  ObjectField,
  SchemaField,
  type SchemaFieldProps,
  SchemaForm,
  type SchemaFormProps,
} from './SchemaForm';
export {
  baseType,
  buildDefaults,
  type ConfigObject,
  deref,
  effective,
  isDict,
  isNullable,
  type JsonSchema,
  type JsonSchemaProp,
  MAX_DEPTH,
  parseConfigText,
  reconcile,
  sanitize,
  typeName,
} from './schema';
export { useStyles } from './style';
