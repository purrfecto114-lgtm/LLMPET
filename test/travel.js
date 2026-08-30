'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const {
  createTravelManager,
  buildTravelPrompt,
  buildWanderPrompt,
  buildInvocation,
  buildVisibleInvocation,
  parseClaudeOutput,
  parseCodexOutput,
  rankFor,
  wanderTemplates,
} = require('../backend/travel');
const { machineGrowth, MACHINE_RANK_UNIT_TOKENS } = require('../backend/growth');
const {
  buildCandidates,
  cleanTerminalLaunchEnv,
  closeMacTerminalScript,
  travelCliPids,
} = require('../backend/launch');

function fakeChild(onInput) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 4242;
  child.stdin.on('data', (chunk) => onInput(String(chunk)));
  child.kill = (signal) => {
    process.nextTick(() => child.emit('close', null, signal || 'SIGTERM'));
    return true;
  };
  return child;
}

function assertPrivateFile(filePath) {
  const stat = fs.statSync(filePath);
  assert(stat.isFile(), `${filePath} must be a regular file`);
  // Windows reports synthetic POSIX mode bits (commonly 0666) even when the
  // file inherits the user's private ACL. Only Unix platforms can prove 0600
  // through fs.stat().mode.
  if (process.platform !== 'win32') assert.strictEqual(stat.mode & 0o777, 0o600);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmpet-travel-test-'));
  const project = path.join(root, 'project');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(project, { recursive: true });

  console.log('[TR1] prompt and invocation safety');
  const prompt = buildTravelPrompt({
    locale: 'zh',
    cwd: project,
    project: 'test-project',
    mission: '找一个真实问题',
  });
  assert(prompt.includes('只读'));
  assert(prompt.includes('不要编辑、创建、删除'));
  assert(prompt.includes('找一个真实问题'));
  assert(prompt.includes('```text'));
  assert(prompt.includes('字符画'));
  assert(prompt.includes('LLMPET_STOP'));
  assert(prompt.includes('珠穆朗玛峰'));
  assert(prompt.includes('140～220 个汉字'));
  assert(prompt.includes('无需滚动'));
  assert(prompt.includes('审美一遍'));
  assert(prompt.includes('禁止复用'));
  const claudeInvocation = buildInvocation('claude', '/tmp/ignored');
  assert(claudeInvocation.args.includes('--no-session-persistence'));
  assert(claudeInvocation.args.includes('dontAsk'));
  assert(!claudeInvocation.args.includes('--dangerously-skip-permissions'));
  const codexInvocation = buildInvocation('codex', '/tmp/postcard');
  assert(codexInvocation.args.includes('--ephemeral'));
  assert(codexInvocation.args.includes('read-only'));
  assert(!codexInvocation.args.includes('danger-full-access'));
  console.log('  ✓ both agents are isolated and read-only');

  console.log('[TR1b] free wander has no project context and only read-only public web tools');
  const wanderPrompt = buildWanderPrompt({ locale: 'zh' });
  assert(wanderPrompt.includes('自己出门探索真实世界'));
  assert(wanderPrompt.includes('这一趟至少走完三站'));
  assert(wanderPrompt.includes('至少用两个相互独立的来源核实'));
  assert(wanderPrompt.includes('只允许使用公开网页搜索和公开页面读取'));
  assert(wanderPrompt.includes('不要查看本地文件、运行命令、登录、填表、上传'));
  assert(wanderPrompt.includes('弹出原生授权界面'));
  assert(wanderPrompt.includes('```text'));
  assert(wanderPrompt.includes('8～14 行'));
  assert(wanderPrompt.includes('3～5 张'));
  assert(wanderPrompt.includes('看起来丑、歪、乱'));
  assert(!wanderPrompt.includes(project));
  const claudeWanderInvocation = buildVisibleInvocation(
    'claude',
    '11111111-1111-4111-8111-111111111111',
    { allowWeb: true },
  );
  assert.strictEqual(
    claudeWanderInvocation.args[claudeWanderInvocation.args.indexOf('--tools') + 1],
    'WebSearch,WebFetch',
  );
  assert.strictEqual(
    claudeWanderInvocation.args[claudeWanderInvocation.args.indexOf('--permission-mode') + 1],
    'manual',
  );
  assert(!claudeWanderInvocation.args.includes('--allowedTools'));
  assert(claudeWanderInvocation.args.includes('--session-id'));
  assert(claudeWanderInvocation.args.includes('--name'));
  assert(!claudeWanderInvocation.args.includes('--no-session-persistence'));
  assert(!claudeWanderInvocation.args.includes(wanderPrompt));
  const resumedClaudeInvocation = buildVisibleInvocation(
    'claude',
    '11111111-1111-4111-8111-111111111111',
    { allowWeb: true, resume: true, webApproved: true },
  );
  assert(resumedClaudeInvocation.args.includes('--resume'));
  assert(!resumedClaudeInvocation.args.includes('--session-id'));
  assert(resumedClaudeInvocation.args.includes('--allowedTools'));
  const codexWanderInvocation = buildVisibleInvocation('codex', 'ignored', { allowWeb: true });
  assert(codexWanderInvocation.args.includes('on-request'));
  assert(!codexWanderInvocation.args.includes('never'));
  assert(codexWanderInvocation.args.includes('read-only'));
  assert(codexWanderInvocation.args.includes('shell_tool'));
  assert(!codexWanderInvocation.args.includes('exec'));
  assert(!codexWanderInvocation.args.includes('resume'));
  assert(codexWanderInvocation.args.includes('--search'));
  assert(codexWanderInvocation.args.includes('--no-alt-screen'));
  assert(!codexWanderInvocation.args.includes(wanderPrompt));
  assert(!codexWanderInvocation.args.includes('web_search="disabled"'));
  const resumedCodexInvocation = buildVisibleInvocation(
    'codex',
    '22222222-2222-4222-8222-222222222222',
    { allowWeb: true, resume: true },
  );
  assert.strictEqual(resumedCodexInvocation.args[0], 'resume');
  assert(resumedCodexInvocation.args.includes('22222222-2222-4222-8222-222222222222'));
  assert(!resumedCodexInvocation.args.includes('exec'));
  const offlineCodexInvocation = buildVisibleInvocation('codex', 'ignored');
  const webSearchIndex = offlineCodexInvocation.args.indexOf('--config');
  assert.strictEqual(offlineCodexInvocation.args[webSearchIndex + 1], 'web_search="disabled"');
  assert(!offlineCodexInvocation.args.includes('--search'));
  assert.deepStrictEqual(
    wanderTemplates('en').map((item) => item.id),
    wanderTemplates('ja').map((item) => item.id),
  );
  assert.strictEqual(new Set(wanderTemplates('zh').map((item) => item.id)).size, 6);
  assert(wanderTemplates('zh').every((item) => item.allowWeb === true));
  if (process.platform === 'darwin') {
    const terminalArgs = buildCandidates(
      '/fake/claude',
      '/tmp/wander',
      ['--tools', ''],
      '/tmp/wander/prompt.txt',
      true,
      'LLMPET Travel',
    )[0][1];
    const terminalCommand = terminalArgs.join(' ');
    assert(terminalCommand.includes('/tmp/wander/prompt.txt'));
    assert(!terminalCommand.includes('第一行'));
    assert(!terminalCommand.includes('/usr/bin/base64'));
    assert(terminalCommand.length < 1000);
    assert(terminalCommand.includes('exec'));
    assert(!terminalCommand.includes('\nlaunch\n'));
    assert.strictEqual((terminalCommand.match(/do script/g) || []).length, 1);
    assert(terminalCommand.includes('custom title of llmpetTab'));
    assert(terminalCommand.includes('LLMPET Travel'));
    const cleanEnv = cleanTerminalLaunchEnv({
      PATH: '/usr/bin:/opt/anaconda3/bin',
      HOME: '/Users/example',
      CONDA_PREFIX: '/opt/anaconda3',
      CONDA_DEFAULT_ENV: 'base',
      CONDA_SHLVL: '1',
      _CE_CONDA: 'conda',
      CLAUDE_CODE_OAUTH_TOKEN: 'preserved',
    });
    assert.strictEqual(cleanEnv.PATH, '/usr/bin:/opt/anaconda3/bin');
    assert.strictEqual(cleanEnv.HOME, '/Users/example');
    assert.strictEqual(cleanEnv.CLAUDE_CODE_OAUTH_TOKEN, 'preserved');
    assert.strictEqual(cleanEnv.CONDA_PREFIX, undefined);
    assert.strictEqual(cleanEnv.CONDA_DEFAULT_ENV, undefined);
    assert.strictEqual(cleanEnv.CONDA_SHLVL, undefined);
    assert.strictEqual(cleanEnv._CE_CONDA, undefined);
    const closeScript = closeMacTerminalScript('LLMPET Travel');
    assert(closeScript.includes('custom title of llmpetTab is "LLMPET Travel"'));
    assert(closeScript.includes('set llmpetBusy to llmpetBusy + 1'));
    assert(closeScript.includes('repeat with llmpetIndex from (count of windows) to 1 by -1'));
    assert(closeScript.includes('close llmpetWindow'));
    assert(closeScript.includes('return "closed:" & llmpetClosed'));
    assert.deepStrictEqual(travelCliPids([
      '  101 /Users/me/.local/bin/codex resume --sandbox read-only codex-trip',
      '  102 /Users/me/.local/bin/codex resume --sandbox read-only another-trip',
      '  103 /Applications/Codex.app/Contents/MacOS/Codex codex-trip',
      '  104 /Users/me/.local/bin/codex resume --sandbox read-only codex-trip',
    ].join('\n'), 'codex', 'codex-trip'), [101, 104]);
    assert.deepStrictEqual(travelCliPids(
      '  201 /opt/homebrew/bin/node /pkg/@anthropic-ai/claude-code/cli.js --resume claude-trip',
      'claude',
      'claude-trip',
    ), [201]);
  }
  console.log('  ✓ visible chat surfaces native web approval and keeps long prompts out of launcher commands');

  console.log('[TR2] provider usage parsing');
  const claudeParsed = parseClaudeOutput(JSON.stringify({
    type: 'result',
    result: 'Claude postcard',
    session_id: 'claude-trip',
    usage: {
      input_tokens: 1000,
      output_tokens: 300,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 100,
    },
  }));
  assert.strictEqual(claudeParsed.result, 'Claude postcard');
  assert.strictEqual(claudeParsed.usage.tokens, 1600);
  const codexOut = path.join(root, 'codex-postcard.txt');
  fs.writeFileSync(codexOut, 'Codex postcard');
  const codexParsed = parseCodexOutput([
    JSON.stringify({ type: 'thread.started', thread_id: 'codex-trip' }),
    JSON.stringify({ type: 'turn.completed', usage: {
      input_tokens: 2000, cached_input_tokens: 1200, output_tokens: 500,
    } }),
  ].join('\n'), codexOut);
  assert.strictEqual(codexParsed.result, 'Codex postcard');
  assert.strictEqual(codexParsed.usage.tokens, 2500);
  assert.strictEqual(codexParsed.usage.cachedInput, 1200);
  console.log('  ✓ Claude cache tokens are billed categories; Codex cache is a subset');

  console.log('[TR3] completed trip persists postcard, tokens, and growth');
  let capturedPrompt = '';
  let spawnCall = null;
  const visibleCalls = [];
  const closeCalls = [];
  const changes = [];
  const manager = createTravelManager({
    stateDir,
    findCli: (name) => `/fake/${name}`,
    launchCli: async (name, opts) => {
      visibleCalls.push({ name, opts });
      return { ok: true, terminal: 'fake-visible-terminal' };
    },
    closeCliTerminal: async (opts) => {
      closeCalls.push(opts);
      return { ok: true, status: 'closed' };
    },
    onChange: (event) => changes.push(event.type),
    visiblePollMs: 5,
    random: () => 0,
    spawn: (file, args, opts) => {
      spawnCall = { file, args, opts };
      const child = fakeChild((text) => { capturedPrompt += text; });
      process.nextTick(() => {
        child.emit('spawn');
        child.stdout.end(JSON.stringify({
          type: 'result',
          result: '带回来的明信片',
          usage: { input_tokens: 9000, output_tokens: 1000 },
        }));
        child.emit('close', 0, null);
      });
      return child;
    },
  });
  const started = await manager.start({
    agent: 'claude',
    cwd: project,
    project: 'travel-project',
    locale: 'zh',
    templateId: 'project-scout',
    mission: '看看最值得做什么',
  });
  assert.strictEqual(started.ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  const completed = manager.publicState('zh');
  assert.strictEqual(completed.active, null);
  assert.strictEqual(completed.latest.status, 'completed');
  assert.strictEqual(completed.latest.result, '带回来的明信片');
  assert.strictEqual(manager.publicPostcards(30)[0].result, '带回来的明信片');
  assert.strictEqual(manager.publicPostcards(30)[0].id, completed.latest.id);
  assert.strictEqual(completed.growth.totalTokens, 10000);
  assert.strictEqual(completed.growth.rank.leaf, 1);
  assert.strictEqual(spawnCall.file, '/fake/claude');
  assert.strictEqual(spawnCall.opts.cwd, project);
  assert(capturedPrompt.includes('看看最值得做什么'));
  assert.deepStrictEqual(changes.slice(0, 2), ['started', 'progress']);
  assert(changes.includes('completed'));
  assertPrivateFile(path.join(stateDir, 'travel.json'));
  console.log('  ✓ one 10k-token trip earns one leaf and survives restart');

  console.log('[TR3b] free wander reuses one durable Claude travel session');
  capturedPrompt = '';
  const wandered = await manager.start({
    agent: 'claude',
    mode: 'wander',
    templateId: 'free-roam',
    locale: 'zh',
  });
  assert.strictEqual(wandered.ok, true);
  const firstVisible = visibleCalls.at(-1);
  const wanderCwd = firstVisible.opts.cwd;
  assert.strictEqual(path.dirname(path.dirname(wanderCwd)), path.join(stateDir, 'wander-home'));
  assert.strictEqual(firstVisible.name, 'claude');
  assert.strictEqual(firstVisible.opts.terminalTitle, 'LLMPET Travel');
  assert.strictEqual(firstVisible.opts.keepOpen, false);
  assert.strictEqual(path.dirname(firstVisible.opts.promptFile), wanderCwd);
  assert(/^letter-[0-9a-f-]+\.txt$/.test(path.basename(firstVisible.opts.promptFile)));
  const firstPrompt = fs.readFileSync(firstVisible.opts.promptFile, 'utf8');
  assert(firstPrompt.includes('这一趟至少走完三站'));
  assert(firstPrompt.includes('只允许使用公开网页搜索和公开页面读取'));
  assert(!firstPrompt.includes(project));
  assert(!firstVisible.opts.args.includes(firstPrompt));
  assert.strictEqual(
    firstVisible.opts.args[firstVisible.opts.args.indexOf('--tools') + 1],
    'WebSearch,WebFetch',
  );
  assertPrivateFile(firstVisible.opts.promptFile);
  const sessionIdIndex = firstVisible.opts.args.indexOf('--session-id');
  const firstSessionId = firstVisible.opts.args[sessionIdIndex + 1];
  assert.strictEqual(manager.claimsSession(firstSessionId), true);
  assert.strictEqual(manager.claimsSession('ordinary-session'), false);
  const firstWanderResult = '我绕着一个关于旧地图的念头走了一圈。';
  const firstTranscript = path.join(wanderCwd, 'claude-visible.jsonl');
  fs.writeFileSync(firstTranscript, [
    JSON.stringify({ type: 'user', sessionId: firstSessionId, message: { content: '去闲逛' } }),
  ].join('\n'));
  const firstSession = {
    id: firstSessionId,
    cwd: wanderCwd,
    transcriptPath: firstTranscript,
    sourcePid: 900,
    pidChain: [901, 900],
  };
  assert.strictEqual(manager.observeActivity({
    agent: 'claude', session: firstSession, event: 'SessionStart',
  }), true);
  assert.strictEqual(firstSession.headless, false);
  assert.strictEqual(firstSession.sessionRole, 'travel');
  fs.appendFileSync(firstTranscript, '\n' + [
    JSON.stringify({
      type: 'assistant',
      sessionId: firstSessionId,
      message: {
        id: 'visible-message',
        content: [{ type: 'text', text: firstWanderResult }],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 30,
        },
      },
    }),
    JSON.stringify({
      type: 'system',
      subtype: 'stop_hook_summary',
      session_id: firstSessionId,
    }),
  ].join('\n'));
  firstSession.assistantLastOutput = firstWanderResult;
  manager.observeActivity({
    agent: 'claude',
    session: firstSession,
    event: 'Stop',
    realCompletion: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(manager.claimsSession(firstSessionId), true);
  const wanderedState = manager.publicState('zh');
  assert.strictEqual(wanderedState.latest.mode, 'wander');
  assert.strictEqual(wanderedState.latest.cwd, '');
  assert.strictEqual(wanderedState.latest.templateId, 'free-roam');
  assert.strictEqual(wanderedState.latest.wanderRouteId, 'far-window');
  assert.strictEqual(wanderedState.latest.wanderRouteLabel, '远方开窗');
  assert.strictEqual(wanderedState.latest.result, firstSession.assistantLastOutput);
  assert.strictEqual(wanderedState.latest.usage.tokens, 150);
  assert(closeCalls.some((call) => (
    call.terminalTitle === 'LLMPET Travel' &&
    call.processPid === null &&
    call.agent === 'claude' &&
    call.providerSessionId === firstSessionId
  )));
  assert(closeCalls.some((call) => (
    call.terminalTitle === 'LLMPET Travel' &&
    call.processPid === 901 &&
    call.agent === 'claude' &&
    call.providerSessionId === firstSessionId
  )));
  assert.deepStrictEqual(closeCalls.find((call) => call.processPid === 901), {
    terminalTitle: 'LLMPET Travel',
    processPid: 901,
    agent: 'claude',
    providerSessionId: firstSessionId,
  });
  assert.strictEqual(fs.existsSync(wanderCwd), true);
  const journalPath = path.join(stateDir, 'wander-home', 'journal.jsonl');
  assert.strictEqual(fs.existsSync(journalPath), true);
  assert(fs.readFileSync(journalPath, 'utf8').includes('旧地图'));
  const persistedTravel = JSON.parse(fs.readFileSync(path.join(stateDir, 'travel.json'), 'utf8'));
  assert.strictEqual(persistedTravel.providers.claude.cwd, wanderCwd);
  assert.strictEqual(fs.existsSync(firstVisible.opts.promptFile), false);
  assert.strictEqual(manager.trustWebForSession(firstSessionId), true);
  const wanderedAgain = await manager.start({
    agent: 'claude',
    mode: 'wander',
    templateId: 'free-roam',
    locale: 'zh',
  });
  assert.strictEqual(wanderedAgain.ok, true);
  const secondVisible = visibleCalls.at(-1);
  assert.strictEqual(secondVisible.opts.cwd, wanderCwd);
  assert.strictEqual(secondVisible.opts.keepOpen, false);
  assert(fs.readFileSync(secondVisible.opts.promptFile, 'utf8').includes('旧地图'));
  assert.strictEqual(wanderedAgain.trip.wanderRouteId, 'living-craft');
  assert.notStrictEqual(wanderedAgain.trip.wanderRouteId, wanderedState.latest.wanderRouteId);
  assert(secondVisible.opts.args.includes('--resume'));
  assert(secondVisible.opts.args.includes('--allowedTools'));
  const secondSessionId = secondVisible.opts.args[secondVisible.opts.args.indexOf('--resume') + 1];
  assert.strictEqual(secondSessionId, firstSessionId);
  manager.observeActivity({
    agent: 'claude',
    session: {
      id: secondSessionId,
      cwd: secondVisible.opts.cwd,
      assistantLastOutput: '这次我想到了一盏总为陌生人亮着的灯。',
    },
    event: 'Stop',
    realCompletion: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert(closeCalls.length >= 4);
  console.log('  ✓ the same Claude mailbox resumes and remembered web approval is applied');

  const handoffCalls = [];
  const handoffManager = createTravelManager({
    stateDir: path.join(root, 'handoff-state'),
    findCli: (name) => `/fake/${name}`,
    launchCli: async (name, opts) => {
      handoffCalls.push({ name, opts });
      return { ok: true, terminal: 'fake-visible-terminal' };
    },
    closeCliTerminal: async () => ({ ok: true, status: 'closed' }),
    visiblePollMs: 5,
    random: () => 0,
  });
  const codexWander = await handoffManager.start({
    agent: 'codex',
    mode: 'wander',
    templateId: 'free-roam',
    locale: 'zh',
  });
  assert.strictEqual(codexWander.ok, true);
  assert.strictEqual(handoffCalls.at(-1).opts.keepOpen, false);
  handoffManager.observeActivity({
    agent: 'codex',
    session: {
      id: 'codex-handoff-session',
      cwd: handoffCalls.at(-1).opts.cwd,
      assistantLastOutput: 'Codex 回来了。',
      sourcePid: 910,
      pidChain: [911, 910],
    },
    event: 'Stop',
    realCompletion: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const claudeAfterCodex = await handoffManager.start({
    agent: 'claude',
    mode: 'wander',
    templateId: 'free-roam',
    locale: 'zh',
  });
  assert.strictEqual(claudeAfterCodex.ok, true);
  assert.strictEqual(handoffCalls.at(-1).name, 'claude');
  assert.strictEqual(handoffCalls.at(-1).opts.keepOpen, false);
  assert.notStrictEqual(handoffCalls.at(-1).opts.cwd, handoffCalls[0].opts.cwd);
  handoffManager.cancel();
  await new Promise((resolve) => setImmediate(resolve));
  const codexAgain = await handoffManager.start({
    agent: 'codex',
    mode: 'wander',
    templateId: 'free-roam',
    locale: 'zh',
  });
  assert.strictEqual(codexAgain.ok, true);
  const codexResume = handoffCalls.at(-1);
  assert.strictEqual(codexResume.name, 'codex');
  assert.strictEqual(codexResume.opts.args[0], 'resume');
  assert(codexResume.opts.args.includes('codex-handoff-session'));
  handoffManager.cancel();
  await new Promise((resolve) => setImmediate(resolve));
  console.log('  ✓ Claude/Codex mailboxes are isolated and Codex resumes its own session');

  const restored = createTravelManager({ stateDir, spawn: () => { throw new Error('should not spawn'); } });
  assert(restored.publicState('en').latest.result.includes('一盏'));
  assert.strictEqual(restored.publicState('en').templates[0].label, 'Project scout');

  console.log('[TR4] v1 travel state migrates without losing history or growth');
  const legacyStateDir = path.join(root, 'legacy-state');
  const legacyTripId = 'legacy-trip';
  const legacyCwd = path.join(legacyStateDir, 'wander-home', 'trips', legacyTripId);
  fs.mkdirSync(legacyCwd, { recursive: true });
  fs.writeFileSync(path.join(legacyStateDir, 'travel.json'), JSON.stringify({
    schemaVersion: 1,
    active: null,
    history: [{
      id: legacyTripId,
      agent: 'claude',
      mode: 'wander',
      providerSessionId: '33333333-3333-4333-8333-333333333333',
      status: 'completed',
      result: '旧明信片',
      startedAt: 10,
      endedAt: 20,
    }],
    growth: { totalTokens: 4321, completed: 1, failed: 0, cancelled: 0 },
  }));
  const migrated = createTravelManager({ stateDir: legacyStateDir });
  assert.strictEqual(migrated.publicState('zh').schemaVersion, 2);
  assert.strictEqual(migrated.publicState('zh').latest.result, '旧明信片');
  assert.strictEqual(migrated.publicState('zh').growth.totalTokens, 4321);
  assert.strictEqual(migrated._state.providers.claude.sessionId, '33333333-3333-4333-8333-333333333333');
  assert.strictEqual(migrated._state.providers.claude.cwd, legacyCwd);
  const migratedCard = {
    id: '33333333-3333-4333-8333-333333333333',
    headless: true,
    state: 'sleeping',
    ended: true,
  };
  assert.strictEqual(migrated.decorateSession(migratedCard, 'claude'), true);
  assert.strictEqual(migratedCard.headless, false);
  assert.strictEqual(migratedCard.state, 'idle');
  assert.strictEqual(migratedCard.ended, false);
  console.log('  ✓ v1 history/growth survive and the old Claude conversation becomes the mailbox');

  console.log('[TR5] one trip at a time and cancellation');
  let liveChild = null;
  const cancelState = path.join(root, 'cancel-state');
  const cancelManager = createTravelManager({
    stateDir: cancelState,
    findCli: () => '/fake/codex',
    spawn: () => {
      liveChild = fakeChild(() => {});
      process.nextTick(() => liveChild.emit('spawn'));
      return liveChild;
    },
  });
  const live = await cancelManager.start({
    agent: 'codex',
    cwd: project,
    project: 'cancel-project',
    locale: 'en',
    mission: 'read only',
  });
  assert.strictEqual(live.ok, true);
  const duplicate = await cancelManager.start({
    agent: 'claude',
    cwd: project,
    mission: 'another trip',
  });
  assert.strictEqual(duplicate.code, 'busy');
  assert.strictEqual(cancelManager.cancel().ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(cancelManager.publicState('en').latest.status, 'cancelled');
  assert.strictEqual(cancelManager.publicState('en').growth.cancelled, 1);
  assert.deepStrictEqual(cancelManager.publicPostcards(30), []);
  console.log('  ✓ concurrent departure is rejected and cancel closes the active trip');

  console.log('[TR6] timeout is recorded as a failure, not a user cancellation');
  let timeoutChild = null;
  const timeoutManager = createTravelManager({
    stateDir: path.join(root, 'timeout-state'),
    timeoutMs: 5,
    findCli: () => '/fake/codex',
    spawn: () => {
      timeoutChild = fakeChild(() => {});
      process.nextTick(() => timeoutChild.emit('spawn'));
      return timeoutChild;
    },
  });
  const timed = await timeoutManager.start({
    agent: 'codex',
    cwd: project,
    project: 'timeout-project',
    locale: 'en',
    mission: 'take too long',
  });
  assert.strictEqual(timed.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.strictEqual(timeoutManager.publicState('en').latest.status, 'failed');
  assert.strictEqual(timeoutManager.publicState('en').growth.failed, 1);
  assert.strictEqual(timeoutManager.publicState('en').growth.cancelled, 0);
  assert.deepStrictEqual(timeoutManager.publicPostcards(30), []);
  console.log('  ✓ timeout remains distinguishable from an explicit cancel');

  const rank = rankFor(850000);
  assert.deepStrictEqual(
    { sun: rank.sun, moon: rank.moon, star: rank.star, leaf: rank.leaf },
    { sun: 1, moon: 1, star: 1, leaf: 1 },
  );
  console.log('[TR7] 4 leaves → star, 4 stars → moon, 4 moons → sun');
  console.log('  ✓ QQ-style rank conversion is deterministic');

  console.log('[TR8] local Claude + Codex usage → one machine rank');
  const local = machineGrowth(
    { lifetime: { tokens: 6980000000 } },
    { lifetime: { tokens: 1990000000 } },
  );
  assert.strictEqual(local.totalTokens, 8970000000);
  assert.strictEqual(local.claudeTokens, 6980000000);
  assert.strictEqual(local.codexTokens, 1990000000);
  assert.strictEqual(local.rank.unitTokens, MACHINE_RANK_UNIT_TOKENS);
  assert.strictEqual(local.rank.crown, 3);
  assert.strictEqual(local.rank.sun, 2);
  assert.strictEqual(local.rank.leaf, 1);
  console.log('  ✓ provider lifetimes merge once and use the ten-million-token ladder');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('\ntravel checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
