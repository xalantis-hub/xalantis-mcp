#!/usr/bin/env node
/**
 * Copies the public Xalantis API v1 OpenAPI spec into the package, keeping only
 * what the generic tools need (operations, parameters, request bodies, scopes and
 * component schemas). Response bodies and code samples are dropped to keep the
 * published package small.
 *
 *   node scripts/sync-openapi.mjs [path/to/openapi.json]
 *
 * Default source: the sibling xalantis-application checkout.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(process.argv[2] ?? resolve(root, '../../xalantis-application/storage/app/openapi.json'))
const target = resolve(root, 'openapi/xalantis-openapi.json')

const spec = JSON.parse(readFileSync(source, 'utf8'))
const methods = ['get', 'post', 'put', 'patch', 'delete']
const paths = {}
let operations = 0

for (const [path, item] of Object.entries(spec.paths ?? {})) {
  for (const method of methods) {
    const op = item[method]
    if (!op) continue
    paths[path] ??= {}
    paths[path][method] = {
      operationId: op.operationId,
      summary: op.summary,
      description: op.description,
      tags: op.tags,
      security: op.security,
      parameters: op.parameters,
      requestBody: op.requestBody,
    }
    operations++
  }
}

const slim = {
  openapi: spec.openapi,
  info: { title: spec.info?.title, version: spec.info?.version },
  paths,
  components: { schemas: spec.components?.schemas ?? {} },
}

mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, JSON.stringify(slim) + '\n')
console.log(`${operations} operations, API contract ${slim.info.version} → ${target}`)
