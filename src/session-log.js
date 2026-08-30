import { readFile, stat } from 'node:fs/promises'
import { constants, zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xFD2FB528
const MAX_SESSION_BYTES = 64 * 1024 * 1024
const MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Scan the concatenated Zstandard frame container written by DSH. */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  let tornStart
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) {
      tornStart = start
      break
    }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid zstd frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) {
      tornStart = start
      break
    }
    const descriptor = buffer.readUInt8(offset++)
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`reserved zstd frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) {
      tornStart = start
      break
    }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) {
        tornStart = start
        break
      }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error(`reserved zstd block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) {
        tornStart = start
        break
      }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (tornStart === start) break
    if (checksum) {
      if (buffer.length - offset < 4) {
        tornStart = start
        break
      }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames, tornStart }
}

function decodeSessionBufferDetailed(buffer) {
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== ZSTD_MAGIC) {
    return { text: buffer.toString('utf8'), incomplete: false }
  }
  const { frames, tornStart } = scanZstdFrames(buffer)
  if (frames.length === 0) throw new Error('zstd session log has no complete frames')
  const parts = []
  let decompressedBytes = 0
  for (const { start, end } of frames) {
    const part = zstdDecompressSync(buffer.subarray(start, end), { maxOutputLength: MAX_DECOMPRESSED_BYTES - decompressedBytes })
    decompressedBytes += part.length
    parts.push(part)
  }
  if (tornStart !== undefined) {
    try {
      const part = zstdDecompressSync(buffer.subarray(tornStart), {
        finishFlush: constants.ZSTD_e_flush,
        maxOutputLength: MAX_DECOMPRESSED_BYTES - decompressedBytes,
      })
      decompressedBytes += part.length
      parts.push(part)
    } catch {
      // A killed DSH process can leave a torn final frame. Complete frames are durable evidence.
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), incomplete: tornStart !== undefined }
}

/** Decode plain JSONL or DSH's concatenated multi-frame Zstandard JSONL. */
export function decodeSessionBuffer(buffer) {
  return decodeSessionBufferDetailed(buffer).text
}

/** Parse one complete or crash-truncated session log. */
export function parseSessionLog(text, source = '<memory>') {
  const records = []
  const lines = text.split(/\r?\n/u)
  let incomplete = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === '') continue
    try {
      records.push(JSON.parse(line))
    } catch (error) {
      const isLastNonEmpty = lines.slice(index + 1).every(candidate => candidate === '')
      if (isLastNonEmpty) {
        incomplete = true
        break
      }
      throw new Error(`${source}: invalid JSON at line ${index + 1}`, { cause: error })
    }
  }
  const [header, ...events] = records
  if (!isRecord(header) || header.type !== 'session' || typeof header.id !== 'string') {
    throw new Error(`${source}: missing valid session header`)
  }
  if (header.version !== 0) throw new Error(`${source}: unsupported session header version ${String(header.version)}`)
  if (!Number.isSafeInteger(header.delegationDepth) || header.delegationDepth < 0) {
    throw new Error(`${source}: invalid delegationDepth`)
  }
  if (header.seedLength !== undefined
    && (!Number.isSafeInteger(header.seedLength) || header.seedLength < 0)) {
    throw new Error(`${source}: invalid seedLength`)
  }
  const seedLength = header.seedLength ?? 0
  if (seedLength > events.length) throw new Error(`${source}: seedLength exceeds the persisted event count`)
  return {
    path: source,
    header,
    events,
    ownEvents: events.slice(seedLength),
    incomplete,
  }
}

/** Load one session log from disk. */
export async function loadSessionLog(path) {
  const metadata = await stat(path)
  if (metadata.size > MAX_SESSION_BYTES) throw new Error(`${path}: session log exceeds the ${MAX_SESSION_BYTES}-byte safety limit`)
  const decoded = decodeSessionBufferDetailed(await readFile(path))
  const session = parseSessionLog(decoded.text, path)
  return { ...session, incomplete: decoded.incomplete || session.incomplete }
}

/** Recursively flatten text content from DSH content blocks. */
export function contentText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    if (Array.isArray(block.content)) {
      const nested = contentText(block.content)
      if (nested !== '') parts.push(nested)
    }
  }
  return parts.join('\n')
}

/** Parse tool arguments stored either as a JSON string or an object. */
export function toolArguments(event) {
  const value = event?.data?.arguments
  if (isRecord(value)) return value
  if (typeof value !== 'string') return undefined
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Return the canonical tool-result block nested in a tool/result event. */
export function toolResultBlock(event) {
  const blocks = event?.data?.message?.content
  if (!Array.isArray(blocks)) return undefined
  return blocks.find(block => isRecord(block) && block.type === 'tool-result')
}

/** Read one tool result's call id, status, and rendered text. */
export function toolResult(event) {
  const block = toolResultBlock(event)
  const callId = event?.data?.message?.source?.callId ?? block?.toolCallId
  return {
    callId: typeof callId === 'string' ? callId : undefined,
    isError: block?.isError === true,
    text: contentText(block?.content),
  }
}

/** Read flat text from a persisted user or assistant message event. */
export function messageText(event) {
  return contentText(event?.data?.content ?? event?.data?.message?.content)
}
