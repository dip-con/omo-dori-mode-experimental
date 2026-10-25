import { expect, test } from 'bun:test'
import { calendarLeadMinutes, hasPhysicalLocation } from '../watch'

test('physical location gets at least 60 min lead', () => {
  expect(calendarLeadMinutes({ id: 'a', location: '서울 강남구 테헤란로 1' })).toBe(60)
  expect(calendarLeadMinutes({ id: 'a', location: '서울' }, 90)).toBe(90)
})

test('online or missing location keeps base lead', () => {
  expect(calendarLeadMinutes({ id: 'b' })).toBe(15)
  expect(calendarLeadMinutes({ id: 'b', location: '' })).toBe(15)
  expect(calendarLeadMinutes({ id: 'b', location: '온라인' })).toBe(15)
  expect(calendarLeadMinutes({ id: 'b', location: 'https://meet.google.com/abc-defg-hij' })).toBe(15)
  expect(calendarLeadMinutes({ id: 'b', location: 'Zoom' })).toBe(15)
  expect(hasPhysicalLocation({ id: 'b', location: 'Online' })).toBe(false)
})
