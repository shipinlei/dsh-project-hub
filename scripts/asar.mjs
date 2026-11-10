#!/usr/bin/env node
/**
 * 只读 asar 提取小工具（Electron asar 格式）。
 *
 * 用法：
 *   node scripts/asar.mjs list  <asar> [子串过滤]
 *   node scripts/asar.mjs cat   <asar> <内部路径> [起始行] [行数]
 *
 * 用途：DSH 的 app.asar 是单文件归档，read 工具无法直接读；本工具按 asar
 * 头部索引定位文件数据（不写任何文件），用于查官方文档与源码片段。
 */
import fs from 'node:fs'

const [, , action, asarPath, ...rest] = process.argv
if (!action || !asarPath) {
  console.error('usage: node scripts/asar.mjs list|cat <asar> [args...]')
  process.exit(2)
}

const fd = fs.openSync(asarPath, 'r')
const sizeBuf = Buffer.alloc(8)
fs.readSync(fd, sizeBuf, 0, 8, 0)
const headerSize = sizeBuf.readUInt32LE(4)
const headerBuf = Buffer.alloc(headerSize)
fs.readSync(fd, headerBuf, 0, headerSize, 8)
const stringSize = headerBuf.readUInt32LE(4)
const json = headerBuf.toString('utf8', 8, 8 + stringSize)
const tree = JSON.parse(json).files
const dataStart = 8 + headerSize

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node)) {
    const full = prefix === '' ? name : `${prefix}/${name}`
    if (entry.files !== undefined) {
      if (entry.link !== undefined) continue
      walk(entry.files, full, out)
    } else if (typeof entry === 'object' && entry !== null && entry.offset !== undefined) {
      out.push({ path: full, size: Number(entry.size), offset: Number(entry.offset) })
    }
  }
  return out
}

function readEntry(fullPath) {
  const parts = fullPath.split('/').filter(Boolean)
  let node = tree
  for (let i = 0; i < parts.length; i += 1) {
    const next = node[parts[i]]
    if (next === undefined) return undefined
    if (i === parts.length - 1) {
      if (next.offset === undefined) return undefined
      const size = Number(next.size)
      const buf = Buffer.alloc(size)
      fs.readSync(fd, buf, 0, size, dataStart + Number(next.offset))
      return buf
    }
    if (next.files === undefined) return undefined
    node = next.files
  }
  return undefined
}

if (action === 'dirs') {
  const prefix = rest[0] ?? ''
  const filter = rest[1]
  const names = new Set()
  const walkDirs = (node, p) => {
    for (const [name, entry] of Object.entries(node)) {
      const full = p === '' ? name : `${p}/${name}`
      if (entry.files !== undefined) {
        names.add(full)
        walkDirs(entry.files, full)
      }
    }
  }
  walkDirs(tree, '')
  const matched = [...names].filter((p) => p.startsWith(prefix) && (filter === undefined || p.includes(filter)))
  for (const name of matched.slice(0, 400)) console.log(name)
  console.log(`# ${matched.length} 个目录匹配`)
} else if (action === 'list') {
  const filter = rest[0]
  const files = walk(tree, '', [])
  const matched = filter === undefined ? files : files.filter((f) => f.path.includes(filter))
  for (const file of matched.slice(0, 200)) console.log(`${String(file.size).padStart(9)}  ${file.path}`)
  console.log(`# ${matched.length} 个文件匹配（总 ${files.length}）`)
} else if (action === 'cat') {
  const internal = rest[0]
  const start = rest[1] === undefined ? 1 : Number(rest[1])
  const count = rest[2] === undefined ? 400 : Number(rest[2])
  const buf = readEntry(internal)
  if (buf === undefined) {
    console.error(`not found: ${internal}`)
    process.exit(1)
  }
  const lines = buf.toString('utf8').split(/\r?\n/)
  for (let i = start - 1; i < Math.min(lines.length, start - 1 + count); i += 1) {
    console.log(`${i + 1}\t${lines[i]}`)
  }
  console.error(`# ${lines.length} 行`)
} else {
  console.error('unknown action')
  process.exit(2)
}
fs.closeSync(fd)
