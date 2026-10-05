import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Catalog, fold, MAX_SEARCH_RESULTS } from '../build/openapi.js'
import { buildPath, checkQuery, buildHeaders } from '../build/generic.js'
import { resolveBaseUrl, toApiError } from '../build/api.js'

const catalog = Catalog.load()

test('loads every operation of the bundled spec', () => {
  assert.ok(catalog.size >= 300, `only ${catalog.size} operations`)
  assert.ok(catalog.areas().some((a) => a.area === 'Projets et tâches'))
})

test('search ignores accents and requires every word', () => {
  assert.equal(fold('Tâche Créée'), 'tache creee')
  const { operations } = catalog.search('tache commentaire', undefined, 'POST')
  assert.ok(operations.some((op) => op.operation_id === 'post_projects_By_projectUuid_tasks_By_taskUuid_comments'))
  assert.ok(operations.every((op) => op.method === 'POST'))
})

test('search reports the total when results are capped', () => {
  const { operations, total } = catalog.search('', 'Projets et tâches')
  assert.equal(operations.length, MAX_SEARCH_RESULTS)
  assert.ok(total > operations.length)
})

test('describe exposes parameters, scopes and the body schema', () => {
  const op = catalog.describe('post_projects_By_projectUuid_tasks')
  assert.deepEqual(op.scopes, ['projects:write'])
  assert.ok(op.parameters.some((p) => p.name === 'Idempotency-Key' && p.required))
  assert.deepEqual(op.body.schema.required, ['title'])
  assert.throws(() => catalog.describe('nope'), /Unknown operation/)
})

test('describe lists the file fields of multipart operations', () => {
  const op = catalog.describe('post_projects_By_projectUuid_documents')
  assert.equal(op.body.content_type, 'multipart/form-data')
  assert.deepEqual(op.body.file_fields, [{ name: 'files', multiple: true }])
})

test('buildPath fills, encodes and validates path parameters', () => {
  const op = catalog.get('get_projects_By_projectUuid_tasks_By_taskUuid')
  assert.equal(buildPath(op, { projectUuid: 'a b', taskUuid: 't' }), '/projects/a%20b/tasks/t')
  assert.throws(() => buildPath(op, { projectUuid: 'p' }), /Missing path parameter/)
  assert.throws(() => buildPath(op, { projectUuid: 'p', taskUuid: '..' }), /Invalid path parameter/)
  assert.throws(() => buildPath(op, { projectUuid: 'p', taskUuid: 't', other: 'x' }), /Unknown path parameter/)
})

test('checkQuery accepts declared names with or without brackets', () => {
  const op = catalog.get('get_projects_By_projectUuid_tasks')
  assert.deepEqual(checkQuery(op, { status: 'a', 'labels[]': ['b'], per_page: 10 }), { status: ['a'], 'labels[]': ['b'], per_page: 10 })
  assert.throws(() => checkQuery(op, { colour: 'red' }), /Unknown query parameter/)
})

test('buildHeaders only lets declared headers through', () => {
  const op = catalog.get('post_projects')
  assert.deepEqual(buildHeaders(op, { 'idempotency-key': ' k1 ' }), { 'Idempotency-Key': 'k1' })
  assert.throws(() => buildHeaders(op, { Authorization: 'x' }), /Header not allowed/)
})

test('resolveBaseUrl accepts an origin or a full API base', () => {
  assert.equal(resolveBaseUrl(undefined), 'https://xalantis.com/api/v1')
  assert.equal(resolveBaseUrl('http://xalantis-application.test/'), 'http://xalantis-application.test/api/v1')
  assert.equal(resolveBaseUrl('https://app.example.com/api/v1'), 'https://app.example.com/api/v1')
})

test('toApiError reads both error shapes of the API', () => {
  const nested = toApiError({ error: { code: 'NOT_FOUND', message: 'Missing', details: { id: ['x'] } } }, 404)
  assert.equal(nested.message, 'Missing')
  assert.equal(nested.code, 'NOT_FOUND')
  assert.deepEqual(nested.details, { id: ['x'] })

  const flat = toApiError({ message: 'Key required', code: 'IDEMPOTENCY_KEY_REQUIRED', error: 'idempotency_key_required' }, 400)
  assert.equal(flat.message, 'Key required')
  assert.equal(flat.code, 'IDEMPOTENCY_KEY_REQUIRED')

  assert.equal(toApiError(undefined, 502).message, 'Request failed (HTTP 502)')
})
