/**
 * Spoken-style steering for voice-originated turns.
 *
 * A voice-conversation send goes through the normal composer submit path, so
 * the chat's selected model answers it — unchanged. Only the style changes:
 * the reply will be read aloud, so a synthetic system-reminder part asks the
 * model for spoken prose instead of written markdown. The part is synthetic,
 * so it reaches the model as context but never renders as user text (see
 * normalizeUserDisplayParts.ts).
 */

export const VOICE_STYLE_INSTRUCTION =
    '本轮消息来自用户的语音输入，你的回复会被朗读出来。请用口语直接回答：一两句短句说清重点，一次最多问一个问题。'
    + '不要用 Markdown、表格、链接或编号列表；复杂步骤拆成一步一步说，不要一口气讲完。'
    + '只有在真正要调用工具或查询、需要等待时，才先说一句简短的动作预告（比如「我查一下」）。'
    + '开口方式自然多变，不要机械地加「好的」「当然」这类口头禅；数字和日期用适合朗读的说法（比如「百分之八十」「下周二下午三点」）。';
