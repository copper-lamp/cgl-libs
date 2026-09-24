// 极简 JSON Schema 校验器（无第三方依赖）。
//
// 契约依据 docs/cgl-libs.md 2.8.2 第 4 步：`node tools/validate.mjs --schema` 必须对
// modules/*.json 走 schema/module-shard.schema.json、对 mcbe/manifest.json 走
// schema/mcbe-manifest.schema.json。
//
// 为什么自研而不引 ajv：2.1 / 任务要求 tools 不得有第三方运行时依赖（CI 也不允许
// npm install）。因此这里实现 schema/ 目录实际用到的关键字子集，遇到未支持的关键字
// 一律**明确报错**而不是静默跳过——静默跳过等于假装校验通过。
//
// 支持的关键字（覆盖 schema/*.schema.json 全部用法）：
//   $schema / $id / title / description / $defs / $ref / definitions
//   type / enum / const / required / properties / additionalProperties
//   propertyNames / minProperties / maxProperties
//   items / minItems / maxItems / uniqueItems
//   minimum / maximum / exclusiveMinimum / exclusiveMaximum / multipleOf
//   minLength / maxLength / pattern / format(date-time|uri)
//   allOf / anyOf / oneOf / not
//
// 未支持（会抛 SchemaUnsupportedError）：if/then/else、dependentRequired、
// dependentSchemas、patternProperties、unevaluatedProperties、prefixItems、contains。

const SUPPORTED_KEYWORDS = new Set([
  '$schema', '$id', '$defs', 'definitions', '$ref', '$comment',
  'title', 'description', 'default', 'examples', 'deprecated',
  'type', 'enum', 'const', 'required', 'properties', 'additionalProperties',
  'propertyNames', 'minProperties', 'maxProperties',
  'items', 'minItems', 'maxItems', 'uniqueItems',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'format',
  'allOf', 'anyOf', 'oneOf', 'not',
]);

const KNOWN_UNSUPPORTED = new Set([
  'if', 'then', 'else', 'dependentRequired', 'dependentSchemas', 'patternProperties',
  'unevaluatedProperties', 'unevaluatedItems', 'prefixItems', 'contains',
  'minContains', 'maxContains', 'propertyDependencies',
]);

export class SchemaUnsupportedError extends Error {
  constructor(keyword, pointer) {
    super(`JSON Schema 关键字 "${keyword}" 尚未在本校验器中实现（位置 ${pointer}）。请扩展 tools/lib/json-schema.mjs 或改写在用 schema，不可静默跳过。`);
    this.name = 'SchemaUnsupportedError';
  }
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value; // 'number' | 'string' | 'boolean' | 'object'
}

function typeMatches(value, expected) {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  return actual === expected;
}

/** 深度相等（用于 const / enum / uniqueItems）。 */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const URI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function checkFormat(value, format) {
  switch (format) {
    case 'date-time':
      if (!RFC3339_RE.test(value)) return '不是 RFC3339 日期时间（示例 2026-09-14T03:12:40Z）';
      if (Number.isNaN(Date.parse(value))) return '不是可解析的日期时间';
      return null;
    case 'uri':
    case 'uri-reference':
      if (!URI_RE.test(value)) return '不是合法的 URI（缺少 scheme）';
      return null;
    case 'email':
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return '不是合法的邮箱地址';
      return null;
    default:
      // 未知 format 依 JSON Schema 规范应当作注解忽略，不影响校验结论。
      return null;
  }
}

