import { readdirSync, readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const files = readdirSync('dist/assets').filter(name => name.endsWith('.js'))
assert.ok(files.length > 0, 'Build the app first')
for (const file of files) {
  const source = readFileSync(`dist/assets/${file}`, 'utf8')
  for (const marker of ['dev-only', 'binjari-development-v2', 'makeDemoRooms', '검증용 공간 만들기', '제1열람실']) {
    assert.ok(!source.includes(marker), `Development fixture leaked into ${file}: ${marker}`)
  }
}
console.log('PASS production assets contain no development provider, credentials or place fixtures')
