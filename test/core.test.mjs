/**
 * 核心行为的回归测试。
 *
 * 只测「纯算路径 + 挪东西」这一段：不碰真实 DSH 数据目录。
 * 跑法：node --test test/
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

const root = mkdtempSync(join(tmpdir(), 'wrapup-test-'))
process.env.DSH_HOME = join(root, 'home')
mkdirSync(process.env.DSH_HOME, { recursive: true })

const { measureTree } = await import('../lib/artifacts.mjs')
const { pruneEmptyDirs, trashPaths } = await import('../lib/trash.mjs')

let workspace

before(() => {
  workspace = join(root, 'workspace')
  mkdirSync(join(workspace, 'out', 'nested'), { recursive: true })
  writeFileSync(join(workspace, 'out', 'a.txt'), 'hello')
  writeFileSync(join(workspace, 'out', 'nested', 'b.txt'), 'world!!')
  mkdirSync(join(workspace, 'keep'), { recursive: true })
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

test('measureTree 递归统计文件数和体积', () => {
  const result = measureTree(join(workspace, 'out'))
  assert.equal(result.files, 2)
  assert.equal(result.dirs, 1)
  assert.equal(result.size, 12)
})

test('父子一起选中时只挪最外层，体积不重复加', () => {
  const out = join(workspace, 'out')
  const result = trashPaths([out, join(out, 'a.txt'), join(out, 'nested', 'b.txt')], {
    apply: false,
    cwd: workspace,
  })
  assert.equal(result.moved.length, 1)
  assert.equal(result.moved[0].isDir, true)
  assert.equal(result.bytes, 12)
})

test('文件夹整包挪进回收站，里面的文件跟着走', () => {
  const out = join(workspace, 'out')
  const result = trashPaths([out], { apply: true, cwd: workspace })
  assert.equal(result.moved.length, 1)
  assert.equal(result.bytes, 12)
  assert.equal(existsSync(out), false)
  const landed = readdirSync(result.batch, { recursive: true }).map(String)
  const moved = landed.find((name) => name.endsWith(join('nested', 'b.txt')))
  assert.ok(moved, `回收站里应该找得到 b.txt，实际有：${landed.join(', ')}`)
  assert.equal(readFileSync(join(result.batch, moved), 'utf8'), 'world!!')
})

test('删完只收本次点名的空目录', () => {
  const keep = join(workspace, 'keep')
  const pruned = pruneEmptyDirs([keep], { cwd: workspace })
  assert.deepEqual(pruned, [keep])
  assert.equal(existsSync(keep), false)
})

test('只收被选中路径上的空目录，同会话新建但没选的空目录不动', () => {
  const touched = join(workspace, 'touched')
  const untouched = join(workspace, 'untouched')
  mkdirSync(touched, { recursive: true })
  mkdirSync(untouched, { recursive: true })
  writeFileSync(join(touched, 'x.txt'), 'x')

  const result = trashPaths([join(touched, 'x.txt')], {
    apply: true,
    cwd: workspace,
    pruneCandidates: [touched, untouched],
  })

  assert.equal(result.moved.length, 1)
  assert.equal(existsSync(touched), false, '删空的父目录应该被收掉')
  assert.equal(existsSync(untouched), true, '没勾选的空目录不能被顺手删掉')
})

test('拒绝删工作区本身或它的上级', () => {
  const result = trashPaths([workspace], { apply: false, cwd: workspace })
  assert.equal(result.moved.length, 0)
  assert.match(result.failed[0].error, /工作区本身|上级/)
})
