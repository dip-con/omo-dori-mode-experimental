import { kakao } from './settings'

export const RAG_MARK = "[문서검색]";
export const DRAFT_MARK = "[초안]";
export const RAG_MARKS: ReadonlyArray<string> = [RAG_MARK, DRAFT_MARK];

/** Chat ids of the rooms the RAG lane may answer in (raw decimal text; exceeds 2^53). */
export const ALLOWED_CHAT_IDS: ReadonlyArray<string> = kakao.ragChatIds;

type ReviverContext = { source?: string };

function startsWithMark(value: unknown, trim: boolean): boolean {
  if (typeof value !== "string") return false;
  const subject = trim ? value.trim() : value;
  return RAG_MARKS.some((mark) => subject.startsWith(mark));
}

/**
 * True iff `line` is a JSON object from me, in one of `chatIds`, whose trimmed
 * text or whose file_name starts with a RAG marker. chat_id is compared using
 * the raw JSON source text so 64-bit ids are not rounded through a double.
 */
export function isRagSelfAnswer(line: string, chatIds: ReadonlyArray<string> = ALLOWED_CHAT_IDS): boolean {
  const chatIdSource = new WeakMap<object, string>();
  let root: unknown;
  try {
    root = JSON.parse(line, function (this: unknown, key: string, value: unknown, context?: ReviverContext) {
      if (key === "chat_id" && typeof this === "object" && this !== null) {
        const raw = typeof value === "string" ? value : context?.source;
        if (raw !== undefined) chatIdSource.set(this, raw);
      }
      return value;
    });
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  if (typeof root !== "object" || root === null || Array.isArray(root)) return false;
  const record = root as Record<string, unknown>;
  if (record.is_from_me !== true) return false;
  const chatId = chatIdSource.get(root);
  if (chatId === undefined || !chatIds.includes(chatId)) return false;
  return startsWithMark(record.text, true) || startsWithMark(record.file_name, false);
}
