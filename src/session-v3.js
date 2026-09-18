import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'

// Bound expanded entries, not heap bytes: the codec also creates arrays and Sets.
const MAX_EXPANDED_SOURCES = 1024 * 1024

function preflightRows(rows) {
  let sourceCount = 0
  for (const [index, row] of rows.entries()) {
    // The codec expands provenance before checking dense seqs. Bound it before decoding.
    if (row === null || typeof row !== 'object' || Array.isArray(row) || row.seq !== index) {
      throw new Error('non-dense v3 event sequence')
    }
    // The pinned catalog counts only true but does not reject other explicit values.
    if (row.type === 'session/end-seed' && row.data !== null && typeof row.data === 'object'
      && Object.hasOwn(row.data, 'inherited') && row.data.inherited !== true) {
      throw new Error('invalid inherited marker')
    }
    if (row.sourceEventSeqs === undefined) continue
    if (!Array.isArray(row.sourceEventSeqs)) throw new Error('invalid provenance array')
    for (const entry of row.sourceEventSeqs) {
      const range = Array.isArray(entry)
      if (range && entry.length !== 2) throw new Error('invalid provenance range')
      const start = range ? entry[0] : entry
      const end = range ? entry[1] : entry
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || end < start || end >= index) {
        throw new Error('invalid provenance coordinates')
      }
      sourceCount += end - start + 1
      if (sourceCount > MAX_EXPANDED_SOURCES) throw new Error('expanded provenance exceeds safety limit')
    }
  }
}

/** Restore v3 physical rows strictly; never fall back to the legacy parser. */
export function restoreV3Session(header, rows, source) {
  try {
    if (sessionFormatCatalog.currentVersion !== 3) throw new Error('unsupported catalog generation')
    preflightRows(rows)
    const restore = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })
    for (const row of rows) restore.decodeRow(row)
    const { events, inheritedEventCount } = restore.finish()
    return { events, inheritedEventCount, ownEvents: events.slice(inheritedEventCount) }
  } catch {
    // Upstream validation can quote event types and unknown field names from private traces.
    throw new Error(`${source}: invalid v3 session log (strict format validation or safety limit)`)
  }
}
