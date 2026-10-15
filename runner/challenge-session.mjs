import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isolatedCodex } from './isolated-codex.mjs';
import { budgetReached, tokenCostUpperBound } from './experiment-budget.mjs';

const MODEL = 'gpt-6-luna';
const MAX_ACTIONS = 50;
const MAX_MS = 15 * 60 * 1000;
const MAX_COST = 0.5;
const REASONS = new Set(['usage', 'action', 'time', 'manual', 'contradiction', 'provider']);
const ACTION_TYPES = new Set(['commandExecution', 'fileChange', 'mcpToolCall']);
const STOP_TIMEOUT_MS = 5000;

export class RoleBudget {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now; this.maxActions = MAX_ACTIONS; this.maxMs = MAX_MS; this.maxCostUsd = MAX_COST;
    this.startedAt = null; this.actions = 0; this.usage = { inputTokens: 0, outputTokens: 0 }; this.interrupt = null;
  }
  get state() { return { startedAt: this.startedAt, actions: this.actions, maxActions: this.maxActions, deadlineAt: this.startedAt == null ? null : this.startedAt + this.maxMs, usage: { ...this.usage }, estimatedCostUsd: tokenCostUpperBound(this.usage), maxCostUsd: this.maxCostUsd, interrupt: this.interrupt }; }
  start() { if (this.startedAt == null) this.startedAt = this.now(); return this.check(); }
  addAction() { this.actions++; return this.check(); }
  addUsage(usage = {}) { for (const key of ['inputTokens', 'outputTokens']) if (Number.isFinite(usage[key]) && usage[key] >= 0) this.usage[key] += usage[key]; return this.check(); }
  check() {
    if (this.interrupt) return this.interrupt;
    const estimated = tokenCostUpperBound(this.usage);
    const reason = this.actions >= this.maxActions ? 'action' : this.startedAt != null && this.now() - this.startedAt >= this.maxMs ? 'time' : estimated != null && budgetReached(this.usage, this.maxCostUsd) ? 'usage' : null;
    if (reason) this.interrupt = reason;
    return reason;
  }
}

const timeout = (promise, ms, message) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(message)), ms);
  timer.unref?.();
  Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

