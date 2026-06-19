/**
 * Checks which FK / metadata fields are null across the recordings table,
 * and whether organizations, users, and contacts tables have any rows at all.
 *
 * Run: node scripts/check-null-fields.mjs
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing env vars. Run with:\n  NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/check-null-fields.mjs\nor source your .env.local first.')
  process.exit(1)
}

async function query(table, select = '*', filter = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}${filter}`
  const res = await fetch(url, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${table}: HTTP ${res.status} — ${text}`)
  }
  return res.json()
}

async function countNull(table, column) {
  // Supabase REST: filter rows where column IS NULL using `is` operator
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=id&${column}=is.null`
  const res = await fetch(url, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Prefer: 'count=exact',
      'Range-Unit': 'items',
      Range: '0-0',
    },
  })
  const range = res.headers.get('content-range') // e.g. "0-0/42" or "*/5"
  const total = range ? range.split('/')[1] : '?'
  return total
}

async function countAll(table) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=id`
  const res = await fetch(url, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Prefer: 'count=exact',
      'Range-Unit': 'items',
      Range: '0-0',
    },
  })
  const range = res.headers.get('content-range')
  return range ? range.split('/')[1] : '?'
}

async function main() {
  console.log('\n=== Dependency tables (must exist before FK fields can be filled) ===\n')

  for (const t of ['organizations', 'users', 'contacts']) {
    const count = await countAll(t)
    const status = count === '0' || count === '?' ? '❌ EMPTY' : `✅ ${count} rows`
    console.log(`  ${t.padEnd(16)} ${status}`)
  }

  console.log('\n=== recordings table: nullable FK / metadata columns ===\n')

  const total = await countAll('recordings')
  console.log(`  Total recordings: ${total}\n`)

  const cols = ['organization_id', 'recorded_by', 'contact_id', 'did_number', 'caller_number', 'sip_provider']
  for (const col of cols) {
    const nullCount = await countNull('recordings', col)
    const pct = total !== '0' && total !== '?' ? ` (${Math.round(nullCount / total * 100)}%)` : ''
    const icon = nullCount === total ? '⚠️ ' : nullCount === '0' ? '✅' : '⚠️ '
    console.log(`  ${col.padEnd(20)} ${icon} ${nullCount} / ${total} null${pct}`)
  }

  console.log('\n=== Sample recordings (latest 5) ===\n')

  const rows = await query(
    'recordings',
    'id,caller_number,organization_id,recorded_by,contact_id,status,created_at',
    '&order=created_at.desc&limit=5'
  )

  if (!rows.length) {
    console.log('  No recordings found.')
  } else {
    for (const r of rows) {
      console.log(`  [${r.id?.slice(0, 8)}] ${r.created_at?.slice(0, 19)}`)
      console.log(`    caller_number:   ${r.caller_number   ?? 'NULL'}`)
      console.log(`    organization_id: ${r.organization_id ?? 'NULL'}`)
      console.log(`    recorded_by:     ${r.recorded_by     ?? 'NULL'}`)
      console.log(`    contact_id:      ${r.contact_id      ?? 'NULL'}`)
      console.log(`    status:          ${r.status          ?? 'NULL'}`)
      console.log()
    }
  }
}

main().catch(err => {
  console.error('\nFatal:', err.message)
  process.exit(1)
})