function escapePointerToken(token) {
  return String(token).replace(/~/g, '~0').replace(/\//g, '~1');
}

function joinPointer(pointer, token, kind) {
  if (kind === 'property') return `${pointer}/${escapePointerToken(token)}`;
  if (kind === 'index') return `${pointer}/${token}`;
  return pointer;
}

/**
 * 编译一个 schema 的第二版实现入口。
 *
 * 之所以每次调用都重新解析 $ref（而不是缓存解析结果对象图）：
 * 这些 schema 体量极小（最大 362 行），解析成本可忽略，而把解析结果做成对象图
 * 会引入循环引用与复制语义的复杂度。可读性与正确性优先。
 */
export class SchemaValidator {
  constructor(rootSchema, { sourceName = '<inline>' } = {}) {
    this.root = rootSchema;
    this.sourceName = sourceName;
    this.assertSupported(rootSchema, '#');
  }

  /** 递归检查所有关键字是否已实现，避免"未知关键字被忽略"的假校验。 */
  assertSupported(node, pointer) {
    if (Array.isArray(node)) {
      this.assertSupported(node, pointer);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (KNOWN_UNSUPPORTED.has(key)) throw new SchemaUnsupportedError(key, pointer);
      if (pointer === '#' && key === '$defs') {
        for (const [name, sub] of Object.entries(value)) this.assertSupported(sub, `#/$defs/${name}`);
        continue;
      }
      if (pointer === '#' && key === 'definitions') {
        for (const [name, sub] of Object.entries(value)) this.assertSupported(sub, `#/definitions/${name}`);
        continue;
      }
      if (key === 'properties' || key === 'propertyNames' || key === 'additionalProperties' || key === 'items') {
        if (key === 'properties') {
          for (const [name, sub] of Object.entries(value)) this.assertSupported(sub, `${pointer}/properties/${name}`);
        } else if (key === 'items' && Array.isArray(value)) {
          for (const [i, sub] of value.entries()) this.assertSupported(sub, `${pointer}/items/${i}`);
        } else {
          this.assertSupported(value, `${pointer}/${key}`);
        }
        continue;
      }
      if (['allOf', 'anyOf', 'oneOf'].includes(key)) {
        for (const [i, sub] of value.entries()) this.assertSupported(sub, `${pointer}/${key}/${i}`);
        continue;
      }
      if (key === 'not') {
        this.assertSupported(value, `${pointer}/not`);
        continue;
      }
      if (!SUPPORTED_KEYWORDS.has(key)) {
        // 未知关键字：若形如 JSON Schema 关键字（不含点号的短标识符）则视为不支持而报错。
        if (/^[a-zA-Z$][a-zA-Z0-9$]*$/.test(key)) throw new SchemaUnsupportedError(key, pointer);
      }
    }
  }

  /**
   * 解析 $ref。
   *
   * 关键点：JSON Schema 的片段引用（`#/$defs/x`）是相对**当前 schema 资源**的根，
   * 而不是相对最外层文档的根。module-shard.schema.json 通过外部 $id 引用
   * module-entry.schema.json 后，条目内部的 `#/$defs/summaryText` 必须在
   * module-entry 这份资源里查，否则会去 shard 的 $defs 里找而失败（实测踩过）。
   *
   * 因此 walk 时把"当前资源根"一并传递，这里优先在当前资源内解析。
   */
  resolveRef(ref, currentRoot) {
    if (typeof ref !== 'string') throw new Error(`$ref 必须是字符串，实际为 ${JSON.stringify(ref)}`);
    if (ref.startsWith('#')) {
      const base = currentRoot ?? this.root;
      const tokens = ref.slice(1).split('/').filter((t) => t !== '');
      let node = base;
      for (const raw of tokens) {
        const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
        if (node === null || typeof node !== 'object' || !(token in node)) {
          throw new Error(`无法解析 $ref "${ref}"：在 ${token} 处中断`);
        }
        node = node[token];
      }
      return { schema: node, root: base };
    }
    // 外部 $ref（本仓库 schema 用绝对 $id 引用 module-entry.schema.json）：
    // 由调用方通过 externalResolver 提供，返回 undefined 表示无法解析。
    if (this.externalResolver) {
      const resolved = this.externalResolver(ref);
      // 换资源后，片段引用的基准根也随之切换为该资源的根。
      if (resolved) return { schema: resolved, root: resolved };
    }
    throw new Error(
      `无法解析外部 $ref "${ref}"。请确认该 $id 对应的 schema 文件存在于 schema/ 目录。`,
    );
  }

  setExternalResolver(fn) {
    this.externalResolver = fn;
    return this;
  }

  validate(data) {
    const errors = [];
    this.walk(data, this.root, '#', errors, this.root);
    return errors;
  }

  // 校验单个节点，把所有违反项追加进 errors。不做短路，以便一次性给出全部问题。
  // currentRoot：当前 $ref 片段的解析基准（见 resolveRef 注释）。
  walk(data, schema, pointer, errors, currentRoot) {
    if (schema === true || schema === undefined) return;
    if (schema === false) {
      errors.push({ pointer, message: 'schema 为 false，任何值都不允许' });
      return;
    }
    if (typeof schema !== 'object' || schema === null) {
      throw new Error(`schema 节点必须是对象或布尔值，位置 ${pointer}`);
    }

    if (schema.$ref !== undefined) {
      const { schema: target, root } = this.resolveRef(schema.$ref, currentRoot);
      this.walk(data, target, pointer, errors, root);
      // 依 draft 2020-12，$ref 与其它关键字可并存；继续走下面的兄弟关键字。
    }

    if (schema.type !== undefined) {
      const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!expected.some((t) => typeMatches(data, t))) {
        errors.push({ pointer, message: `类型不符：期望 ${expected.join(' | ')}，实际 ${typeOf(data)}` });
        return; // 类型不符后继续校验子关键字会产出大量噪声
      }
    }

    if (schema.const !== undefined && !deepEqual(data, schema.const)) {
      errors.push({ pointer, message: `必须是常量 ${JSON.stringify(schema.const)}，实际 ${JSON.stringify(data)}` });
    }

    if (Array.isArray(schema.enum)) {
      if (!schema.enum.some((candidate) => deepEqual(data, candidate))) {
        errors.push({
          pointer,
          message: `不在允许枚举内：期望 {${schema.enum.map((v) => JSON.stringify(v)).join(', ')}}，实际 ${JSON.stringify(data)}`,
        });
      }
    }

    if (typeof data === 'string') {
      this.walkStringKeywords(data, schema, pointer, errors);
    } else if (typeof data === 'number') {
      this.walkNumberKeywords(data, schema, pointer, errors);
    } else if (Array.isArray(data)) {
      this.walkArrayKeywords(data, schema, pointer, errors, currentRoot);
    } else if (data !== null && typeof data === 'object') {
      this.walkObjectKeywords(data, schema, pointer, errors, currentRoot);
    }

    for (const key of ['allOf', 'anyOf', 'oneOf']) {
      if (!Array.isArray(schema[key])) continue;
      const branches = schema[key];
      if (key === 'allOf') {
        for (const [i, sub] of branches.entries()) this.walk(data, sub, pointer, errors, currentRoot);
        continue;
      }
      const branchErrors = branches.map((sub) => {
        const local = [];
        this.walk(data, sub, pointer, local, currentRoot);
        return local;
      });
      const passing = branchErrors.filter((e) => e.length === 0).length;
      if (key === 'anyOf' && passing === 0) {
        const detail = branchErrors
          .map((errs, i) => `分支 ${i}: ${errs.map((e) => e.message).join('; ')}`)
          .join(' | ');
        errors.push({ pointer, message: `不满足 anyOf 任一分支：${detail}` });
      }
      if (key === 'oneOf' && passing !== 1) {
        errors.push({ pointer, message: `oneOf 要求恰好命中 1 个分支，实际命中 ${passing} 个` });
      }
    }

    if (schema.not !== undefined) {
      const local = [];
      this.walk(data, schema.not, pointer, local, currentRoot);
      if (local.length === 0) {
        errors.push({ pointer, message: '命中了 not 分支（该值被显式禁止）' });
      }
    }
  }

  walkStringKeywords(value, schema, pointer, errors) {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) {
      errors.push({ pointer, message: `长度不足：最短 ${schema.minLength}，实际 ${[...value].length}` });
    }
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) {
      errors.push({ pointer, message: `长度超限：最长 ${schema.maxLength}，实际 ${[...value].length}` });
    }
    if (schema.pattern !== undefined) {
      const re = new RegExp(schema.pattern);
      if (!re.test(value)) {
        errors.push({ pointer, message: `不匹配正则 ${schema.pattern}：实际 ${JSON.stringify(value)}` });
      }
    }
    if (schema.format !== undefined) {
      const problem = checkFormat(value, schema.format);
      if (problem) errors.push({ pointer, message: `格式 ${schema.format} 校验失败：${problem}` });
    }
  }

  walkNumberKeywords(value, schema, pointer, errors) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ pointer, message: `小于下界：最小 ${schema.minimum}，实际 ${value}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ pointer, message: `大于上界：最大 ${schema.maximum}，实际 ${value}` });
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      errors.push({ pointer, message: `必须大于 ${schema.exclusiveMinimum}，实际 ${value}` });
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      errors.push({ pointer, message: `必须小于 ${schema.exclusiveMaximum}，实际 ${value}` });
    }
    if (schema.multipleOf !== undefined) {
      const q = value / schema.multipleOf;
      if (!Number.isInteger(q)) {
        errors.push({ pointer, message: `必须是 ${schema.multipleOf} 的整数倍，实际 ${value}` });
      }
    }
  }

  walkArrayKeywords(value, schema, pointer, errors, currentRoot) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ pointer, message: `元素不足：最少 ${schema.minItems}，实际 ${value.length}` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ pointer, message: `元素超限：最多 ${schema.maxItems}，实际 ${value.length}` });
    }
    if (schema.uniqueItems === true) {
      for (let i = 0; i < value.length; i += 1) {
        for (let j = i + 1; j < value.length; j += 1) {
          if (deepEqual(value[i], value[j])) {
            errors.push({ pointer: joinPointer(pointer, i, 'index'), message: `与下标 ${j} 的元素重复（uniqueItems）` });
          }
        }
      }
    }
    if (schema.items !== undefined) {
      if (Array.isArray(schema.items)) {
        for (const [i, sub] of schema.items.entries()) {
          if (i < value.length) this.walk(value[i], sub, joinPointer(pointer, i, 'index'), errors, currentRoot);
        }
      } else {
        for (const [i, item] of value.entries()) {
          this.walk(item, schema.items, joinPointer(pointer, i, 'index'), errors, currentRoot);
        }
      }
    }
  }

  walkObjectKeywords(value, schema, pointer, errors, currentRoot) {
    const keys = Object.keys(value);

    if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
      errors.push({ pointer, message: `属性不足：最少 ${schema.minProperties}，实际 ${keys.length}` });
    }
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
      errors.push({ pointer, message: `属性超限：最多 ${schema.maxProperties}，实际 ${keys.length}` });
    }

    if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, name)) {
          errors.push({ pointer, message: `缺少必填字段 "${name}"` });
        }
      }
    }

    if (schema.propertyNames !== undefined) {
      for (const key of keys) {
        this.walk(key, schema.propertyNames, joinPointer(pointer, key, 'property'), errors, currentRoot);
      }
    }

    const props = schema.properties || {};
    for (const key of keys) {
      const childPointer = joinPointer(pointer, key, 'property');
      if (Object.prototype.hasOwnProperty.call(props, key)) {
        this.walk(value[key], props[key], childPointer, errors, currentRoot);
        continue;
      }
      if (schema.additionalProperties === false) {
        errors.push({ pointer: childPointer, message: `不允许的额外字段 "${key}"（additionalProperties: false）` });
        continue;
      }
      if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
        this.walk(value[key], schema.additionalProperties, childPointer, errors, currentRoot);
      }
    }
  }
}

/** 便捷入口。 */
export function validateAgainstSchema(data, schema, options = {}) {
  const validator = new SchemaValidator(schema, options);
  if (options.externalResolver) validator.setExternalResolver(options.externalResolver);
  return validator.validate(data);
}

/** 把 errors 渲染为 "位置: 说明" 列表。 */
export function formatSchemaErrors(errors) {
  return errors.map((e) => `${e.pointer === '#' ? '(根)' : e.pointer}: ${e.message}`);
}
