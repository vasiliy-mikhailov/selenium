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

// Runnable standalone: `node --test project_bidi_schema_test.mjs`.
// In Bazel this becomes a mocha/js_test over the committed fixtures below; the
// completeness test is the "compare input to output independent of generation"
// gate — it re-derives expected methods from the raw AST, not from the model.

// Mocha test; `describe`/`it` are mocha globals.
import assert from 'node:assert/strict'
import { projectSchema, checkSchema, checkCompleteness } from './project_bidi_schema.mjs'

const lit = (v) => ({ Type: 'literal', Value: v, Unwrapped: false })
const ref = (v) => ({ Type: 'group', Value: v, Unwrapped: false })
const field = (name, type, occ = { n: 1, m: 1 }) => ({ Name: name, Occurrence: occ, Type: type, Comments: [] })
const group = (name, props) => ({ Type: 'group', Name: name, Properties: props, IsChoiceAddition: false, Comments: [] })
const leaf = (cddlName, method, paramsRef) =>
  group(cddlName, [field('method', [lit(method)]), field('params', [ref(paramsRef)])])

// A tiny but representative AST + model.
const AST = [
  leaf('network.SetCacheBehavior', 'network.setCacheBehavior', 'network.SetCacheBehaviorParameters'),
  group('network.SetCacheBehaviorParameters', [field('cacheBehavior', [lit('default'), lit('bypass')])]),
  group('session.Caps', [field('extra', { Type: 'group', Name: '', Properties: [field('webSocketUrl', ['bool'])] })]),
  group('x.OpenMap', [field('text', ['any'], { n: 0, m: null })]),
]
const MODEL = {
  network: {
    commands: [
      {
        method: 'network.setCacheBehavior',
        name: 'setCacheBehavior',
        params: 'network.SetCacheBehaviorParameters',
        result: null,
      },
    ],
    events: [],
  },
}

describe('projectSchema', () => {
  const schema = projectSchema(AST, MODEL)

  it('emits a clean enum for an inline string-literal union', () => {
    assert.deepEqual(schema.types['network.SetCacheBehaviorParametersCacheBehavior'], {
      kind: 'enum',
      values: ['default', 'bypass'],
    })
    assert.deepEqual(schema.types['network.SetCacheBehaviorParameters'].fields[0].type, {
      ref: 'network.SetCacheBehaviorParametersCacheBehavior',
    })
  })

  it('hoists an inline record so the field is a plain ref (no inline records)', () => {
    assert.deepEqual(schema.types['session.Caps'].fields[0].type, { ref: 'session.CapsExtra' })
    assert.ok(schema.types['session.CapsExtra'], 'inline record was hoisted to a named type')
  })

  it('marks `* text => any` extensible instead of emitting a phantom field', () => {
    const open = schema.types['x.OpenMap']
    assert.equal(open.extensible, true)
    assert.equal(open.fields.length, 0)
  })

  it('passes both validators on a well-formed schema', () => {
    assert.deepEqual(checkSchema(schema), [])
    assert.deepEqual(checkCompleteness(AST, schema), [])
  })
})

describe('checkCompleteness (input vs output, generator-independent)', () => {
  it('fails when a command/event present in the AST is missing from the schema', () => {
    const astWithExtra = [
      ...AST,
      leaf('network.DroppedCmd', 'network.droppedCmd', 'network.SetCacheBehaviorParameters'),
    ]
    const schema = projectSchema(AST, MODEL) // model does NOT know about droppedCmd
    const errors = checkCompleteness(astWithExtra, schema)
    assert.deepEqual(errors, ['dropped from schema: network.droppedCmd'])
  })

  it('does not fail for a known-incomplete (allowlisted) drop', () => {
    const astWithKnown = [
      ...AST,
      leaf('bluetooth.X', 'bluetooth.characteristicEventGenerated', 'network.SetCacheBehaviorParameters'),
    ]
    assert.deepEqual(checkCompleteness(astWithKnown, projectSchema(AST, MODEL)), [])
  })

  it('flags an allowlisted method as stale once it is emitted', () => {
    const schema = projectSchema(AST, MODEL)
    schema.events.push({
      domain: 'bluetooth',
      method: 'bluetooth.characteristicEventGenerated',
      name: 'characteristicEventGenerated',
      params: null,
    })
    assert.deepEqual(checkCompleteness(AST, schema), [
      'stale KNOWN_INCOMPLETE entry (now emitted, remove it): bluetooth.characteristicEventGenerated',
    ])
  })
})

describe('checkSchema (referential integrity)', () => {
  it('catches an unresolved ref nested inside a record field', () => {
    const schema = {
      schemaVersion: 1,
      commands: [],
      events: [],
      types: {
        'x.T': { kind: 'record', fields: [{ name: 'a', wire: 'a', required: true, type: { ref: 'x.Missing' } }] },
      },
    }
    assert.deepEqual(checkSchema(schema), ['x.T.a: unresolved type x.Missing'])
  })

  it('catches an unresolved ref inside an alias', () => {
    const schema = {
      schemaVersion: 1,
      commands: [],
      events: [],
      types: { 'x.A': { kind: 'alias', type: { ref: 'x.Missing' } } },
    }
    assert.deepEqual(checkSchema(schema), ['x.A: unresolved type x.Missing'])
  })

  it('catches an unresolved ref inside a record map', () => {
    const schema = {
      schemaVersion: 1,
      commands: [],
      events: [],
      types: { 'x.T': { kind: 'record', fields: [], map: { ref: 'x.Missing' } } },
    }
    assert.deepEqual(checkSchema(schema), ['x.T.*: unresolved type x.Missing'])
  })
})
