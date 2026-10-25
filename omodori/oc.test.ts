import { expect, test } from 'bun:test'
import { checkThread } from './oc'

const fake = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

for (const t of [0, 2, 4, 5, 15]) {
  test(`type ${t} refused not_a_thread`, async () => {
    expect(await checkThread('1', fake(200, { type: t }))).toEqual({ ok: false, refused: 'not_a_thread', type: t })
  })
}
for (const t of [10, 11, 12]) {
  test(`type ${t} allowed`, async () => {
    expect(await checkThread('1', fake(200, { type: t }))).toEqual({ ok: true, type: t })
  })
}
test('HTTP failure fails closed', async () => {
  expect(await checkThread('1', fake(500, { message: 'x' }))).toEqual({ ok: false, refused: 'channel_type_unknown' })
})
test('network error fails closed', async () => {
  const boom = (async () => { throw new Error('down') }) as unknown as typeof fetch
  expect(await checkThread('1', boom)).toEqual({ ok: false, refused: 'channel_type_unknown' })
})
test('missing type fails closed', async () => {
  expect(await checkThread('1', fake(200, {}))).toEqual({ ok: false, refused: 'channel_type_unknown' })
})
