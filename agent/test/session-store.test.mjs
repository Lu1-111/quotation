import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendServiceError } from '../protocol.mjs';
import {
  builtinPricingEngine,
  createSessionStore,
  retractFact,
} from '../session-store.mjs';
import { buildTurnContext } from '../context-builder.mjs';
import { buildTurnUserPrompt, buildVerifiedFactsBlock } from '../turn-prompts.mjs';
import { DatabaseSync } from 'node:sqlite';

function assertBackendError(fn, expectedCode, expectedStatus) {
  assert.throws(
    fn,
    (err) => {
      assert.ok(err instanceof BackendServiceError, `期望 BackendServiceError，实际收到 ${err}`);
      assert.equal(err.code, expectedCode);
      assert.equal(err.status, expectedStatus);
      return true;
    },
  );
}

test('会话隔离：跨用户读写拒绝（403）与 demo / real 模式混用拒绝（403）', () => {
  const store = createSessionStore(':memory:');
  try {
    const demoSession = store.createSession({
      ownerId: 'user_alice',
      dataMode: 'demo',
      lockedSnapshotId: 'snap_demo_1',
      initialEvidence: [
        {
          evidenceId: 'ev_init_1',
          sourceType: 'collection_record',
          author: '林行',
          attribution: 'other_author',
          excerpt: '通过推荐页发现过小众乐队。',
          textKind: 'full_text',
          snapshotId: 'snap_demo_1',
        },
      ],
    });

    const realSession = store.createSession({
      ownerId: 'user_alice',
      dataMode: 'real',
      lockedSnapshotId: 'snap_real_1',
    });

    assert.equal(demoSession.graphVersion, 0);
    assert.equal(demoSession.dataMode, 'demo');
    assert.equal(demoSession.evidenceIndex.length, 1);

    // 不存在的会话返回 404
    assertBackendError(
      () => store.getSession('user_alice', 'sess_nonexistent'),
      'SESSION_NOT_FOUND',
      404,
    );

    // 跨用户访问会话、发轮次、读事件、取消均返回 403 SESSION_FORBIDDEN
    assertBackendError(
      () => store.getSession('user_bob', demoSession.sessionId),
      'SESSION_FORBIDDEN',
      403,
    );
    assertBackendError(
      () =>
        store.beginTurn('user_bob', demoSession.sessionId, {
          clientRequestId: 'req_bob_1',
          baseGraphVersion: 0,
          text: '试图越权写入',
        }),
      'SESSION_FORBIDDEN',
      403,
    );

    const { turn } = store.beginTurn('user_alice', demoSession.sessionId, {
      clientRequestId: 'req_alice_1',
      baseGraphVersion: 0,
      text: '推荐算法只会让人的兴趣越来越窄。',
      expectedDataMode: 'demo',
    });
    store.appendTurnEvent(demoSession.sessionId, turn.turnId, 'turn.started', {
      turnId: turn.turnId,
    });

    assertBackendError(
      () => store.listTurnEvents('user_bob', demoSession.sessionId, turn.turnId),
      'SESSION_FORBIDDEN',
      403,
    );
    assertBackendError(
      () => store.cancelTurn('user_bob', demoSession.sessionId, turn.turnId),
      'SESSION_FORBIDDEN',
      403,
    );

    // 同一用户名下 demo 与 real 模式严格隔离，混用返回 403 DATA_MODE_MISMATCH
    assertBackendError(
      () =>
        store.getSession('user_alice', demoSession.sessionId, {
          expectedDataMode: 'real',
        }),
      'DATA_MODE_MISMATCH',
      403,
    );
    assertBackendError(
      () =>
        store.beginTurn('user_alice', realSession.sessionId, {
          clientRequestId: 'req_mode_wrong',
          baseGraphVersion: 0,
          text: '用 demo 模式请求 real 会话',
          expectedDataMode: 'demo',
        }),
      'DATA_MODE_MISMATCH',
      403,
    );
    assertBackendError(
      () =>
        store.listTurnEvents('user_alice', demoSession.sessionId, turn.turnId, {
          expectedDataMode: 'real',
        }),
      'DATA_MODE_MISMATCH',
      403,
    );
  } finally {
    store.close();
  }
});

test('写入锁与乐观并发：幂等重试复用 turnId、同键换内容 409、并发双标签页 409、过期版本 409', () => {
  const store = createSessionStore(':memory:');
  try {
    const session = store.createSession({ ownerId: 'user_1', dataMode: 'demo' });

    const first = store.beginTurn('user_1', session.sessionId, {
      clientRequestId: 'req_1',
      baseGraphVersion: 0,
      text: '  推荐算法只会让人的兴趣越来越窄。  ',
      focusRef: { kind: 'quantifier', span: '只会' },
    });
    assert.equal(first.reused, false);
    assert.equal(first.turn.turnId, 'turn_1');
    assert.equal(first.turn.status, 'running');

    // 1. 同一 clientRequestId 且规范化指纹一致（含前后空格差异、键顺序差异）时幂等复用原轮次
    const retryWhileRunning = store.beginTurn('user_1', session.sessionId, {
      clientRequestId: 'req_1',
      baseGraphVersion: 0,
      text: '推荐算法只会让人的兴趣越来越窄。',
      focusRef: { span: '只会', kind: 'quantifier' },
    });
    assert.equal(retryWhileRunning.reused, true);
    assert.equal(retryWhileRunning.turn.turnId, 'turn_1');

    // 2. 同一 clientRequestId 换文本或换 baseGraphVersion 返回 409 CLIENT_REQUEST_ID_CONFLICT
    assertBackendError(
      () =>
        store.beginTurn('user_1', session.sessionId, {
          clientRequestId: 'req_1',
          baseGraphVersion: 0,
          text: '换了一句不同的话',
          focusRef: { kind: 'quantifier', span: '只会' },
        }),
      'CLIENT_REQUEST_ID_CONFLICT',
      409,
    );

    // 3. 第二个浏览器标签页在 turn_1 尚未结束时并发写入，返回 409 TURN_IN_PROGRESS
    assertBackendError(
      () =>
        store.beginTurn('user_1', session.sessionId, {
          clientRequestId: 'req_tab2',
          baseGraphVersion: 0,
          text: '另一个标签页并发提交',
        }),
      'TURN_IN_PROGRESS',
      409,
    );

    // 提交第一轮并修改图，使 graphVersion 从 0 升至 1
    const commitRes = store.commitTurn(session.sessionId, 'turn_1', {
      intent: 'provide_self_fact',
      graphMutated: true,
      addedFacts: [
        {
          id: 'fact_1',
          kind: 'fact',
          text: '本人通过推荐发现过新乐队',
        },
      ],
      graphPatch: {
        upsertNodes: [
          {
            id: 'node_1',
            text: '推荐曾拓宽过本人的音乐范围',
            cluster: 1,
            deps: [],
            sourceFactIds: ['fact_1'],
          },
        ],
      },
    });
    assert.equal(commitRes.committed, true);
    assert.equal(commitRes.graphVersion, 1);

    // 已提交后用原 clientRequestId 重试仍幂等返回原 turn_1，不报版本过期
    const retryAfterCommit = store.beginTurn('user_1', session.sessionId, {
      clientRequestId: 'req_1',
      baseGraphVersion: 0,
      text: '推荐算法只会让人的兴趣越来越窄。',
      focusRef: { kind: 'quantifier', span: '只会' },
    });
    assert.equal(retryAfterCommit.reused, true);
    assert.equal(retryAfterCommit.turn.turnId, 'turn_1');
    assert.equal(retryAfterCommit.turn.status, 'committed');

    // 4. 新请求携带过期的 baseGraphVersion: 0 返回 409 STALE_GRAPH_VERSION 并附带 currentGraphVersion: 1
    assert.throws(
      () =>
        store.beginTurn('user_1', session.sessionId, {
          clientRequestId: 'req_stale',
          baseGraphVersion: 0,
          text: '基于旧版本继续改图',
        }),
      (err) => {
        assert.equal(err.code, 'STALE_GRAPH_VERSION');
        assert.equal(err.status, 409);
        assert.deepEqual(err.details, { currentGraphVersion: 1 });
        return true;
      },
    );
  } finally {
    store.close();
  }
});

