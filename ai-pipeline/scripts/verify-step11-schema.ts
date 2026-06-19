import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(process.cwd(), '.env.local') })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.trim()
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim()
const supabase = createClient(url, key)

type Check = { label: string; pass: boolean; detail?: string }
const results: Check[] = []

function ok(label: string) { results.push({ label, pass: true }) }
function fail(label: string, detail: string) { results.push({ label, pass: false, detail }) }

async function checkTableExists(table: string) {
  const { error } = await supabase.from(table).select('id').limit(1)
  if (error?.code === '42P01') fail(`Table "${table}" exists`, 'table not found')
  else ok(`Table "${table}" exists`)
}

async function checkCol(table: string, col: string, shouldExist: boolean) {
  const { error } = await supabase.from(table).select(col).limit(1)
  const missing = !!error?.message?.includes(col)
  if (shouldExist) {
    missing ? fail(`${table}.${col} exists`, error?.message ?? '') : ok(`${table}.${col} exists`)
  } else {
    missing ? ok(`${table}.${col} removed`) : fail(`${table}.${col} should be removed`, 'column still present')
  }
}

async function main() {
  console.log('Verifying Step 11 schema migration...\n')

  // recordings — new columns present, old ones gone
  for (const col of ['organization_id','recorded_by','contact_id','did_number','caller_number','status','sip_provider','duration_seconds'])
    await checkCol('recordings', col, true)
  for (const col of ['call_metadata', 'duration'])
    await checkCol('recordings', col, false)

  // transcript — sequence_index added
  await checkCol('transcript', 'sequence_index', true)

  // analysis — raw_llm_output removed
  await checkCol('analysis', 'raw_llm_output', false)

  // topics table + columns
  await checkTableExists('topics')
  for (const col of ['recording_id','analysis_id','name','start_time','sequence_index'])
    await checkCol('topics', col, true)

  // gpu_jobs table + columns
  await checkTableExists('gpu_jobs')
  for (const col of ['organization_id','recording_id','job_type','status','compute_units','cost'])
    await checkCol('gpu_jobs', col, true)

  // Summary
  const passed = results.filter(r => r.pass).length
  const failed = results.filter(r => !r.pass)
  console.log('Results:')
  for (const r of results)
    console.log(`  ${r.pass ? '✅' : '❌'} ${r.label}${r.detail ? ` — ${r.detail}` : ''}`)
  console.log(`\n${passed}/${results.length} checks passed`)
  if (failed.length) process.exit(1)
}

main().catch(console.error)
