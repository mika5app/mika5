// test/rag.test.js — Unit tests for RAG chunking and cache logic
// Run: node test/rag.test.js
// Note: Does NOT require Ollama running (tests chunking + cache, not embedding)

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function assertEq(actual, expected, msg) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++; console.log(`  ✓ ${msg}`);
  } else {
    failed++; console.error(`  ✗ ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ============================================
console.log('\n=== Chunking Logic ===');
// ============================================

// Extract chunkText function logic (copied from rag.js for isolated testing)
const CHUNK_CHARS = 4200;
const OVERLAP_CHARS = 700;

function chunkText(text) {
  const t = (text || "").toString();
  const chunks = [];
  let start = 0;
  let idx = 0;
  while (start < t.length) {
    const end = Math.min(t.length, start + CHUNK_CHARS);
    const chunk = t.slice(start, end).trim();
    if (chunk) chunks.push({ idx, text: chunk });
    idx += 1;
    if (end >= t.length) break;
    start = Math.max(0, end - OVERLAP_CHARS);
  }
  return chunks;
}

// Test 1: Empty text
const empty = chunkText('');
assertEq(empty.length, 0, 'empty text produces 0 chunks');

// Test 2: Short text (< CHUNK_CHARS)
const short = chunkText('Hello world');
assertEq(short.length, 1, 'short text produces 1 chunk');
assertEq(short[0].text, 'Hello world', 'chunk content matches');
assertEq(short[0].idx, 0, 'chunk index is 0');

// Test 3: Exact boundary
const exact = chunkText('x'.repeat(CHUNK_CHARS));
assertEq(exact.length, 1, 'text exactly CHUNK_CHARS produces 1 chunk');

// Test 4: Just over boundary
const over = chunkText('x'.repeat(CHUNK_CHARS + 1));
assertEq(over.length, 2, 'text CHUNK_CHARS+1 produces 2 chunks');
assert(over[1].text.length > 0, 'second chunk has content');

// Test 5: Overlap verification
const text5k = 'a'.repeat(5000);
const chunks5k = chunkText(text5k);
assertEq(chunks5k.length, 2, '5000 chars produces 2 chunks');
// Second chunk should start at CHUNK_CHARS - OVERLAP_CHARS = 3500
assertEq(chunks5k[1].text.length, 5000 - (CHUNK_CHARS - OVERLAP_CHARS), 'overlap is correct');

// Test 6: Large text
const text20k = 'b'.repeat(20000);
const chunks20k = chunkText(text20k);
assert(chunks20k.length >= 5, '20k chars produces 5+ chunks');
// Verify all chunks have content
assert(chunks20k.every(c => c.text.length > 0), 'all chunks have content');
// Verify indices are sequential
assert(chunks20k.every((c, i) => c.idx === i), 'chunk indices are sequential');

// Test 7: Whitespace-only text
const whitespace = chunkText('   \n\n  \t  ');
assertEq(whitespace.length, 0, 'whitespace-only text produces 0 chunks');

// ============================================
console.log('\n=== Cosine Similarity (dot product) ===');
// ============================================

function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

// Test identical vectors
const v1 = [1, 0, 0, 0];
assertEq(dot(v1, v1), 1, 'identical unit vectors: dot = 1');

// Test orthogonal vectors
const v2 = [0, 1, 0, 0];
assertEq(dot(v1, v2), 0, 'orthogonal vectors: dot = 0');

// Test opposite vectors
const v3 = [-1, 0, 0, 0];
assertEq(dot(v1, v3), -1, 'opposite vectors: dot = -1');

// Test real-world-like vectors
const va = [0.5, 0.3, 0.7, 0.1];
const vb = [0.5, 0.3, 0.7, 0.1];
const dotAB = dot(va, vb);
assert(Math.abs(dotAB - 0.84) < 0.01, 'same vectors have high similarity');

// Test different length vectors
const short1 = [1, 2];
const long1 = [1, 2, 3, 4];
assertEq(dot(short1, long1), 5, 'different length: uses min length');

// ============================================
console.log('\n=== Cache TTL Logic ===');
// ============================================

const CACHE_TTL_MS = 5 * 60 * 1000;

function isCacheExpired(cachedTs) {
  return (Date.now() - cachedTs) > CACHE_TTL_MS;
}

assert(!isCacheExpired(Date.now()), 'fresh cache is not expired');
assert(!isCacheExpired(Date.now() - 4 * 60 * 1000), '4-min old cache is not expired');
assert(isCacheExpired(Date.now() - 6 * 60 * 1000), '6-min old cache is expired');
assert(isCacheExpired(Date.now() - CACHE_TTL_MS - 1), 'exactly expired + 1ms is expired');

// ============================================
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(40)}`);
process.exit(failed > 0 ? 1 : 0);
