// KakaoTalk source settings: config.json sources[{ name: "kakao", settings }] over these defaults (keys in manifest.json).
import { logDir } from '../../core/config'
import { sourceSettings } from '../../core/sources'

const HOME = process.env.HOME ?? ''

export const KAKAO_DEFAULTS = {
  locoPort: 8397,
  healthChatId: '',
  ragChatIds: [] as string[],
  archiveRoot: `${HOME}/KakaoArchive`,
  requestsLedger: '',
  ownerRoom: '',
  botUserId: '',
  generatedImagesDir: `${HOME}/generated-images/`,
  docOutDir: '',
  issueRefRooms: [] as string[],
  archiveSyncLabel: 'com.example.kakao-archive.sync',
}
export type KakaoSettings = typeof KAKAO_DEFAULTS

export const kakao: KakaoSettings = sourceSettings('kakao', KAKAO_DEFAULTS)
export const kakaoLogs = () => process.env.OMODORI_KAKAO_LOGS || `${logDir()}/kakao`
