// Licensed to the Software Freedom Conservancy (SFC) under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  The SFC licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

/**
 * Project the normalized BiDi AST + command/event model into one flat,
 * binding-neutral schema for the generated Ruby / Java / Python clients.
 * The normalizer has already removed the awkward CDDL shapes, so this is a
 * straight mapping into a small vocabulary:
 *
 *   type node:  { kind: 'record', fields: [field] }
 *             | { kind: 'enum',   values: [string] }
 *             | { kind: 'union',  variants: [ref], oneOf?: [string] }
 *             | { kind: 'alias',  type }
 *   field:      { name, wire, required, type }
 *   type ref:   { primitive } | { const } | { ref } | { enum } | { list } | { map, extensible? } | { union }
 */

import { normalizeAst } from './normalize_bidi_ast.mjs'

// Prose-only "exactly one of" constraints the CDDL cannot express. In practice
// every mutual-exclusivity case in the spec is a CDDL choice (→ a `union` here,
// e.g. session.unsubscribe), and a scan of all spec comments finds no prose-only
// constraint — so this is empty. Keyed by type name; validated by checkSchema().
const ONE_OF = {}

// Events that parse into the AST but are not wired into the model because the
// upstream bluetooth spec does not fully define them. This is an external spec
// issue, not a Selenium/buildModel bug, and is intentionally not fixed here.
// Allowlisted so it does not fail the build; checkCompleteness() flags an entry
// as stale once it becomes emitted (e.g. after the spec is fixed upstream), so
// this list cannot silently rot.
const KNOWN_INCOMPLETE = new Set(['bluetooth.characteristicEventGenerated', 'bluetooth.descriptorEventGenerated'])

const PRIMITIVES = {
  text: 'string',
  tstr: 'string',
  uint: 'integer',
  int: 'integer',
  nint: 'integer',
  float: 'number',
  bool: 'boolean',
  null: 'null',
}
// CDDL prelude types surface as group refs but are builtins, not defined types.
const PRELUDE = {
  number: 'number',
  any: 'any',
  bytes: 'string',
  bstr: 'string',
  nil: 'null',
  tdate: 'string',
  uri: 'string',
}

const typeList = (t) => (Array.isArray(t) ? t : t === undefined || t === null ? [] : [t])
const isLiteral = (e) => e && typeof e === 'object' && e.Type === 'literal'
const isRef = (e) => e && typeof e === 'object' && e.Type === 'group' && typeof e.Value === 'string'

function projectRef(type) {
  const all = typeList(type)
  const entries = all.filter((e) => e !== 'null')
  const node =
    entries.length > 1
      ? entries.every(isLiteral)
        ? { enum: entries.map((e) => e.Value) }
        : { union: entries.map(projectEntry) }
      : projectEntry(entries[0])
  if (entries.length < all.length) node.nullable = true // a `null` alternative means the value may be null
  return node
}

function projectEntry(e) {
  if (typeof e === 'string') return { primitive: PRIMITIVES[e] ?? e }
  if (!e || typeof e !== 'object') return { primitive: 'unknown' }
  if (e.Type === 'literal') return { const: e.Value }
  if (e.Type === 'group' && e.Value) return e.Value in PRELUDE ? { primitive: PRELUDE[e.Value] } : { ref: e.Value }
  if (e.Type === 'group' && Array.isArray(e.Properties))
    return {
      record: e.Properties.flat()
        .filter((p) => p?.Name)
        .map(projectField),
    }
  if (e.Type === 'array') return { list: projectRef(e.Values?.[0]?.Type) }
  if (e.Type === 'map') return { map: projectRef(e.ValueType ?? e.Values?.[0]?.Type), extensible: true }
  return { primitive: PRIMITIVES[e.Type] ?? 'unknown' }
}

function projectField(prop) {
  return { name: prop.Name, wire: prop.Name, required: (prop.Occurrence?.n ?? 1) >= 1, type: projectRef(prop.Type) }
}

function projectType(def) {
  if (def.Type === 'variable') {
    const pt = def.PropertyType ?? []
    if (pt.length && pt.every(isLiteral)) return { kind: 'enum', values: pt.map((e) => e.Value) }
    if (pt.length > 1 && pt.every(isRef)) {
      const node = { kind: 'union', variants: pt.map((e) => e.Value) }
      if (ONE_OF[def.Name]) node.oneOf = ONE_OF[def.Name]
      return node
    }
    return { kind: 'alias', type: projectRef(def.PropertyType) }
  }
  return projectRecord(def)
}

/**
 * Project a CDDL group into a record. A property with `Occurrence.m === null` is
 * an unbounded entry (`* key => value`), not a scalar field: `* text => any` marks
 * the record extensible, `* text => T` becomes a typed map, and an unbounded group
 * spread is folded in. Everything else is a normal field.
 */
function projectRecord(def) {
  const record = { kind: 'record', fields: [] }
  for (const prop of (def.Properties ?? []).flat()) {
    if (!prop || typeof prop !== 'object') continue
    // `m === null` is overloaded in this parser: a key-typed entry is a map
    // (`* text => value`); an anonymous entry is a structural spread; everything
    // else is just an optional field (the `?` quantifier). Only the first two
    // are not real fields.
    if (prop.Occurrence?.m === null && (!prop.Name || prop.Name in PRIMITIVES || prop.Name in PRELUDE)) {
      if (prop.Name in PRIMITIVES || prop.Name in PRELUDE) {
        const value = projectRef(prop.Type)
        if (value.primitive === 'any') record.extensible = true
        else record.map = value
      }
      continue
    }
    if (prop.Name) record.fields.push(projectField(prop))
  }
  return record
}

