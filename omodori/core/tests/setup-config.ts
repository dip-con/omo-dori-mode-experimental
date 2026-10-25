// Tests never read the real ~/.omodori: HOME points at a temp copy of core/tests/fixtures/dori-home (fake channels) plus
// each source's fixtures/home (fake rooms), and the config is examples/config.example.json (fake ids) with every
// source's examples/config.fragment.json merged in, unless DORI_PORTABLE_CONFIG says otherwise.
// OMODORI_TEST_SOURCES=none runs the suite against the core alone (no source enabled, no source fixtures).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SOURCES = join(ROOT, 'sources')
const wanted = process.env.OMODORI_TEST_SOURCES === 'none' ? [] : readdirSync(SOURCES).filter((n) => existsSync(join(SOURCES, n, 'manifest.json')))
const scratch = mkdtempSync(join(tmpdir(), 'dori-test-cfg-'))

if (!process.env.DORI_PORTABLE_CONFIG) {
  const c = JSON.parse(readFileSync(join(ROOT, 'examples', 'config.example.json'), 'utf8'))
  for (const n of wanted) {
    const f = join(SOURCES, n, 'examples', 'config.fragment.json')
    if (!existsSync(f)) { c.sources.push({ name: n }); continue }
    const frag = JSON.parse(readFileSync(f, 'utf8'))
    c.bots.push(...(frag.bots ?? []))
    c.sources.push(...(frag.sources ?? [{ name: n }]))
  }
  process.env.DORI_PORTABLE_CONFIG = join(scratch, 'config.json')
  writeFileSync(process.env.DORI_PORTABLE_CONFIG, JSON.stringify(c, null, 1))
}
if (!process.env.DORI_TEST_REAL_HOME) {
  const home = mkdtempSync(join(tmpdir(), 'dori-test-home-'))
  cpSync(join(import.meta.dir, 'fixtures', 'dori-home'), join(home, '.omodori'), { recursive: true })
  for (const n of wanted) {
    const fx = join(SOURCES, n, 'fixtures', 'home')
    if (existsSync(fx)) cpSync(fx, join(home, '.omodori'), { recursive: true })
  }
  mkdirSync(join(home, '.config', 'agent-messenger'), { recursive: true })
  writeFileSync(join(home, '.config', 'agent-messenger', 'discordbot-credentials.json'), JSON.stringify({ bots: { assistant: { token: 'test-token-not-real' } } }))
  process.env.HOME = home
}
