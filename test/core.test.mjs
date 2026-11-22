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

const { measureTree, sweepWorkspace } = await import('../lib/artifacts.mjs')
const { pruneEmptyDirs, trashPaths } = await import('../lib/trash.mjs')
const { deliverItems } = await import('../lib/deliver.mjs')

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

test('交付物收进成品：重名加序号、非交付物不动、空目录收掉', () => {
  const cwd = join(root, 'deliver-case')
  const nested = join(cwd, 'sub')
  mkdirSync(nested, { recursive: true })
  const first = join(cwd, 'a.png')
  const second = join(nested, 'a.png')
  const junk = join(cwd, 'x.tmp')
  writeFileSync(first, 'one')
  writeFileSync(second, 'two')
  writeFileSync(junk, 'tmp')

  const scan = {
    cwd,
    items: [
      { type: 'file', path: first, keep: true, size: 3 },
      { type: 'file', path: second, keep: true, size: 3 },
      { type: 'file', path: junk, keep: false, size: 3 },
    ],
    pruneCandidates: [nested],
  }
  const result = deliverItems(scan, { apply: true })

  assert.equal(result.dest, join(cwd, '成品'))
  assert.equal(result.moved.length, 2)
  assert.equal(result.bytes, 6)
  assert.equal(existsSync(join(cwd, '成品', 'a.png')), true)
  assert.equal(existsSync(join(cwd, '成品', 'a (1).png')), true)
  assert.equal(readFileSync(join(cwd, '成品', 'a.png'), 'utf8'), 'one')
  assert.equal(existsSync(first), false)
  assert.equal(existsSync(second), false)
  assert.equal(existsSync(junk), true, '不是交付物的文件不能被搬走')
  assert.equal(existsSync(nested), false, '搬空的源目录应该被收掉')
})

test('交付物归集预览不挪文件，且拒绝把成品目录放到工作区外', () => {
  const cwd = join(root, 'deliver-dry')
  mkdirSync(cwd, { recursive: true })
  const file = join(cwd, 'b.pdf')
  writeFileSync(file, 'pdf')
  const scan = { cwd, items: [{ type: 'file', path: file, keep: true, size: 3 }] }

  const preview = deliverItems(scan, { apply: false })
  assert.equal(preview.moved.length, 1)
  assert.equal(existsSync(file), true)
  assert.equal(existsSync(join(cwd, '成品')), false)

  assert.throws(() => deliverItems(scan, { dirName: '../outside', apply: false }), /工作区/)
})

test('兜底扫描跳过浏览器配置目录', () => {
  const cwd = join(root, 'sweep-case')
  const profile = join(cwd, 'edgeprofile')
  mkdirSync(join(profile, 'Default', 'Cache'), { recursive: true })
  writeFileSync(join(profile, 'Local State'), '{}')
  writeFileSync(join(profile, 'Default', 'Cache', 'data_0'), 'cache')
  writeFileSync(join(cwd, 'normal.txt'), 'hi')

  const result = sweepWorkspace(cwd, Date.now() - 60_000)
  assert.equal(result.skippedProfiles, 1)
  const paths = [...result.files.values()].map((file) => file.path)
  assert.ok(paths.some((path) => path.endsWith('normal.txt')))
  assert.ok(!paths.some((path) => path.includes('edgeprofile')), 'profile 里的缓存文件不该进清单')
})