test('版本规则与同图同分母算价：只问出处不递增 graphVersion；改图递增版本并自动重算原句与改写（含实施方案 2.9 算例）', () => {
  // 同时验证内置兜底算价器与默认 quotation-engine 100% 一致
  for (const engineOption of [null, builtinPricingEngine]) {
    const store = createSessionStore(':memory:', { pricingEngine: engineOption });
    try {
      const session = store.createSession({ ownerId: 'user_calc', dataMode: 'demo' });

      // 第 1 轮：构建实施方案第 2 节标准算例图 A->B->C, D->E（承重依次 2, 1, 0, 1, 0，总分母 4）
      const t1 = store.beginTurn('user_calc', session.sessionId, {
        clientRequestId: 'c_1',
        baseGraphVersion: 0,
        text: '推荐算法只会让人的兴趣越来越窄。',
      });
      store.commitTurn(session.sessionId, t1.turn.turnId, {
        intent: 'analyze_statement',
        graphMutated: true,
        confirmedGraph: [
          { id: 'A', text: '根判断 A', cluster: 'c1', deps: [] },
          { id: 'B', text: '中间判断 B', cluster: 'c1', deps: ['A'] },
          { id: 'C', text: '叶判断 C', cluster: 'c1', deps: ['B'] },
          { id: 'D', text: '根判断 D', cluster: 'c2', deps: [] },
          { id: 'E', text: '叶判断 E', cluster: 'c2', deps: ['D'] },
        ],
        upsertedStatements: [
          {
            statementId: 'stmt_original',
            role: 'original',
            text: '原句：直接冲突于 A',
            assessment: 'conflict',
            directConflicts: ['A'],
            conflictReasons: [{ nodeId: 'A', reason: '与根判断 A 直接冲突' }],
          },
          {
            statementId: 'stmt_rewrite_b',
            role: 'rewrite',
            text: '改写一：只直接冲突于 B',
            assessment: 'conflict',
            directConflicts: ['B'],
            conflictReasons: [{ nodeId: 'B', reason: '与中间判断 B 冲突' }],
          },
          {
            statementId: 'stmt_rewrite_leaf',
            role: 'rewrite',
            text: '改写二：只冲突于承重为 0 的叶节点 C',
            assessment: 'conflict',
            directConflicts: ['C'],
            conflictReasons: [{ nodeId: 'C', reason: '仅与叶节点 C 冲突' }],
          },
          {
            statementId: 'stmt_rewrite_pending',
            role: 'rewrite',
            text: '改写三：缺乏证据的收窄版本',
            assessment: 'insufficient_evidence',
            directConflicts: [],
          },
        ],
      });

      let snap = store.getSession('user_calc', session.sessionId);
      assert.equal(snap.graphVersion, 1);
      assert.equal(snap.confirmedGraph.totalWeight, 4);

      const qOrig = snap.statements.find((s) => s.statementId === 'stmt_original').quote;
      const qRewB = snap.statements.find((s) => s.statementId === 'stmt_rewrite_b').quote;
      const qLeaf = snap.statements.find((s) => s.statementId === 'stmt_rewrite_leaf').quote;
      const qUnk = snap.statements.find((s) => s.statementId === 'stmt_rewrite_pending').quote;

      // 冲突 A：A(2)+B(1)+C(0) = 3/4 = 75%
      assert.equal(qOrig.rate, 75);
      assert.equal(qOrig.numerator, 3);
      assert.equal(qOrig.denominator, 4);
      assert.deepEqual(qOrig.affectedNodeIds, ['A', 'B', 'C']);

      // 冲突 B：B(1)+C(0) = 1/4 = 25%
      assert.equal(qRewB.rate, 25);
      assert.equal(qRewB.numerator, 1);
      assert.equal(qRewB.denominator, 4);
      assert.deepEqual(qRewB.affectedNodeIds, ['B', 'C']);

      // 冲突叶节点 C：比例为 0，但仍保留 conflict 判断与直接冲突 C
      assert.equal(qLeaf.assessment, 'conflict');
      assert.equal(qLeaf.rate, 0);
      assert.deepEqual(qLeaf.directConflicts, ['C']);

      // 证据不足：rate 为 null，不预设降分
      assert.equal(qUnk.assessment, 'insufficient_evidence');
      assert.equal(qUnk.rate, null);
      assert.equal(qUnk.denominator, 4);

      // 第 2 轮：只问“这是谁说的 / 为何拆只会”，保存轮次与事件，但不递增 graphVersion！
      const t2 = store.beginTurn('user_calc', session.sessionId, {
        clientRequestId: 'c_2',
        baseGraphVersion: 1,
        text: '这是谁说的？为什么要拆“只会”？',
      });
      store.appendTurnEvent(session.sessionId, t2.turn.turnId, 'text.delta', {
        delta: '这条材料来自你收藏的林行回答，并非你本人的表达。',
      });
      const c2 = store.commitTurn(session.sessionId, t2.turn.turnId, {
        intent: 'explain_focus_or_provenance',
        graphMutated: false,
      });
      assert.equal(c2.graphVersion, 1);
      assert.equal(c2.committedPayload.graphMutated, false);

      snap = store.getSession('user_calc', session.sessionId);
      assert.equal(snap.graphVersion, 1);
      assert.equal(snap.turns.length, 2);
      assert.equal(snap.turns[1].responseText, '这条材料来自你收藏的林行回答，并非你本人的表达。');

      // 第 3 轮：新增节点 F 依赖 [B, D]（测试“恰好保留一半依据继续成立”及全量重算同图同分母）
      // 加入 F(deps:['B','D']) 后：A:3(B,C,F), B:2(C,F), C:0, D:2(E,F), E:0, F:0 -> 总分母 = 7
      // 当只冲突 B 时，F 的依赖 [B, D] 存活 D（1/2 = 0.5 >= 0.5），F 不坍塌！受影响仍只有 [B, C]，分子 = S(B)+S(C) = 2+0 = 2，报价 round(200/7) = 29%
      const t3 = store.beginTurn('user_calc', session.sessionId, {
        clientRequestId: 'c_3',
        baseGraphVersion: 1,
        text: '补充一条同时建立在 B 和 D 上的判断 F',
      });
      store.commitTurn(session.sessionId, t3.turn.turnId, {
        intent: 'provide_self_fact',
        graphPatch: {
          upsertNodes: [{ id: 'F', text: '双支柱判断 F', cluster: 'c2', deps: ['B', 'D'] }],
        },
      });

      snap = store.getSession('user_calc', session.sessionId);
      assert.equal(snap.graphVersion, 2);
      assert.equal(snap.confirmedGraph.totalWeight, 7);

      for (const s of snap.statements) {
        assert.equal(s.quote.graphVersion, 2);
        assert.equal(s.quote.denominator, 7);
      }
      const qRewBAfter = snap.statements.find((s) => s.statementId === 'stmt_rewrite_b').quote;
      assert.deepEqual(qRewBAfter.affectedNodeIds, ['B', 'C']); // F 恰好保留一半依据，继续成立！
      assert.equal(qRewBAfter.numerator, 2);
      assert.equal(qRewBAfter.rate, 29);
    } finally {
      store.close();
    }
  }
});

