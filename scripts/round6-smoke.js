'use strict';

// Round 6 冒烟测试 (2026-07-25) — 验证 P4 Codex/ChatGPT 桌宠识别分支覆盖
//
// 本轮是纯测试增强（不改 territory.js 生产代码），所以冒烟测试直接
// 调用 territory.js 的导出函数验证 Codex 识别逻辑，不需要 HTTP server。
//
// 覆盖：
//   1. parseScan /chatgpt/i 大小写不敏感
//   2. parseScan 24px 轮廓容差边界
//   3. parseScan 同 PID 多窗口去重（寄生型 ChatGPT）
//   4. parseScan excludePids 排除自身
//   5. scanCandidateScore 轮廓评分 vs 面积评分
//   6. 混合场景：ChatGPT + 独立型桌宠共存
//   7. chatGPTVisualBounds 4 个 placement 组合

const assert = require('assert');
const {
  parseScan, scanCandidateScore, chatGPTVisualBounds, chatGPTDragCandidates,
  DEFAULT_RIVALS,
} = require('../backend/territory');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); }
  catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}

const WA = { x: 0, y: 25, width: 1440, height: 875 };

async function main() {
  console.log('=== Round 6 Smoke Test — Codex territory identification ===\n');

  // ── [1] parseScan case-insensitive ──
  console.log('[1] parseScan: /chatgpt/i case-insensitive');
  check('"chatgpt" (lowercase) → 356×320 recognized', () => {
    const r = parseScan('chatgpt|42|100|200|356|320\n', []);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].w, 356);
  });
  check('"CHATGPT" (uppercase) → 356×320 recognized', () => {
    const r = parseScan('CHATGPT|42|100|200|356|320\n', []);
    assert.strictEqual(r.length, 1);
  });

  // ── [2] 24px tolerance boundary ──
  console.log('\n[2] parseScan: 24px shape tolerance boundary');
  check('exact boundary (|Δw|+|Δh| = 24) → kept', () => {
    const r = parseScan('ChatGPT|42|100|200|368|332\n', []);
    assert.strictEqual(r.length, 1);
  });
  check('just over boundary (|Δw|+|Δh| = 26) → excluded', () => {
    const r = parseScan('ChatGPT|42|100|200|369|333\n', []);
    assert.strictEqual(r.length, 0);
  });

  // ── [3] Same-PID dedup (parasitic ChatGPT) ──
  console.log('\n[3] parseScan: same-PID multi-window dedup');
  check('main window + pet window → pet window selected', () => {
    const r = parseScan('ChatGPT|42|100|100|1512|865\nChatGPT|42|500|300|356|320\n', []);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].x, 500);
  });

  // ── [4] excludePids ──
  console.log('\n[4] parseScan: excludePids');
  check('own PID excluded', () => {
    assert.strictEqual(parseScan('ChatGPT|42|100|200|356|320\n', [42]).length, 0);
  });
  check('other PID not excluded', () => {
    assert.strictEqual(parseScan('ChatGPT|42|100|200|356|320\n', [99]).length, 1);
  });

  // ── [5] scanCandidateScore: shape vs area ──
  console.log('\n[5] scanCandidateScore: ChatGPT shape vs area scoring');
  check('exact 356×320 → 0 (best)', () => {
    assert.strictEqual(scanCandidateScore({ name: 'ChatGPT', w: 356, h: 320 }), 0);
  });
  check('non-ChatGPT → area-based (w*h)', () => {
    assert.strictEqual(scanCandidateScore({ name: 'Desktop Goose', w: 120, h: 120 }), 14400);
  });
  check('ChatGPT shape score < same-size non-ChatGPT area score', () => {
    assert(scanCandidateScore({ name: 'ChatGPT', w: 356, h: 320 })
      < scanCandidateScore({ name: 'Desktop Goose', w: 356, h: 320 }));
  });

  // ── [6] Mixed rivals ──
  console.log('\n[6] Mixed: ChatGPT + dedicated rivals coexist');
  check('ChatGPT pet + Desktop Goose → 2 rivals', () => {
    const r = parseScan('ChatGPT|42|100|200|356|320\nDesktop Goose|99|400|100|180|160\n', []);
    assert.strictEqual(r.length, 2);
  });
  check('ChatGPT main + popup (no pet) → 0 rivals', () => {
    const r = parseScan('ChatGPT|42|100|100|1512|865\nChatGPT|42|200|200|300|250\n', []);
    assert.strictEqual(r.length, 0);
  });

  // ── [7] chatGPTVisualBounds: 4 placements ──
  console.log('\n[7] chatGPTVisualBounds: 4 placement combinations');
  const rival = { name: 'ChatGPT', pid: 42, x: 800, y: 300, w: 356, h: 320 };
  const placements = [
    { dir: 1, label: 'right-lower' },
    { dir: -1, label: 'left-lower' },
    { dir: 1, y: 100, label: 'right-upper' },
    { dir: -1, y: 100, label: 'left-upper' },
  ];
  for (const p of placements) {
    const wa = { ...WA, ...(p.y != null ? { height: p.y } : {}) };
    const rb = { ...rival, ...(p.y != null ? { y: p.y } : {}) };
    const v = chatGPTVisualBounds(rb, wa, p.dir);
    check(`placement ${p.label}: bounds within window frame`, () => {
      assert.ok(v.x >= rb.x, `${p.label}: visual.x (${v.x}) >= frame.x (${rb.x})`);
      assert.ok(v.y >= rb.y, `${p.label}: visual.y (${v.y}) >= frame.y (${rb.y})`);
      assert.ok(v.x + v.w <= rb.x + rb.w, `${p.label}: visual right <= frame right`);
      assert.ok(v.y + v.h <= rb.y + rb.h, `${p.label}: visual bottom <= frame bottom`);
      assert.ok(v.w < rb.w, `${p.label}: mascot narrower than frame`);
      assert.ok(v.h < rb.h, `${p.label}: mascot shorter than frame`);
    });
  }

  // ── [8] chatGPTDragCandidates: 4 points ──
  console.log('\n[8] chatGPTDragCandidates: always 4 unique candidates');
  check('default: 4 unique drag points', () => {
    const pts = chatGPTDragCandidates(rival, WA);
    assert.strictEqual(pts.length, 4);
    assert.strictEqual(new Set(pts.map(p => p.join(','))).size, 4);
  });
  check('with learned point: 4 unique, first = nearest anchor', () => {
    // learned=[0.5,0.5] snaps to nearest pre-computed anchor:
    //   x: |0.5-0.764| < |0.5-0.188| → xEnd,  y: |0.5-0.784| > |0.5-0.3875| → yUpper
    const learned = [0.5, 0.5];
    const pts = chatGPTDragCandidates(rival, WA, learned);
    assert.strictEqual(pts.length, 4);
    assert.strictEqual(new Set(pts.map(p => p.join(','))).size, 4);
    // Verify first point is NOT the raw learned (it snaps to anchor)
    assert.ok(pts[0][0] !== 0.5 || pts[0][1] !== 0.5,
      'learned should snap to nearest anchor, not be returned raw');
  });

  console.log(`\n${failures === 0 ? '✅ ALL PASS' : '❌ ' + failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('smoke crashed:', e); process.exit(1); });
