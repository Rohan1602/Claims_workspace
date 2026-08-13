// Run once (npm run gen:data) to produce public/claims.json.
// Deterministic seed so the dataset is stable across regenerations.
import { writeFileSync } from 'fs'

const STATUSES = ['New', 'In Review', 'Pending Docs', 'Adjudicated', 'Closed']
const CHANNELS = ['Email', 'SFTP', 'Portal', 'API']
const ADJUSTERS = ['R. Sen', 'A. Roy', 'M. Chatterjee', 'S. Iyer', 'Unassigned']

function mulberry32(seed) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function generate(count) {
  const rand = mulberry32(42)
  const rows = new Array(count)
  for (let i = 0; i < count; i++) {
    const submitted = new Date(2024, 0, 1 + Math.floor(rand() * 720))
    rows[i] = {
      id: `CLM-${100000 + i}`,
      claimant: `Claimant ${i + 1}`,
      channel: CHANNELS[Math.floor(rand() * CHANNELS.length)],
      status: STATUSES[Math.floor(rand() * STATUSES.length)],
      amount: Math.round(rand() * 500000) / 100,
      submittedAt: submitted.toISOString().slice(0, 10),
      assignedTo: ADJUSTERS[Math.floor(rand() * ADJUSTERS.length)],
      docSizeMB: Math.round((300 + rand() * 900) * 10) / 10,
    }
  }
  return rows
}

writeFileSync('./public/claims.json', JSON.stringify(generate(20000)))
console.log('wrote public/claims.json')