export async function startChallengeSession({ cwd, gateway, image, stateDir, role, budget, onEvent = () => {}, isolatedFactory = isolatedCodex, interruptTimeoutMs = STOP_TIMEOUT_MS }) {
  if (!cwd || !gateway || !image || !stateDir || !/^[A-Za-z0-9_-]{1,64}$/.test(role?.id ?? '')) throw new Error('cwd, gateway, image, stateDir and a safe role.id are required');
  if (!(budget instanceof RoleBudget)) throw new Error('budget must be a shared RoleBudget');
  mkdirSync(stateDir, { recursive: true });
  const eventPath = join(stateDir, `${role.id}.jsonl`);
  let activeTurn = null, closed = false, sessionId = null, state = null, lastUsage = { inputTokens: 0, outputTokens: 0 };
  const activeCommands = new Set();
  const emit = event => { appendFileSync(eventPath, `${JSON.stringify(event)}\n`); onEvent(event); };
  const providerEvent = event => {
    emit({ kind: 'provider-event', role: role.id, session: sessionId, at: Date.now(), event });
    const method = event.method, params = event.params ?? {}, item = params.item ?? {};
    if (item.type === 'commandExecution' && item.id != null) {
      if (method === 'item/started') activeCommands.add(item.id);
      if (method === 'item/completed') activeCommands.delete(item.id);
      if (state) state.activeCommands = activeCommands.size;
    }
    if (method === 'item/started' && ACTION_TYPES.has(item.type) && activeTurn) {
      if (item.id == null || !activeTurn.actions.has(item.id)) {
        if (item.id != null) activeTurn.actions.add(item.id);
        const reason = budget.addAction(); if (state) state.actions = budget.actions;
        if (reason) void interrupt(reason).catch(error => failActive(error));
      }
    }
    if (method === 'thread/tokenUsage/updated' || method === 'thread/token_usage/updated') {
      // Codex reports cumulative totals at params.tokenUsage.total.
      const totals = params.tokenUsage?.total ?? params.token_usage?.total ?? params.tokenUsage ?? params.token_usage ?? params;
      const inputTokens = totals.inputTokens ?? totals.input_tokens;
      const outputTokens = totals.outputTokens ?? totals.output_tokens;
      if (Number.isFinite(inputTokens) && Number.isFinite(outputTokens)) {
        budget.addUsage({ inputTokens: Math.max(0, inputTokens - lastUsage.inputTokens), outputTokens: Math.max(0, outputTokens - lastUsage.outputTokens) });
        lastUsage = { inputTokens, outputTokens };
        const reason = budget.check(); if (reason) void interrupt(reason).catch(error => failActive(error));
      }
    }
    if (['item/started', 'item/completed'].includes(method) && ['userMessage', 'user_message'].includes(item.type)) {
      emit({ kind: 'user-message-received', role: role.id, session: sessionId, at: Date.now(), item });
    }
    if (method === 'turn/started' && activeTurn) {
      const turnId = params.turn?.id ?? params.turnId ?? params.turn_id;
      if (turnId) activeTurn.turnId = turnId;
    }
    if (method === 'turn/completed' || method === 'turn/failed' || (method === 'error' && !params.willRetry)) {
      const turn = params.turn ?? {};
      const eventTurnId = turn.id ?? params.turnId ?? params.turn_id;
      if (activeTurn && (!eventTurnId || !activeTurn.turnId || eventTurnId === activeTurn.turnId)) {
        const status = method === 'turn/failed' || method === 'error' || turn.isError || ['failed', 'interrupted'].includes(turn.status)
          ? (turn.status ?? 'failed') : (turn.status ?? 'completed');
        settleActive({ status, event });
      }
    }
  };
  const isolated = await isolatedFactory({ cwd, gateway, image, onEvent: providerEvent });
  sessionId = isolated.sessionId;
  if (!sessionId || !isolated.thread || isolated.model !== MODEL) { await isolated.close?.(); throw new Error('Isolated provider session identity or model check failed'); }
  state = { toolchain: isolated.toolchain, status: 'ready', interruptReason: null, actions: budget.actions, activeCommands: activeCommands.size, sessionId, role: role.id, model: isolated.model, startedAt: null, finishedAt: null };
  function settleActive(result) {
    const p = activeTurn; if (!p) return;
    activeTurn = null; p.resolve(result);
  }
  function failActive(error) { if (activeTurn) settleActive({ status: 'provider-error', error }); }

  const interrupt = async reason => {
    if (!REASONS.has(reason)) throw new Error(`Unsupported interrupt reason: ${reason}`);
    if (!activeTurn) return;
    if (activeTurn.stopPromise) return activeTurn.stopPromise;
    const current = activeTurn;
    state.interruptReason = reason; state.status = 'interrupting';
    emit({ kind: 'interrupt-requested', role: role.id, session: sessionId, at: Date.now(), reason, turnId: current.turnId ?? null });
    current.stopPromise = (async () => {
      try {
        if (!current.turnId) await timeout(current.started, interruptTimeoutMs, 'Provider did not report the active turn ID; cannot acknowledge interrupt');
        if (!current.turnId) throw new Error('Provider did not report the active turn ID; cannot acknowledge interrupt');
        await timeout(Promise.resolve(isolated.interrupt(current.turnId)), interruptTimeoutMs, 'Provider did not acknowledge interrupt');
        await timeout(current.completion, interruptTimeoutMs, 'Provider did not complete the interrupted turn');
      } catch (error) { failActive(error); throw error; }
    })();
    return current.stopPromise;
  };
  const close = async () => {
    if (closed) return;
    try { if (activeTurn) await interrupt('manual'); }
    finally { closed = true; state.status = 'closed'; state.finishedAt = Date.now(); await isolated.close(); }
  };
  const turn = async (text, { label } = {}) => {
    if (closed) throw new Error('Session is closed');
    if (typeof text !== 'string' || !text.trim()) throw new Error('turn text must be non-empty');
    if (activeTurn) throw new Error('A turn is already active');
    const existing = budget.check(); if (existing) return { status: 'interrupted', reason: existing };
    budget.start(); state.startedAt ??= Date.now(); state.status = 'working'; state.interruptReason = null;
    emit({ kind: 'outgoing-prompt', role: role.id, session: sessionId, at: Date.now(), label: label ?? null, text });
    let resolve;
    const completion = new Promise(r => { resolve = r; });
    const current = { resolve, completion, started: null, turnId: null, actions: new Set(), stopPromise: null };
    activeTurn = current;
    try {
      current.started = Promise.resolve(isolated.turn(text));
      const startResult = await current.started;
      current.turnId = startResult?.turn?.id ?? startResult?.turnId ?? startResult?.turn_id ?? current.turnId;
      if (!current.turnId && state.interruptReason) throw new Error('Provider did not report the active turn ID; cannot acknowledge interrupt');
      const duration = Math.max(1, budget.startedAt + budget.maxMs - budget.now());
      let timer;
      const deadline = new Promise(r => { timer = setTimeout(() => r({ status: 'deadline' }), duration); });
      const result = await Promise.race([completion, deadline]); clearTimeout(timer);
      if (result.status === 'deadline') { await interrupt('time'); }
      if (current.stopPromise) await current.stopPromise;
      const settled = result.status === 'deadline' ? await completion : result;
      state.status = settled.status; state.lastTurn = settled.status; state.actions = budget.actions;
      emit({ kind: 'turn-result', role: role.id, session: sessionId, at: Date.now(), label: label ?? null, status: settled.status, reason: state.interruptReason });
      return { ...settled, reason: settled.reason ?? state.interruptReason ?? undefined };
    } catch (error) {
      if (activeTurn === current) settleActive({ status: 'provider-error', error });
      state.status = 'provider-error'; state.lastTurn = 'provider-error';
      emit({ kind: 'provider-error', role: role.id, session: sessionId, at: Date.now(), message: String(error?.message ?? error) });
      return { status: 'provider-error', error };
    }
  };
  const notify = async (text, { label, activeOnly = false } = {}) => {
    if (!activeTurn) return activeOnly ? false : turn(text, { label });
    const current = activeTurn;
    await current.started;
    if (activeTurn !== current) return activeOnly ? false : turn(text, { label });
    emit({ kind: 'outgoing-prompt', role: role.id, session: sessionId, at: Date.now(), label: label ?? null, text, delivery: 'steer' });
    return isolated.rpc.rpc('turn/steer', { threadId: isolated.thread, expectedTurnId: current.turnId, input: [{ type: 'text', text }] });
  };
  return { thread: isolated.thread, model: isolated.model, turn, notify, interrupt, close, state };
}