const typeRef = (name) => (name ? { ref: name } : null)

/** Build the flat schema from the raw AST and the existing command/event model. */
export function projectSchema(ast, model) {
  const types = {}
  for (const def of normalizeAst(ast)) if (def?.Name) types[def.Name] = projectType(def)

  const commands = []
  const events = []
  for (const [domain, entry] of Object.entries(model)) {
    for (const c of entry.commands ?? [])
      commands.push({ domain, method: c.method, name: c.name, params: typeRef(c.params), result: typeRef(c.result) })
    for (const e of entry.events ?? [])
      events.push({ domain, method: e.method, name: e.name, params: typeRef(e.params) })
  }

  return { schemaVersion: 1, commands, events, types }
}

/** Fail-closed validation: every ref resolves, and every ONE_OF entry is real. */
export function checkSchema(schema) {
  const errors = []
  const has = (name) => Object.hasOwn(schema.types, name)
  const refsIn = (node) =>
    !node
      ? []
      : node.ref
        ? [node.ref]
        : node.list
          ? refsIn(node.list)
          : node.map
            ? refsIn(node.map)
            : node.union
              ? node.union.flatMap(refsIn)
              : node.record
                ? node.record.flatMap((f) => refsIn(f.type))
                : []

  for (const c of [...schema.commands, ...schema.events]) {
    for (const r of [...refsIn(c.params), ...refsIn(c.result ?? null)])
      if (!has(r)) errors.push(`${c.method}: unresolved type ${r}`)
  }
  for (const [name, node] of Object.entries(schema.types)) {
    if (node.kind === 'record')
      for (const f of node.fields)
        for (const r of refsIn(f.type)) if (!has(r)) errors.push(`${name}.${f.name}: unresolved type ${r}`)
    if (node.kind === 'union')
      for (const v of node.variants) if (!has(v)) errors.push(`${name}: unresolved variant ${v}`)
    for (const field of node.oneOf ?? [])
      if (node.kind === 'union' ? false : !node.fields?.some((f) => f.name === field))
        errors.push(`oneOf(${name}): no such field ${field}`)
  }
  for (const name of Object.keys(ONE_OF)) if (!has(name)) errors.push(`oneOf: unknown type ${name}`)
  return errors
}

// ============================================================
// CLI: raw ast + model → flat schema (validated)
//   node project_bidi_schema.mjs --ast <ast.json> --model <model.json> --dump-schema <out.json>
// ============================================================

async function main() {
  const { parseArgs } = await import('node:util')
  const { readFileSync, writeFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')

  // Under Bazel the js_binary wrapper chdir's to BAZEL_BINDIR, but $(location)
  // inputs are execroot-relative and already carry that prefix — strip it so the
  // path is not doubled. Mirrors resolveInputPath() in generate_bidi.mjs.
  const resolveInput = (p) => {
    if (!process.env.BAZEL_BINDIR) return resolve(p)
    const prefix = process.env.BAZEL_BINDIR.replaceAll('\\', '/') + '/'
    const norm = p.replaceAll('\\', '/')
    return resolve(norm.startsWith(prefix) ? norm.slice(prefix.length) : norm)
  }

  const { values: args } = parseArgs({
    options: { ast: { type: 'string' }, model: { type: 'string' }, 'dump-schema': { type: 'string' } },
  })
  if (!args.ast || !args.model || !args['dump-schema']) {
    console.error('Usage: project_bidi_schema.mjs --ast <ast.json> --model <model.json> --dump-schema <out.json>')
    process.exit(1)
  }

  const ast = JSON.parse(readFileSync(resolveInput(args.ast), 'utf8'))
  const model = JSON.parse(readFileSync(resolveInput(args.model), 'utf8'))
  const schema = projectSchema(ast, model)

  // Generation is the gate: a broken or incomplete schema fails the build.
  const errors = [...checkSchema(schema), ...checkCompleteness(ast, schema)]
  if (errors.length) {
    console.error('BiDi schema validation failed:')
    errors.forEach((e) => console.error(`  ${e}`))
    process.exit(1)
  }

  writeFileSync(resolve(args['dump-schema']), JSON.stringify(schema, null, 2) + '\n', 'utf8')
  console.log(
    `  ${schema.commands.length} commands, ${schema.events.length} events, ${Object.keys(schema.types).length} types → ${args['dump-schema']}`,
  )
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

/**
 * Independent completeness check: re-derive every command/event method straight
 * from the raw AST (a leaf def carries a literal `method` property) and assert it
 * survived into the schema. This compares input to output without trusting the
 * generator, so a dropped command/event fails the build even if generation and
 * its own checkSchema agree. Run as a Bazel test over committed fixtures.
 */
export function checkCompleteness(rawAst, schema) {
  const emitted = new Set([...schema.commands, ...schema.events].map((c) => c.method))
  const errors = []
  for (const def of rawAst) {
    const methodProp = (def.Properties ?? []).flat().find((p) => p?.Name === 'method')
    const literal = methodProp && (Array.isArray(methodProp.Type) ? methodProp.Type[0] : methodProp.Type)
    if (literal?.Type !== 'literal') continue
    if (!emitted.has(literal.Value) && !KNOWN_INCOMPLETE.has(literal.Value))
      errors.push(`dropped from schema: ${literal.Value}`)
  }
  // Self-cleaning: if a known-incomplete method is now emitted, the entry is
  // stale and must be removed — so the allowlist cannot silently rot.
  for (const known of KNOWN_INCOMPLETE) {
    if (emitted.has(known)) errors.push(`stale KNOWN_INCOMPLETE entry (now emitted, remove it): ${known}`)
  }
  return errors
}
