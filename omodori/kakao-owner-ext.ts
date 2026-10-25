// Extension for the kakao-owner lane (주인's 1:1 chat with the 단도리 account): the 장도리 tools, pinned to that room.
import { cfg } from './config'
process.env.JANGDORI_ROOM = cfg.kakao.ownerRoom
export { default } from './kakao-lane-ext'
