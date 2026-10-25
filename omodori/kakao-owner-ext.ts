// Extension for the kakao-owner lane (주인's 1:1 chat with the bot's account): the kakao lane tools, pinned to that room.
import { cfg } from './config'
process.env.OMODORI_ROOM = cfg.kakao.ownerRoom
export { default } from './kakao-lane-ext'
