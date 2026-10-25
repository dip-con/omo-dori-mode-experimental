// Tests never read the real ~/.omocat: HOME points at a temp copy of tests/fixtures/omocat-home (fake rooms and
// channels), and the config is examples/config.example.json (fake ids) unless DORI_PORTABLE_CONFIG says otherwise.
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DORI_PORTABLE_CONFIG ??= join(import.meta.dir, '..', 'examples', 'config.example.json')
if (!process.env.DORI_TEST_REAL_HOME) {
  const home = mkdtempSync(join(tmpdir(), 'dori-test-home-'))
  cpSync(join(import.meta.dir, 'fixtures', 'omocat-home'), join(home, '.omocat'), { recursive: true })
  mkdirSync(join(home, '.config', 'agent-messenger'), { recursive: true })
  writeFileSync(join(home, '.config', 'agent-messenger', 'discordbot-credentials.json'), JSON.stringify({ bots: { omocat: { token: 'test-token-not-real' } } }))
  process.env.HOME = home
}