test('取消、失败与进程重启恢复：提交竞态仲裁、待分析新句失败状态保留、running 恢复为 interrupted 及 Last-Event-ID 续接重放', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'quotation-session-store-test-'));
  const dbPath = join(tempDir, 'nested', 'sessions.sqlite');

  try {
    const store1 = createSessionStore(dbPath);
    const session = store1.createSession({ ownerId: 'user_stream', dataMode: 'demo' });

    const liveReceived = [];

    // 第 1 轮：正常流式事件 + 原子提交
    const { turn: turn1 } = store1.beginTurn('user_stream', session.sessionId, {
      clientRequestId: 's_1',
      baseGraphVersion: 0,
      text: '本人确认：推荐页让我发现过好几支后摇乐队。',
    });
    const unsub1 = store1.subscribeTurnEvents(session.sessionId, turn1.turnId, (ev) => {
      liveReceived.push(ev);
    });

    store1.appendTurnEvent(session.sessionId, turn1.turnId, 'turn.started', { turnId: turn1.turnId });
    store1.appendTurnEvent(session.sessionId, turn1.turnId, 'focus.selected', {
      kind: 'quantifier',
      span: '只会',
    });
    store1.appendTurnEvent(session.sessionId, turn1.turnId, 'text.delta', { delta: '已记录你的经历。' });

    const commit1 = store1.commitTurn(session.sessionId, turn1.turnId, {
      intent: 'provide_self_fact',
      graphMutated: true,
      addedFacts: [{ id: 'fact_postrock', kind: 'fact', text: '发现过后摇乐队' }],
      graphPatch: {
        upsertNodes: [
          { id: 'n_root', text: '发现过后摇乐队', cluster: 1, deps: [], sourceFactIds: ['fact_postrock'] },
          { id: 'n_child', text: '推荐能够拓宽音乐视野', cluster: 1, deps: ['n_root'] },
        ],
      },
      upsertedStatements: [
        {
          statementId: 'stmt_original',
          role: 'original',
          text: '推荐算法只会让人的兴趣越来越窄。',
          assessment: 'conflict',
          directConflicts: ['n_root'],
        },
      ],
    });
    unsub1();

    assert.equal(commit1.outcome, 'committed');
    assert.equal(liveReceived.length, 5);
    assert.deepEqual(
      liveReceived.map((e) => e.id),
      [1, 2, 3, 4, 5],
    );
    assert.equal(liveReceived[3].event, 'turn.committed');
    assert.equal(liveReceived[4].event, 'turn.done');

    // 竞态 1：已 committed 的轮次再收到 cancelTurn，绝不回退，返回 outcome: 'committed'
    const cancelAfterCommit = store1.cancelTurn('user_stream', session.sessionId, turn1.turnId);
    assert.equal(cancelAfterCommit.outcome, 'committed');
    assert.equal(cancelAfterCommit.cancelled, false);

    // 第 2 轮：提交前主动取消，保留 graphVersion = 1，随后迟到的 commitTurn 绝不覆盖 cancelled
    const { turn: turn2 } = store1.beginTurn('user_stream', session.sessionId, {
      clientRequestId: 's_2',
      baseGraphVersion: 1,
      text: '正在生成的第二轮被用户点击停止',
    });
    const cancelRes = store1.cancelTurn('user_stream', session.sessionId, turn2.turnId, {
      reason: '用户点击停止按钮',
    });
    assert.equal(cancelRes.outcome, 'cancelled');
    assert.equal(cancelRes.cancelled, true);
    assert.equal(cancelRes.sessionGraphVersion, 1);

    const lateCommit = store1.commitTurn(session.sessionId, turn2.turnId, {
      intent: 'provide_self_fact',
      graphMutated: true,
      graphPatch: {
        upsertNodes: [{ id: 'n_illegal', text: '不应落库的节点', cluster: 1, deps: [] }],
      },
    });
    assert.equal(lateCommit.outcome, 'cancelled');
    assert.equal(lateCommit.committed, false);
    assert.equal(store1.getSession('user_stream', session.sessionId).graphVersion, 1);

    // 第 3 轮：模型超时失败 failTurn，保留已确认图与原句报价，待分析新句有明确 pendingStatus
    const { turn: turn3 } = store1.beginTurn('user_stream', session.sessionId, {
      clientRequestId: 's_3',
      baseGraphVersion: 1,
      text: '新改写：连续听同风格歌后推荐会变窄',
    });
    const failRes = store1.failTurn(
      session.sessionId,
      turn3.turnId,
      { code: 'TIMEOUT', message: '模型流式响应超时' },
      {
        pendingStatement: {
          statementId: 'stmt_rewrite_timeout',
          role: 'rewrite',
          text: '连续听同风格歌后推荐会变窄',
        },
      },
    );
    assert.equal(failRes.outcome, 'failed');
    const afterFailSnap = store1.getSession('user_stream', session.sessionId);
    assert.equal(afterFailSnap.graphVersion, 1);
    assert.equal(afterFailSnap.statements[0].quote.rate, 100);
    const pendingStmt = afterFailSnap.statements.find(
      (s) => s.statementId === 'stmt_rewrite_timeout',
    );
    assert.equal(pendingStmt.assessment, 'insufficient_evidence');
    assert.equal(pendingStmt.pendingStatus, 'TIMEOUT');
    assert.equal(pendingStmt.quote.rate, null);

    // 第 4 轮：模拟进程在 running 阶段崩溃（未提交直接关闭进程重开 SQLite）
    const { turn: turn4 } = store1.beginTurn('user_stream', session.sessionId, {
      clientRequestId: 's_4',
      baseGraphVersion: 1,
      text: '崩溃前未完成的轮次',
    });
    store1.appendTurnEvent(session.sessionId, turn4.turnId, 'turn.started', { turnId: turn4.turnId });
    store1.close();

    // 重启服务：重新打开同一磁盘 SQLite 文件
    const store2 = createSessionStore(dbPath);
    try {
      const recoveredSnap = store2.getSession('user_stream', session.sessionId);
      assert.equal(recoveredSnap.activeTurnId, null);
      assert.equal(recoveredSnap.graphVersion, 1);

      const t4Summary = recoveredSnap.turns.find((t) => t.turnId === turn4.turnId);
      assert.equal(t4Summary.status, 'interrupted');

      const t4Events = store2.listTurnEvents('user_stream', session.sessionId, turn4.turnId);
      assert.equal(t4Events.at(-2).event, 'turn.failed');
      assert.equal(t4Events.at(-2).data.status, 'interrupted');
      assert.equal(t4Events.at(-1).event, 'turn.done');

      // 已 committed 的 turn_1 在重启后既能完整重放，也能按 Last-Event-ID (afterSeq: 3) 精确续接
      const replayedTail = store2.listTurnEvents('user_stream', session.sessionId, turn1.turnId, {
        afterSeq: 3,
      });
      assert.equal(replayedTail.length, 2);
      assert.equal(replayedTail[0].id, 4);
      assert.equal(replayedTail[0].event, 'turn.committed');
      assert.deepEqual(replayedTail[0].data, commit1.committedPayload);
      assert.equal(replayedTail[1].id, 5);
      assert.equal(replayedTail[1].event, 'turn.done');

      // 重启恢复后会话可立即开启下一轮写入
      const { turn: turn5 } = store2.beginTurn('user_stream', session.sessionId, {
        clientRequestId: 's_5',
        baseGraphVersion: 1,
        text: '重启后继续正常对话',
      });
      assert.equal(turn5.turnId, 'turn_5');
      assert.equal(turn5.status, 'running');
    } finally {
      store2.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('十二轮贯穿撤回与局部上下文：第 10 轮撤回第 6 轮条件仅失效依赖结论，保留第 4 轮独立事实与否认归属，context-builder 有界裁剪并按早期引用取回', () => {
  const store = createSessionStore(':memory:');
  try {
    // 准备 12 条证据（测试 maxEvidence 有界裁剪）
    const initialEvidence = Array.from({ length: 12 }, (_, idx) => ({
      evidenceId: `ev_mat_${idx + 1}`,
      sourceType: 'collection_record',
      author: idx === 0 ? '林行' : `作者_${idx + 1}`,
      attribution: idx === 0 ? 'self' : 'other_author', // 第 1 条初始被候选误标，第 3 轮将被本人否认归属
      excerpt:
        idx === 0
          ? '收藏回答：我在推荐页刷到过一支很喜欢的器乐摇滚乐队。'
          : `背景阅读材料片段 #${idx + 1}：关于音乐流媒体的一般性讨论。`,
      textKind: 'summary',
      snapshotId: 'snap_12turns',
    }));

    const session = store.createSession({
      ownerId: 'user_12turns',
      dataMode: 'demo',
      lockedSnapshotId: 'snap_12turns',
      initialEvidence,
    });

    const runTurn = (turnIdx, userText, commitSpec) => {
      const snap = store.getSession('user_12turns', session.sessionId);
      const { turn } = store.beginTurn('user_12turns', session.sessionId, {
        clientRequestId: `req_turn_${turnIdx}`,
        baseGraphVersion: snap.graphVersion,
        text: userText,
      });
      store.appendTurnEvent(session.sessionId, turn.turnId, 'turn.started', { turnId: turn.turnId });
      const res = store.commitTurn(session.sessionId, turn.turnId, commitSpec);
      return res;
    };

    // 第 1 轮：输入原句（尚无本人确认节点，保持未定）
    runTurn(1, '推荐算法只会让人的兴趣越来越窄。', {
      intent: 'analyze_statement',
      focus: { kind: 'quantifier', span: '只会', reason: '绝对化全称量词只需一个本人反例即可证伪' },
      responseText: '我们先核对“只会”这个绝对量词。',
      upsertedStatements: [
        {
          statementId: 'stmt_original',
          role: 'original',
          text: '推荐算法只会让人的兴趣越来越窄。',
          assessment: 'insufficient_evidence',
          directConflicts: [],
        },
      ],
    });

    // 第 2 轮：追问为何拆“只会”（只读轮次，不改图）
    runTurn(2, '为什么要先拆“只会”？', {
      intent: 'explain_focus_or_provenance',
      graphMutated: false,
      responseText: '因为“只会”排除了任何拓宽兴趣的例外。',
    });

    // 第 3 轮：指出候选反例 ev_mat_1 是收藏的他人回答，本人否认归属
    runTurn(3, 'ev_mat_1 是我收藏的林行回答，不是我本人说的。', {
      intent: 'deny_attribution',
      graphMutated: false,
      deniedAttributions: [
        {
          evidenceId: 'ev_mat_1',
          originalAuthor: '林行',
          reason: '收藏的他人回答，非本人观点',
        },
      ],
      responseText: '已记录 ev_mat_1 作者为林行，后续不再归于你本人。',
    });

    // 验证即使后续再次重复命中同一材料并试图标为 self，否认归属依然生效！
    store.upsertEvidence(session.sessionId, [
      {
        evidenceId: 'ev_mat_1',
        sourceType: 'collection_record',
        author: 'self',
        attribution: 'self',
        excerpt: '收藏回答：我在推荐页刷到过一支很喜欢的器乐摇滚乐队。',
        textKind: 'summary',
      },
    ]);
    assert.equal(store.getEvidenceMap(session.sessionId).get('ev_mat_1').attribution, 'other_author');
    assert.equal(store.getEvidenceMap(session.sessionId).get('ev_mat_1').author, '林行');

    // 第 4 轮：本人提供独立事实“我自己确实通过推荐发现过新乐队” -> 图版本 0 -> 1
    runTurn(4, '不过我自己确实通过推荐页发现过新乐队。', {
      intent: 'provide_self_fact',
      verifiedEvidence: [
        {
          evidenceId: 'ev_turn_4',
          sourceType: 'session_turn',
          author: 'user_12turns',
          attribution: 'self',
          excerpt: '我自己确实通过推荐页发现过新乐队。',
          turnId: 'turn_4',
          textKind: 'user_utterance',
        },
      ],
      addedFacts: [
        {
          id: 'fact_turn4_band',
          kind: 'fact',
          text: '本人确实通过推荐页发现过新乐队',
          evidenceIds: ['ev_turn_4'],
          supportsDescription: '直接构成“推荐只会让人变窄”的本人反例',
        },
      ],
      graphPatch: {
        upsertNodes: [
          {
            id: 'node_band_exp',
            text: '本人曾通过推荐发现新乐队',
            cluster: 1,
            deps: [],
            evidenceIds: ['ev_turn_4'],
            sourceFactIds: ['fact_turn4_band'],
          },
          {
            id: 'node_can_widen',
            text: '推荐在本人经历中有过拓宽口味的作用',
            cluster: 1,
            deps: ['node_band_exp'],
            evidenceIds: ['ev_turn_4'],
          },
        ],
      },
      upsertedStatements: [
        {
          statementId: 'stmt_original',
          assessment: 'conflict',
          directConflicts: ['node_band_exp'],
          conflictReasons: [{ nodeId: 'node_band_exp', reason: '与本人发现新乐队的经历直接冲突' }],
        },
      ],
      responseText: '已确认你本人的反例经历，原句触发冲突。',
    });

    // 第 5 轮：请 Agent 检查“刚开始用的时候”这一条件（暂入待确认区，不改确认图）
    runTurn(5, '帮我检查一下“只发生在刚开始用的时候”这个条件。', {
      intent: 'check_or_confirm_condition',
      graphMutated: false,
      pendingConfirmations: [
        { id: 'pend_cond_early', text: '拓宽口味只发生在刚开始使用推荐的阶段' },
      ],
      responseText: '如果加上这一适用阶段限定，可以区分初期探索与长期收窄。是否确认该范围？',
    });

    // 第 6 轮：本人确认“只发生在刚开始用的时候”限定条件 -> 新增依赖该条件的阶段性结论节点，图版本 1 -> 2
    runTurn(6, '我确认，那确实只发生在刚开始用的时候。', {
      intent: 'check_or_confirm_condition',
      pendingConfirmations: [],
      verifiedEvidence: [
        {
          evidenceId: 'ev_turn_6',
          sourceType: 'session_turn',
          author: 'user_12turns',
          attribution: 'self',
          excerpt: '我确认，那确实只发生在刚开始用的时候。',
          turnId: 'turn_6',
          textKind: 'user_utterance',
        },
      ],
      addedFacts: [
        {
          id: 'fact_turn6_early_cond',
          kind: 'condition',
          text: '推荐拓宽兴趣只发生在刚开始使用的时候',
          targetFactId: 'fact_turn4_band',
          evidenceIds: ['ev_turn_6'],
          supportsDescription: '限定初期阶段适用，支撑长期使用后不再拓宽的阶段性推断',
        },
      ],
      graphPatch: {
        upsertNodes: [
          {
            id: 'node_early_stage_only',
            text: '拓宽作用仅限于刚开始使用的初期阶段',
            cluster: 2,
            deps: ['node_band_exp'],
            conditionFactId: 'fact_turn6_early_cond',
            sourceFactIds: ['fact_turn6_early_cond'],
            evidenceIds: ['ev_turn_6'],
          },
          {
            id: 'node_late_stage_stagnant',
            text: '度过初期阶段后推荐不再带来新乐队',
            cluster: 2,
            deps: ['node_early_stage_only'],
            evidenceIds: ['ev_turn_6'],
          },
        ],
      },
      responseText: '已将“刚开始用的时候”确认入图，生成阶段性结论节点。',
    });

    // 第 7 轮：改写一（只换语气，仍撞上 node_band_exp，不改图）
    runTurn(7, '我的看法是，推荐算法对人的兴趣只有一种影响，就是让它越来越窄。', {
      intent: 'compare_rewrite',
      graphMutated: false,
      upsertedStatements: [
        {
          statementId: 'stmt_rewrite_tone',
          role: 'rewrite',
          rewriteKind: 'tone',
          text: '我的看法是，推荐算法对人的兴趣只有一种影响，就是让它越来越窄。',
          assessment: 'conflict',
          directConflicts: ['node_band_exp'],
          reason: '只换语气仍保留绝对排他判断',
        },
      ],
      responseText: '只换语气没有改变全称前提，与原句撞上同一承重节点。',
    });

    // 第 8 轮：改写二（缩小到连续听同类歌曲之后，缺乏足够证据则维持未定 insufficient_evidence）
    runTurn(8, '连续听了几首同类歌曲之后，推荐页里的新东西会不会变少？', {
      intent: 'compare_rewrite',
      graphMutated: false,
      upsertedStatements: [
        {
          statementId: 'stmt_rewrite_scope',
          role: 'rewrite',
          rewriteKind: 'scope',
          text: '推荐确实帮我发现过新乐队；我担心连续听同类歌曲之后新东西会变少。',
          assessment: 'insufficient_evidence',
          directConflicts: [],
          reason: '已避开直接冲突，关于连续听同类歌后的长期变化尚待更多本人记录',
        },
      ],
      responseText: '缩小范围后避开了反例冲突，当前保持未定（无预设降分）。',
    });

    // 第 9 轮：追问为什么三个句子版本结果有别（只读轮次，不递增 graphVersion）
    const beforeTurn9Version = store.getSession('user_12turns', session.sessionId).graphVersion;
    assert.equal(beforeTurn9Version, 2);
    runTurn(9, '为什么这三个句子版本的结果不一样？', {
      intent: 'explain_focus_or_provenance',
      graphMutated: false,
      responseText: '原句与换语气版均被第 4 轮反例证伪，而缩小范围版承认了拓宽经历。',
    });
    assert.equal(store.getSession('user_12turns', session.sessionId).graphVersion, 2);

    // 第 10 轮：撤回第六轮的条件！验证仅失效依赖该条件的阶段性结论，第 4 轮独立事实及独立推论完整保留！
    const turn10Commit = runTurn(10, '我撤回第六轮说的“刚开始用的时候”那个条件，后来其实也发现过一次。', {
      intent: 'retract_fact',
      retractTargetRef: '第六轮',
      responseText: '已撤回第 6 轮限定条件，依赖它的阶段性结论已失效，第 4 轮独立事实保留。',
    });

    assert.equal(turn10Commit.graphVersion, 3);
    assert.equal(turn10Commit.committedPayload.graphMutated, true);

    const invalidatedIds = turn10Commit.committedPayload.invalidatedItems.map((i) => i.id);
    assert.deepEqual(
      invalidatedIds,
      ['fact_turn6_early_cond', 'node_early_stage_only', 'node_late_stage_stagnant'],
    );

    const afterTurn10 = store.getSession('user_12turns', session.sessionId);
    const activeNodeIdsAfter10 = afterTurn10.confirmedGraph.nodes.map((n) => n.id);
    // 第 4 轮独立事实节点与独立推论节点完整保留！
    assert.deepEqual(activeNodeIdsAfter10, ['node_band_exp', 'node_can_widen']);

    const fact4 = afterTurn10.facts.find((f) => f.id === 'fact_turn4_band');
    const fact6 = afterTurn10.facts.find((f) => f.id === 'fact_turn6_early_cond');
    assert.equal(fact4.status, 'active');
    assert.equal(fact6.status, 'retracted');
    assert.equal(fact6.retractedByTurnId, 'turn_10');

    // 第 11 轮：追问哪项结论受影响（只读轮次）
    runTurn(11, '刚才撤回第六轮之后，具体哪几项结论受影响了？', {
      intent: 'explain_focus_or_provenance',
      graphMutated: false,
      responseText: 'node_early_stage_only 与下游 node_late_stage_stagnant 已失效，node_band_exp 与 node_can_widen 保留。',
    });
    assert.equal(store.getSession('user_12turns', session.sessionId).graphVersion, 3);

    // 第 12 轮：收束会话（原句、采纳的改写、分歧与出处）
    runTurn(12, '好，我们收束吧，采纳缩小范围的那版改写。', {
      intent: 'converge',
      graphMutated: false,
      adoptedStatementId: 'stmt_rewrite_scope',
      responseText: '已完成收束报告。',
    });

    const finalSnap = store.getSession('user_12turns', session.sessionId);
    assert.equal(finalSnap.turns.length, 12);
    assert.equal(finalSnap.graphVersion, 3);
    assert.equal(finalSnap.adoptedStatementId, 'stmt_rewrite_scope');
    assert.equal(finalSnap.statements.length, 3);
    assert.ok(finalSnap.convergenceSummary);
    assert.equal(
      finalSnap.convergenceSummary.adoptedStatement.statementId,
      'stmt_rewrite_scope',
    );

    // 验证按早期 ID / 轮次号精确取回
    const fetchedTurn3 = store.getFactOrTurnById('user_12turns', session.sessionId, '3');
    assert.equal(fetchedTurn3.matchType, 'turn');
    assert.equal(fetchedTurn3.turn.turnId, 'turn_3');

    const fetchedFact4 = store.getFactOrTurnById(
      'user_12turns',
      session.sessionId,
      'fact_turn4_band',
    );
    assert.equal(fetchedFact4.matchType, 'fact');
    assert.equal(fetchedFact4.fact.status, 'active');

    // 验证 context-builder：绝不把全部 12 轮完整历史和全部 14 条证据一股脑塞进模型上下文，且能按文本提及的早期轮次精确取回！
    const boundedCtx = buildTurnContext(finalSnap, {
      userText: '请结合第三轮的归属纠正和第六轮被撤回的条件再核对一次',
      recentTurnsLimit: 4,
      maxEvidence: 5,
    });

    assert.equal(boundedCtx.recentTurns.length, 4);
    assert.equal(boundedCtx.budgetStats.omittedEarlierTurns, 8);
    assert.equal(boundedCtx.relevantEvidence.length, 5);
    assert.ok(boundedCtx.budgetStats.omittedEvidenceCount >= 9);
    assert.equal(boundedCtx.activeFacts.length, 1);
    assert.equal(boundedCtx.activeFacts[0].id, 'fact_turn4_band');
    assert.equal(boundedCtx.deniedAttributions.length, 1);
    assert.equal(boundedCtx.deniedAttributions[0].evidenceId, 'ev_mat_1');

    const retrievedIds = boundedCtx.retrievedEarlyItems.map((item) => item.id);
    assert.ok(retrievedIds.includes('turn_3'), '应精确取回被提及的第三轮记录');
    assert.ok(retrievedIds.includes('turn_6'), '应精确取回被提及的第六轮记录');
    assert.ok(retrievedIds.includes('fact_turn6_early_cond'), '应精确取回第六轮对应的早期条件记录');

    // 同时验证独立导出的 retractFact 纯函数幂等性与独立性
    const repeatRetract = retractFact(finalSnap, {
      targetRef: 'fact_turn6_early_cond',
      currentTurnId: 'turn_13',
    });
    assert.equal(repeatRetract.graphMutated, false);
    assert.equal(repeatRetract.invalidatedItems.length, 0);

    // 验证按授权主体清除会话数据
    const cleared = store.clearSessionData('user_12turns');
    assert.equal(cleared.clearedCount, 1);
    assertBackendError(
      () => store.getSession('user_12turns', session.sessionId),
      'SESSION_NOT_FOUND',
      404,
    );
  } finally {
    store.close();
  }
});

test('与 HTTP/SSE 服务契约及算价边界（零分母、环与悬空依赖拒绝）100% 兼容', () => {
  const store = createSessionStore({ filename: ':memory:', dataMode: 'demo' });
  try {
    const session = store.createSession({
      ownerId: 'user_srv',
      dataMode: 'demo',
      evidences: [
        {
          contentId: 'cnt_101',
          sourceType: 'collection_record',
          author: '知乎答主',
          attribution: 'other_author',
          summary: '来自采集服务的 summary 字段自动归一到 excerpt。',
        },
      ],
    });
    assert.equal(session.evidenceIndex.length, 1);
    assert.equal(session.evidenceIndex[0].evidenceId, 'cnt_101');
    assert.match(session.evidenceIndex[0].excerpt, /自动归一到 excerpt/);

    // 1. 零分母图（仅有无下游的独立根节点，总承重 S 之和为 0）：有直接冲突时保留冲突理由且 rate 为 null
    const { turn: t1 } = store.beginTurn('user_srv', session.sessionId, {
      clientRequestId: 'srv_1',
      baseGraphVersion: 0,
      text: '测试稀疏零分母图',
    });
    const ev = store.appendTurnEvent(session.sessionId, t1.turnId, 'turn.started', {
      turnId: t1.turnId,
    });
    assert.equal(ev.id, 1);
    assert.equal(ev.seq, 1);
    assert.equal(ev.event, 'turn.started');
    assert.equal(ev.eventType, 'turn.started');
    assert.deepEqual(ev.payload, { turnId: t1.turnId });

    store.commitTurn(session.sessionId, t1.turnId, {
      intent: 'provide_self_fact',
      graphPatch: {
        upsertNodes: [{ id: 'lone_root', text: '无下游依赖的孤立判断', cluster: 1, deps: [] }],
      },
      upsertedStatements: [
        {
          statementId: 'stmt_original',
          role: 'original',
          text: '与孤立判断直接冲突的原句',
          assessment: 'conflict',
          directConflicts: ['lone_root'],
          conflictReasons: ['直接否定孤立判断'],
        },
      ],
    });

    const sparseSnap = store.getSession('user_srv', session.sessionId);
    assert.equal(sparseSnap.confirmedGraph.totalWeight, 0);
    assert.equal(sparseSnap.statements[0].assessment, 'conflict');
    assert.equal(sparseSnap.statements[0].quote.rate, null);
    assert.deepEqual(sparseSnap.statements[0].quote.directConflicts, ['lone_root']);
    assert.deepEqual(sparseSnap.statements[0].quote.conflictReasons, ['直接否定孤立判断']);

    // 2. 循环依赖与悬空依赖在提交时原子回滚拒绝（400 VERIFICATION_REJECTED）
    const { turn: t2 } = store.beginTurn('user_srv', session.sessionId, {
      clientRequestId: 'srv_2',
      baseGraphVersion: 1,
      text: '测试环检测与事务回滚',
    });
    assertBackendError(
      () =>
        store.commitTurn(session.sessionId, t2.turnId, {
          intent: 'provide_self_fact',
          confirmedGraph: [
            { id: 'c_a', text: '环节点 A', cluster: 1, deps: ['c_b'] },
            { id: 'c_b', text: '环节点 B', cluster: 1, deps: ['c_a'] },
          ],
        }),
      'VERIFICATION_REJECTED',
      400,
    );
    // 事务回滚后 turn_2 仍处于 running，且可通过 server.mjs 的四参数签名 failTurn 安全落库
    const failOut = store.failTurn('user_srv', session.sessionId, t2.turnId, {
      code: 'VERIFICATION_REJECTED',
      message: '候选图存在循环依赖',
    });
    assert.equal(failOut.outcome, 'failed');
    assert.equal(store.getSession('user_srv', session.sessionId).graphVersion, 1);
  } finally {
    store.close();
  }
});

test('QA-01 / QA-02：usePersonalMaterials、cloudConsent（true/false/null）、materialsStatus 与 outboundPreview 跨轮次及重启持久化（含旧表自动迁移）', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'quotation-qa01-02-'));
  const dbPath = join(tempDir, 'qa01.sqlite');
  const legacyDbPath = join(tempDir, 'legacy.sqlite');

  try {
    const store1 = createSessionStore(dbPath);
    const sDisabled = store1.createSession({
      ownerId: 'u_qa01',
      dataMode: 'real',
      usePersonalMaterials: false,
      cloudConsent: true,
      lockedSnapshotId: 'snap_should_not_lock',
      initialEvidence: [
        {
          evidenceId: 'ev_leak_1',
          sourceType: 'collection_record',
          author: '合成采集作者',
          attribution: 'other_author',
          excerpt: '关闭个人材料时不应落库的采集记录',
        },
      ],
    });

    assert.equal(sDisabled.usePersonalMaterials, false);
    assert.equal(sDisabled.cloudConsent, true);
    assert.equal(sDisabled.lockedSnapshotId, null);
    assert.equal(sDisabled.materialsStatus.state, 'disabled_by_user');
    assert.equal(sDisabled.evidenceIndex.length, 0);

    const sNullConsent = store1.createSession({
      ownerId: 'u_qa01',
      dataMode: 'real',
      usePersonalMaterials: true,
      cloudConsent: null,
      materialsStatus: { state: 'empty', source: 'none', count: 0 },
    });
    assert.equal(sNullConsent.usePersonalMaterials, true);
    assert.equal(sNullConsent.cloudConsent, null);
    assert.equal(sNullConsent.allowCloudModel, null);
    assert.equal(sNullConsent.materialsStatus.state, 'empty');

    const sFalseConsent = store1.createSession({
      ownerId: 'u_qa01',
      dataMode: 'real',
      usePersonalMaterials: true,
      cloudConsent: false,
      lockedSnapshotId: 'snap_local_ok',
      materialsStatus: { state: 'loaded', source: 'collection', count: 1 },
    });
    assert.equal(sFalseConsent.cloudConsent, false);
    assert.equal(sFalseConsent.materialsStatus.state, 'loaded');

    // 提交一轮并更新 outboundPreview，同时确认禁用个人材料会话仍保持 usePersonalMaterials: false
    const { turn } = store1.beginTurn('u_qa01', sDisabled.sessionId, {
      clientRequestId: 'qa01_t1',
      baseGraphVersion: 0,
      text: '只用本人当轮输入进行分析。',
    });
    store1.commitTurn(sDisabled.sessionId, turn.turnId, {
      intent: 'analyze_statement',
      graphMutated: false,
      outboundPreview: {
        isCloudModel: true,
        cloudConsentGranted: true,
        snippetCount: 0,
        personalMaterialIncluded: false,
      },
      verifiedEvidence: [
        {
          evidenceId: 'ev_illegal_col',
          sourceType: 'collection_record',
          author: '偷渡采集',
          attribution: 'other_author',
          excerpt: '绝不允许在关闭材料会话落库',
        },
      ],
      responseText: '仅基于当轮句子本身分析。',
    });

    store1.close();

    // 重启重新打开同一 SQLite 文件验证持久化
    const store2 = createSessionStore(dbPath);
    try {
      const reDisabled = store2.getSession('u_qa01', sDisabled.sessionId);
      assert.equal(reDisabled.usePersonalMaterials, false);
      assert.equal(reDisabled.cloudConsent, true);
      assert.equal(reDisabled.lockedSnapshotId, null);
      assert.equal(reDisabled.materialsStatus.state, 'disabled_by_user');
      assert.equal(reDisabled.evidenceIndex.length, 0);
      assert.deepEqual(reDisabled.outboundPreview, {
        isCloudModel: true,
        cloudConsentGranted: true,
        snippetCount: 0,
        personalMaterialIncluded: false,
      });

      const reNull = store2.getSession('u_qa01', sNullConsent.sessionId);
      assert.equal(reNull.usePersonalMaterials, true);
      assert.equal(reNull.cloudConsent, null);
      assert.equal(reNull.allowCloudModel, null);
      assert.equal(reNull.materialsStatus.state, 'empty');

      const reFalse = store2.getSession('u_qa01', sFalseConsent.sessionId);
      assert.equal(reFalse.usePersonalMaterials, true);
      assert.equal(reFalse.cloudConsent, false);
      assert.equal(reFalse.materialsStatus.state, 'loaded');
    } finally {
      store2.close();
    }

    // 验证旧版无新增列 SQLite 库自动补列与 metadata 解析兼容
    const rawLegacy = new DatabaseSync(legacyDbPath);
    rawLegacy.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        data_mode TEXT NOT NULL,
        locked_snapshot_id TEXT,
        graph_version INTEGER NOT NULL DEFAULT 0,
        active_turn_id TEXT,
        state_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    rawLegacy
      .prepare(
        `INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'sess_legacy_1',
        'u_legacy',
        'demo',
        null,
        0,
        null,
        JSON.stringify({
          nextTurnNumber: 1,
          confirmedGraph: [],
          facts: [],
          statements: [],
          materialsStatus: { state: 'disabled_by_user', source: 'none', count: 0 },
          metadata: { usePersonalMaterials: false },
        }),
        1000,
        1000,
      );
    rawLegacy.close();

    const migratedStore = createSessionStore(legacyDbPath);
    try {
      const legacySnap = migratedStore.getSession('u_legacy', 'sess_legacy_1');
      assert.equal(legacySnap.usePersonalMaterials, false);
      assert.equal(legacySnap.materialsStatus.state, 'disabled_by_user');
    } finally {
      migratedStore.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('QA-03 / QA-04：显式撤回目标精确匹配（无事实轮次 TARGET_NOT_FOUND、重复撤回 ALREADY_RETRACTED 不增版本）与显式 adoptStatementId 校验', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'quotation-qa03-04-'));
  const dbPath = join(tempDir, 'qa03.sqlite');

  try {
    const store = createSessionStore(dbPath);
    const session = store.createSession({ ownerId: 'u_qa03', dataMode: 'demo' });

    const execTurn = (idx, text, spec, action = null) => {
      const cur = store.getSession('u_qa03', session.sessionId);
      const { turn } = store.beginTurn('u_qa03', session.sessionId, {
        clientRequestId: `qa03_req_${idx}`,
        baseGraphVersion: cur.graphVersion,
        text,
        action,
      });
      return store.commitTurn(session.sessionId, turn.turnId, spec);
    };

    // 第 1 轮：只输入待分析原句，未产生任何事实或条件
    execTurn(1, '远程办公必然降低跨部门协作效率。', {
      intent: 'analyze_statement',
      graphMutated: false,
      upsertedStatements: [
        {
          statementId: 'stmt_original',
          role: 'original',
          text: '远程办公必然降低跨部门协作效率。',
          assessment: 'insufficient_evidence',
          directConflicts: [],
        },
      ],
    });

    // 第 2 轮：建立独立有效事实 A -> graphVersion = 1
    execTurn(2, '本人确认事实 A：异步文档使跨部门评审提速。', {
      intent: 'provide_self_fact',
      addedFacts: [{ id: 'fact_A', kind: 'fact', text: '异步文档使跨部门评审提速' }],
      graphPatch: {
        upsertNodes: [
          { id: 'node_A', text: '异步评审提速', cluster: 'c1', deps: [], sourceFactIds: ['fact_A'] },
        ],
      },
    });

    // 第 3 轮：建立独立有效事实 B 及两份改写 -> graphVersion = 2
    execTurn(3, '本人确认事实 B：双周固定对齐消除了返工。', {
      intent: 'provide_self_fact',
      addedFacts: [{ id: 'fact_B', kind: 'fact', text: '双周固定对齐消除了返工' }],
      graphPatch: {
        upsertNodes: [
          { id: 'node_B', text: '双周对齐消除返工', cluster: 'c2', deps: [], sourceFactIds: ['fact_B'] },
        ],
      },
      upsertedStatements: [
        {
          statementId: 'stmt_rewrite_1',
          role: 'rewrite',
          text: '改写第一版：缺少异步文档时远程协作可能变慢。',
          assessment: 'insufficient_evidence',
          directConflicts: [],
        },
        {
          statementId: 'stmt_rewrite_2',
          role: 'rewrite',
          text: '改写第二版：临时口头沟通较多时远程协作受限。',
          assessment: 'insufficient_evidence',
          directConflicts: [],
        },
      ],
    });

    let snap = store.getSession('u_qa03', session.sessionId);
    assert.equal(snap.graphVersion, 2);

    // 1) 明确引用无事实的第 1 轮：返回 TARGET_NOT_FOUND，绝不误撤回第 2/3 轮事实！
    const notFoundTurn1 = store.retractFact({
      ownerId: 'u_qa03',
      sessionId: session.sessionId,
      targetRef: '第一轮',
      currentTurnId: 'turn_4',
    });
    assert.equal(notFoundTurn1.found, false);
    assert.equal(notFoundTurn1.alreadyRetracted, false);
    assert.equal(notFoundTurn1.reasonCode, 'TARGET_NOT_FOUND');
    assert.equal(notFoundTurn1.graphMutated, false);
    assert.deepEqual(notFoundTurn1.retractedFacts, []);

    // 经 commitTurn 提交无事实轮次撤回，graphVersion 保持 2 不变
    const c4 = execTurn(4, '撤回第一轮提到的条件', {
      intent: 'retract_fact',
      retractTargetRef: '第一轮',
      graphMutated: true, // 即使调用方误传 true，因目标未找到且图未变也绝不递增版本
    });
    assert.equal(c4.graphVersion, 2);

    // 2) 显式点选撤回 fact_A：只移除 fact_A 与 node_A，fact_B 与 node_B 保持 active，graphVersion 2 -> 3
    const c5 = execTurn(5, '撤回选中的事实 A', {
      intent: 'retract_fact',
      retractTargetRef: 'fact_A',
    });
    assert.equal(c5.graphVersion, 3);
    snap = store.getSession('u_qa03', session.sessionId);
    assert.equal(snap.facts.find((f) => f.id === 'fact_A').status, 'retracted');
    assert.equal(snap.facts.find((f) => f.id === 'fact_B').status, 'active');
    assert.deepEqual(snap.confirmedGraph.nodes.map((n) => n.id), ['node_B']);

    // 3) 重复撤回 fact_A：返回 ALREADY_RETRACTED，绝不重复递增 graphVersion！
    const repeatCheck = retractFact(snap, { targetRef: 'fact_A', currentTurnId: 'turn_6' });
    assert.equal(repeatCheck.found, true);
    assert.equal(repeatCheck.alreadyRetracted, true);
    assert.equal(repeatCheck.reasonCode, 'ALREADY_RETRACTED');
    assert.equal(repeatCheck.graphMutated, false);

    const c6 = execTurn(6, '再次撤回 fact_A', {
      intent: 'retract_fact',
      retractTargetRef: 'fact_A',
      graphMutated: true,
    });
    assert.equal(c6.graphVersion, 3);

    // 4) QA-04：显式传入不存在的 adoptStatementId 抛 400 INVALID_ARGUMENTS，绝不静默换成 stmt_rewrite_2
    const { turn: badAdoptTurn } = store.beginTurn('u_qa03', session.sessionId, {
      clientRequestId: 'qa04_bad_adopt',
      baseGraphVersion: 3,
      text: '收束并采用不存在的改写',
    });
    assertBackendError(
      () =>
        store.commitTurn(session.sessionId, badAdoptTurn.turnId, {
          intent: 'converge',
          adoptedStatementId: 'stmt_nonexistent_999',
        }),
      'INVALID_ARGUMENTS',
      400,
    );
    store.failTurn(session.sessionId, badAdoptTurn.turnId, {
      code: 'INVALID_ARGUMENTS',
      message: '指定的 adoptStatementId 不存在。',
    });

    // 显式选择第一份改写 stmt_rewrite_1（即使 stmt_rewrite_2 更晚），持久化和重启后均保持 stmt_rewrite_1
    execTurn(
      8,
      '收束并采用第一份改写',
      {
        intent: 'converge',
        graphMutated: false,
        adoptedStatementId: 'stmt_rewrite_1',
      },
      { type: 'converge', adoptStatementId: 'stmt_rewrite_1' },
    );

    store.close();
    const reopened = createSessionStore(dbPath);
    try {
      const afterRestart = reopened.getSession('u_qa03', session.sessionId);
      assert.equal(afterRestart.graphVersion, 3);
      assert.equal(afterRestart.adoptedStatementId, 'stmt_rewrite_1');
      assert.equal(afterRestart.statementComparison.adoptedStatementId, 'stmt_rewrite_1');
      assert.equal(afterRestart.convergenceSummary.adoptedRewrite.statementId, 'stmt_rewrite_1');
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('QA-07：无证据改写比较已解除集合为空，撤回唯一冲突依据并保留无关支撑边后回退 insufficient_evidence / null 且彻底清除旧冲突理由', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'quotation-qa07-'));
  const dbPath = join(tempDir, 'qa07.sqlite');

  try {
    const store = createSessionStore(dbPath);
    const session = store.createSession({ ownerId: 'u_qa07', dataMode: 'demo' });

    // 第 1 轮：构造冲突分支（n_conf_root -> n_conf_leaf）+ 无关独立支撑边（n_unrel_root -> n_unrel_leaf，确保撤回冲突后分母仍为 1 > 0！）
    const { turn: t1 } = store.beginTurn('u_qa07', session.sessionId, {
      clientRequestId: 'qa07_1',
      baseGraphVersion: 0,
      text: '这家工厂从不允许员工换班。',
    });
    store.commitTurn(session.sessionId, t1.turnId, {
      intent: 'provide_self_fact',
      verifiedEvidence: [
        {
          evidenceId: 'ev_shift_self',
          sourceType: 'session_turn',
          author: 'u_qa07',
          attribution: 'self',
          excerpt: '我去年在这家工厂成功申请过两次换班。',
          turnId: 'turn_1',
        },
        {
          evidenceId: 'ev_canteen_self',
          sourceType: 'session_turn',
          author: 'u_qa07',
          attribution: 'self',
          excerpt: '工厂食堂提供夜班热餐支撑夜班排班。',
          turnId: 'turn_1',
        },
      ],
      addedFacts: [
        {
          id: 'fact_shift_conflict',
          kind: 'fact',
          text: '本人去年在这家工厂成功申请过两次换班',
          evidenceIds: ['ev_shift_self'],
        },
        {
          id: 'fact_canteen_unrelated',
          kind: 'fact',
          text: '工厂食堂提供夜班热餐',
          evidenceIds: ['ev_canteen_self'],
        },
      ],
      confirmedGraph: [
        {
          id: 'n_conf_root',
          text: '本人在该工厂成功换班过',
          cluster: 'shift',
          deps: [],
          sourceFactIds: ['fact_shift_conflict'],
          evidenceIds: ['ev_shift_self'],
        },
        {
          id: 'n_conf_leaf',
          text: '工厂存在合规换班流程',
          cluster: 'shift',
          deps: ['n_conf_root'],
          sourceFactIds: ['fact_shift_conflict'],
          evidenceIds: ['ev_shift_self'],
        },
        {
          id: 'n_unrel_root',
          text: '工厂食堂供应夜班热餐',
          cluster: 'welfare',
          deps: [],
          sourceFactIds: ['fact_canteen_unrelated'],
          evidenceIds: ['ev_canteen_self'],
        },
        {
          id: 'n_unrel_leaf',
          text: '夜班后勤保障稳定',
          cluster: 'welfare',
          deps: ['n_unrel_root'],
          sourceFactIds: ['fact_canteen_unrelated'],
          evidenceIds: ['ev_canteen_self'],
        },
      ],
      upsertedStatements: [
        {
          statementId: 'stmt_original',
          role: 'original',
          text: '这家工厂从不允许员工换班。',
          assessment: 'conflict',
          directConflicts: ['n_conf_root'],
          conflictReasons: [
            {
              nodeId: 'n_conf_root',
              reason: '与本人去年成功换班两次的旧冲突事实直接矛盾',
              evidenceIds: ['ev_shift_self'],
            },
          ],
          reason: '命中直接冲突节点 n_conf_root：与本人去年成功换班两次的旧冲突事实直接矛盾。',
          verifiedEvidenceIds: ['ev_shift_self'],
        },
        {
          statementId: 'stmt_rewrite_insufficient',
          role: 'rewrite',
          text: '这家工厂在旺季封产周是否限制换班尚不确定。',
          assessment: 'insufficient_evidence',
          directConflicts: [],
          reason: '缺少旺季封产周的本人经历证据',
        },
        {
          statementId: 'stmt_rewrite_compatible',
          role: 'rewrite',
          text: '这家工厂允许员工按流程申请换班。',
          assessment: 'compatible',
          compatibleNodeIds: ['n_conf_root'],
          directConflicts: [],
          reason: '与本人换班经历相容',
          verifiedEvidenceIds: ['ev_shift_self'],
        },
      ],
    });

    const snapBefore = store.getSession('u_qa07', session.sessionId);
    assert.equal(snapBefore.confirmedGraph.totalWeight, 2);

    // 验证根因 1：改写为 insufficient_evidence 时，deltaRate 为 null，resolvedConflicts 与 resolvedAffected 必须为空数组！
    const compInsuff = snapBefore.statementComparison.comparisons.find(
      (c) => c.statementId === 'stmt_rewrite_insufficient',
    );
    assert.equal(compInsuff.rate, null);
    assert.equal(compInsuff.deltaRate, null);
    assert.deepEqual(compInsuff.resolvedConflicts, []);
    assert.deepEqual(compInsuff.resolvedAffected, []);
    assert.deepEqual(compInsuff.addedConflicts, []);
    assert.deepEqual(compInsuff.addedAffected, []);

    // 正向对照：有核验依据的 compatible 改写真实解除冲突，进入 resolvedConflicts 与 resolvedAffected
    const compValid = snapBefore.statementComparison.comparisons.find(
      (c) => c.statementId === 'stmt_rewrite_compatible',
    );
    assert.equal(compValid.rate, 0);
    assert.equal(compValid.deltaRate, -50);
    assert.deepEqual(compValid.resolvedConflicts, ['n_conf_root']);
    assert.deepEqual(compValid.resolvedAffected, ['n_conf_root', 'n_conf_leaf']);

    // 第 2 轮：撤回唯一冲突依据 fact_shift_conflict，同时保留无关支撑边 n_unrel_root -> n_unrel_leaf（denominator = 1 > 0）
    const { turn: t2 } = store.beginTurn('u_qa07', session.sessionId, {
      clientRequestId: 'qa07_2',
      baseGraphVersion: 1,
      text: '撤回刚才那条换班经历，我记错工厂了。',
    });
    const commit2 = store.commitTurn(session.sessionId, t2.turnId, {
      intent: 'retract_fact',
      retractTargetRef: 'fact_shift_conflict',
    });

    assert.equal(commit2.graphVersion, 2);
    const committedOrig = commit2.committedPayload.statements.find(
      (s) => s.statementId === 'stmt_original',
    );
    assert.equal(committedOrig.quote.denominator, 1, '无关支撑边仍在，分母大于 0');
    assert.equal(committedOrig.assessment, 'insufficient_evidence');
    assert.equal(committedOrig.quote.assessment, 'insufficient_evidence');
    assert.equal(committedOrig.quote.rate, null);
    assert.deepEqual(committedOrig.conflictReasons, []);
    assert.deepEqual(committedOrig.verifiedEvidenceIds, []);
    assert.ok(!committedOrig.reason.includes('旧冲突事实'));
    assert.ok(!committedOrig.quote.reason.includes('n_conf_root'));

    // 原本依赖 n_conf_root 相容依据的改写句在支撑相容节点被撤回后，同样回退为 insufficient_evidence / null！
    const committedComp = commit2.committedPayload.statements.find(
      (s) => s.statementId === 'stmt_rewrite_compatible',
    );
    assert.equal(committedComp.assessment, 'insufficient_evidence');
    assert.equal(committedComp.quote.rate, null);
    assert.deepEqual(committedComp.verifiedEvidenceIds, []);

    store.close();
    const reopened = createSessionStore(dbPath);
    try {
      const snapAfterRestart = reopened.getSession('u_qa07', session.sessionId);
      const origRestart = snapAfterRestart.statements.find((s) => s.statementId === 'stmt_original');
      assert.equal(origRestart.assessment, 'insufficient_evidence');
      assert.equal(origRestart.quote.rate, null);
      assert.deepEqual(origRestart.conflictReasons, []);
      assert.ok(!origRestart.reason.includes('旧冲突事实'));
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('QA-08：200 条合成事实长会话严格输入预算（预算调为 1 严格受控、按引用精确取回早期事实、无关标记零混入）', () => {
  const store = createSessionStore(':memory:');
  try {
    const session = store.createSession({ ownerId: 'u_qa08', dataMode: 'demo' });

    const bulkFacts = Array.from({ length: 200 }, (_, i) => {
      const num = String(i + 1).padStart(3, '0');
      return {
        id: `fact_long_${num}`,
        kind: i % 5 === 0 ? 'condition' : 'fact',
        text:
          i + 1 === 7
            ? `早期核心事实记录 SYNTH_MARKER_${num}：本人在雨天通勤时曾遇到派单延迟。`
            : `合成背景事实条目 SYNTH_MARKER_${num}：与当前议题无关的历史流水填充内容_${'甲乙丙丁戊己庚辛'.repeat(8)}`,
        turnId: `turn_hist_${num}`,
        turnNumber: i + 1,
      };
    });

    const bulkNodes = Array.from({ length: 30 }, (_, i) => {
      const num = String(i + 1).padStart(3, '0');
      return {
        id: `node_long_${num}`,
        text:
          i + 1 === 7
            ? '雨天派单延迟节点'
            : `无关节点 SYNTH_NODE_MARKER_${num}`,
        cluster: `c_${i % 4}`,
        deps: i > 0 && i % 2 === 1 ? [`node_long_${String(i).padStart(3, '0')}`] : [],
        sourceFactIds: [`fact_long_${num}`],
      };
    });

    const bulkEvidence = Array.from({ length: 25 }, (_, i) => {
      const num = String(i + 1).padStart(3, '0');
      return {
        evidenceId: `ev_long_${num}`,
        sourceType: 'session_turn',
        author: 'u_qa08',
        attribution: 'self',
        excerpt:
          i + 1 === 7
            ? '本人原话：雨天通勤派单延迟了二十分钟（SYNTH_MARKER_007）。'
            : `无关证据片段 SYNTH_EV_MARKER_${num}`,
      };
    });

    const { turn } = store.beginTurn('u_qa08', session.sessionId, {
      clientRequestId: 'qa08_seed',
      baseGraphVersion: 0,
      text: '初始化长会话种子数据',
    });
    store.commitTurn(session.sessionId, turn.turnId, {
      intent: 'provide_self_fact',
      verifiedEvidence: bulkEvidence,
      facts: bulkFacts,
      confirmedGraph: bulkNodes,
      upsertedStatements: [
        {
          statementId: 'stmt_original',
          role: 'original',
          text: '派单系统在任何天气下都零延迟。',
          assessment: 'conflict',
          directConflicts: ['node_long_007'],
          conflictReasons: [{ nodeId: 'node_long_007', reason: '雨天存在延迟记录' }],
        },
      ],
    });

    const fullSnap = store.getSession('u_qa08', session.sessionId);
    assert.equal(fullSnap.facts.length, 200, 'SQLite 会话完整保留全部 200 条事实');
    assert.equal(fullSnap.confirmedGraph.totalNodes, 30, '算价继续基于完整已确认图');

    // 1) 把节点、证据、近期轮次与事实预算均调为 1（以及仅传旧三项预算 = 1）：严格 <= 1 条且总字符受控！
    for (const budgetOpts of [
      {
        userText: '请结合早期 fact_long_007 的雨天记录解释当前冲突',
        maxLocalNodes: 1,
        maxEvidence: 1,
        recentTurnsLimit: 1,
        maxFacts: 1,
        maxTotalChars: 1200,
      },
      {
        userText: '请结合早期 fact_long_007 的雨天记录解释当前冲突',
        maxLocalNodes: 1,
        maxEvidence: 1,
        recentTurnsLimit: 1,
      },
    ]) {
      const ctx = buildTurnContext(fullSnap, budgetOpts);
      assert.ok(ctx.localGraph.nodes.length <= 1);
      assert.ok(ctx.relevantEvidence.length <= 1);
      assert.ok(ctx.recentTurns.length <= 1);
      assert.ok(ctx.activeFacts.length <= 1);
      assert.ok(ctx.omittedFactCount >= 199);
      assert.ok(ctx.promptText.length <= (budgetOpts.maxTotalChars ?? 6000));

      const serializedCtx = JSON.stringify(ctx);
      assert.ok(serializedCtx.includes('SYNTH_MARKER_007'), '显式引用的早期事实必须保留');
      for (let i = 1; i <= 200; i += 1) {
        if (i === 7) continue;
        const marker = `SYNTH_MARKER_${String(i).padStart(3, '0')}`;
        assert.ok(!serializedCtx.includes(marker), `无关标记 ${marker} 绝不能进入有界上下文`);
      }
    }

    // 2) 验证 turn-prompts 在 200 条事实下同样严格遵守 maxPromptChars 且不混入无关标记
    const boundedContext = buildTurnContext(fullSnap, {
      userText: '请结合 fact_long_007 说明为什么原句冲突',
      maxTotalChars: 1500,
    });
    const userPrompt = buildTurnUserPrompt({
      userText: '请结合 fact_long_007 说明为什么原句冲突',
      intent: 'explain_focus_or_provenance',
      conversationSummary: boundedContext.summary,
      verifiedContext: {
        turnId: 'turn_2',
        sentence: '派单系统在任何天气下都零延迟。',
        baseGraphVersion: 1,
        targetGraphVersion: 1,
        confirmedFacts: fullSnap.facts,
        confirmedGraph: fullSnap.confirmedGraph.nodes,
        activeQuote: fullSnap.statements[0].quote,
        quotes: fullSnap.quotes,
        boundedContext,
        promptBudget: {
          maxPromptChars: 1600,
          maxGraphNodes: 2,
          maxFacts: 2,
          maxEvidence: 2,
          maxQuotes: 2,
        },
      },
    });

    assert.ok(userPrompt.length <= 1600, `userPrompt 长度 ${userPrompt.length} 应 <= 1600`);
    assert.ok(userPrompt.includes('fact_long_007'));
    assert.ok(!userPrompt.includes('SYNTH_MARKER_001'));
    assert.ok(!userPrompt.includes('SYNTH_MARKER_199'));

    // 即使未传 boundedContext，直接调用 buildVerifiedFactsBlock 也严格按相关性裁剪 200 条事实
    const rawFactsBlock = buildVerifiedFactsBlock({
      intent: 'analyze_statement',
      turnId: 'turn_2',
      userText: '核对 fact_long_007 雨天延迟',
      sentence: '派单系统在任何天气下都零延迟。',
      confirmedFacts: fullSnap.facts,
      confirmedGraph: fullSnap.confirmedGraph.nodes,
      activeQuote: fullSnap.statements[0].quote,
      promptBudget: { maxPromptChars: 1400, maxFacts: 2, maxGraphNodes: 2 },
    });
    assert.ok(rawFactsBlock.length <= 1400);
    assert.ok(rawFactsBlock.includes('SYNTH_MARKER_007'));
    assert.ok(!rawFactsBlock.includes('SYNTH_MARKER_150'));
  } finally {
    store.close();
  }
});

test('QA-09：cancelTurn 对 committed / cancelled / failed / interrupted 四种终态严格幂等且绝不追加第二个终态事件', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'quotation-qa09-'));
  const dbPath = join(tempDir, 'qa09.sqlite');

  try {
    const store1 = createSessionStore(dbPath);
    const session = store1.createSession({ ownerId: 'u_qa09', dataMode: 'demo' });

    // 不存在的 turnId 抛 404 TURN_NOT_FOUND
    assertBackendError(
      () => store1.cancelTurn('u_qa09', session.sessionId, 'turn_missing_99'),
      'TURN_NOT_FOUND',
      404,
    );

    // 1) committed 轮次
    const { turn: t1 } = store1.beginTurn('u_qa09', session.sessionId, {
      clientRequestId: 'qa09_1',
      baseGraphVersion: 0,
      text: '已提交轮次',
    });
    store1.commitTurn(session.sessionId, t1.turnId, {
      intent: 'analyze_statement',
      graphMutated: false,
      responseText: '正常完成。',
    });

    // 2) cancelled 轮次
    const { turn: t2 } = store1.beginTurn('u_qa09', session.sessionId, {
      clientRequestId: 'qa09_2',
      baseGraphVersion: 0,
      text: '主动取消轮次',
    });
    store1.cancelTurn('u_qa09', session.sessionId, t2.turnId);

    // 3) failed 轮次
    const { turn: t3 } = store1.beginTurn('u_qa09', session.sessionId, {
      clientRequestId: 'qa09_3',
      baseGraphVersion: 0,
      text: '上游故障轮次',
    });
    store1.failTurn(session.sessionId, t3.turnId, {
      code: 'UPSTREAM_UNAVAILABLE',
      message: '模拟上游超时故障',
    });

    // 4) running 轮次经重启恢复为 interrupted
    const { turn: t4 } = store1.beginTurn('u_qa09', session.sessionId, {
      clientRequestId: 'qa09_4',
      baseGraphVersion: 0,
      text: '进程崩溃中断轮次',
    });
    store1.appendTurnEvent(session.sessionId, t4.turnId, 'turn.started', { turnId: t4.turnId });
    store1.close();

    const store2 = createSessionStore(dbPath);
    try {
      const cases = [
        { turnId: t1.turnId, expectedStatus: 'committed', expectedCancelled: false },
        { turnId: t2.turnId, expectedStatus: 'cancelled', expectedCancelled: true },
        { turnId: t3.turnId, expectedStatus: 'failed', expectedCancelled: false },
        { turnId: t4.turnId, expectedStatus: 'interrupted', expectedCancelled: false },
      ];

      for (const item of cases) {
        const eventsBefore = store2.listTurnEvents('u_qa09', session.sessionId, item.turnId);
        const lastSeqBefore = eventsBefore.at(-1).seq;

        const c1 = store2.cancelTurn('u_qa09', session.sessionId, item.turnId);
        const c2 = store2.cancelTurn({
          ownerId: 'u_qa09',
          sessionId: session.sessionId,
          turnId: item.turnId,
        });

        for (const res of [c1, c2]) {
          assert.equal(res.outcome, item.expectedStatus);
          assert.equal(res.status, item.expectedStatus);
          assert.equal(res.cancelled, item.expectedCancelled);
          assert.equal(res.graphVersion, 0);
        }

        const eventsAfter = store2.listTurnEvents('u_qa09', session.sessionId, item.turnId);
        assert.deepEqual(eventsAfter, eventsBefore, `${item.expectedStatus} 重复取消不得追加任何事件`);
        assert.deepEqual(
          store2.listTurnEvents('u_qa09', session.sessionId, item.turnId, {
            afterSeq: lastSeqBefore,
          }),
          [],
        );
      }
    } finally {
      store2.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('QA-10：23/40 精确四舍五入为 58%、非法 conflictReasons / evidenceIds 拒绝与 10,000 节点长链迭代无栈溢出', () => {
  for (const engineOpt of [null, builtinPricingEngine]) {
    const store = createSessionStore(':memory:', { pricingEngine: engineOpt });
    try {
      const session = store.createSession({ ownerId: 'u_qa10', dataMode: 'demo' });

      // 40 对独立根+叶节点（共 80 个节点，每个根 S=1、叶 S=0，全图分母 = 40），直接冲突命中 23 个根（分子 = 23）
      const nodes40Pairs = [];
      for (let i = 0; i < 40; i += 1) {
        nodes40Pairs.push(
          { id: `r_${i}`, text: `根判断 ${i}`, cluster: `c_${i}`, deps: [] },
          { id: `l_${i}`, text: `叶判断 ${i}`, cluster: `c_${i}`, deps: [`r_${i}`] },
        );
      }
      const conflict23 = Array.from({ length: 23 }, (_, i) => `r_${i}`);
      const validReasons23 = conflict23.map((nid) => ({
        nodeId: nid,
        reason: `与 ${nid} 直接冲突`,
        evidenceIds: ['ev_qa10_1'],
      }));

      const { turn: t1 } = store.beginTurn('u_qa10', session.sessionId, {
        clientRequestId: 'qa10_1',
        baseGraphVersion: 0,
        text: '测试 23/40 舍入精度',
      });
      const c1 = store.commitTurn(session.sessionId, t1.turnId, {
        intent: 'provide_self_fact',
        confirmedGraph: nodes40Pairs,
        upsertedStatements: [
          {
            statementId: 'stmt_original',
            role: 'original',
            text: '命中 23 个根支柱的原句',
            assessment: 'conflict',
            directConflicts: conflict23,
            conflictReasons: validReasons23,
            verifiedEvidenceIds: ['ev_qa10_1'],
          },
        ],
      });

      const q = c1.committedPayload.quotes[0];
      assert.equal(q.numerator, 23);
      assert.equal(q.denominator, 40);
      assert.equal(q.rate, 58, '23/40 = 57.5% 必须精确四舍五入为 58%');

      // 非法 conflictReasons（空对象 {}、缺 reason、字符串形式 evidenceIds）与非法 verifiedEvidenceIds 必须拒绝
      for (const [idx, badStmt] of [
        {
          statementId: 'stmt_bad_empty_obj',
          text: '空理由对象',
          assessment: 'conflict',
          directConflicts: ['r_0'],
          conflictReasons: [{}],
        },
        {
          statementId: 'stmt_bad_ev_str',
          text: '字符串形式 evidenceIds',
          assessment: 'conflict',
          directConflicts: ['r_0'],
          conflictReasons: [{ nodeId: 'r_0', reason: '冲突说明', evidenceIds: 'ev_str_invalid' }],
        },
        {
          statementId: 'stmt_bad_verified_ev',
          text: '非数组 verifiedEvidenceIds',
          assessment: 'compatible',
          verifiedEvidenceIds: 'ev_not_array',
        },
      ].entries()) {
        const { turn: badTurn } = store.beginTurn('u_qa10', session.sessionId, {
          clientRequestId: `qa10_bad_${idx}`,
          baseGraphVersion: 1,
          text: badStmt.text,
        });
        assertBackendError(
          () =>
            store.commitTurn(session.sessionId, badTurn.turnId, {
              intent: 'compare_rewrite',
              graphMutated: false,
              upsertedStatements: [badStmt],
            }),
          'VERIFICATION_REJECTED',
          400,
        );
        store.failTurn(session.sessionId, badTurn.turnId, {
          code: 'VERIFICATION_REJECTED',
          message: '理由结构校验拒绝',
        });
      }
    } finally {
      store.close();
    }
  }

  // 验证 10,000 节点深链迭代环检测无栈溢出
  const chain10k = Array.from({ length: 10_000 }, (_, i) => ({
    id: `chain_${i}`,
    text: `节点 ${i}`,
    cluster: 'deep',
    deps: i === 0 ? [] : [`chain_${i - 1}`],
  }));
  const dagRes = builtinPricingEngine.validateDag(chain10k);
  assert.equal(dagRes.ok, true);
  assert.equal(dagRes.sortedNodes.length, 10_000);

  const computed10k = builtinPricingEngine.computeGraph(chain10k);
  assert.equal(computed10k[0].S, 9999);
  assert.equal(computed10k[9999].S, 0);
  assert.equal(computed10k[9999].d, 9999);
});
