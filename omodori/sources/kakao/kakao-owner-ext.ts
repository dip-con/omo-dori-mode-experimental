import { kakao } from './settings'
// Extension for the kakao-owner lane (주인's 1:1 chat with the bot's account): the kakao lane tools, pinned to that room.

process.env.OMODORI_ROOM = kakao.ownerRoom
export { default } from './kakao-lane-ext'
