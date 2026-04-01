// test/vision.test.js — Unit tests for vision model detection
// Run: node test/vision.test.js

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// Extract detectVisionByName from ai-providers.js (for isolated testing)
function detectVisionByName(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  const patterns = [
    'vision', 'vl', 'ocr', 'img', 'clip',
    'llava', 'bakllava', 'moondream', 'cogvlm', 'pixtral',
    'minicpm-v', 'gemma3', 'gemma-3',
    'gpt-4o', 'gpt-4-vision', 'gpt-4-turbo',
    'claude-3', 'claude-3.5', 'claude-4',
    'gemini-1.5', 'gemini-2', 'gemini',
    'kimi', 'glm',
  ];
  return patterns.some(p => n.includes(p));
}

// ============================================
console.log('\n=== Vision Models (should detect) ===');
// ============================================
const visionModels = [
  'glm-ocr:latest',
  'glm-ocr:q8_0',
  'llava:13b',
  'llava-llama3:latest',
  'bakllava:7b',
  'moondream:latest',
  'gemma3:9b',
  'gemma-3:27b',
  'qwen2.5-vl:7b',
  'minicpm-v:latest',
  'pixtral:12b',
  'llama3.2-vision:11b',
  'phi-3-vision:latest',
  'gpt-4o',
  'gpt-4-vision-preview',
  'gpt-4-turbo',
  'claude-3-sonnet-20240229',
  'claude-3.5-sonnet',
  'claude-4-opus',
  'gemini-1.5-pro',
  'gemini-2.0-flash',
  'kimi-k2.5:cloud',
  'glm-5:cloud',
  'cogvlm:latest',
];

for (const m of visionModels) {
  assert(detectVisionByName(m), `detects ${m} as vision`);
}

// ============================================
console.log('\n=== Non-Vision Models (should NOT detect) ===');
// ============================================
const nonVisionModels = [
  'llama3.2:3b',
  'qwen2.5-coder:14b',
  'deepseek-coder:v2',
  'phi3-mini',
  'mistral:7b',
  'codellama:13b',
  'nemotron-3-super:cloud',
  'nomic-embed-text',
  'all-minilm:latest',
  'starcoder2:3b',
  'qwen3-coder:480b-cloud',
  'qwen3.5:9b',
];

for (const m of nonVisionModels) {
  assert(!detectVisionByName(m), `does NOT detect ${m} as vision`);
}

// ============================================
console.log('\n=== Edge Cases ===');
// ============================================
assert(!detectVisionByName(''), 'empty string is not vision');
assert(!detectVisionByName(null), 'null is not vision');
assert(!detectVisionByName(undefined), 'undefined is not vision');

// ============================================
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(40)}`);
process.exit(failed > 0 ? 1 : 0);
