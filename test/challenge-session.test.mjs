import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoleBudget, startChallengeSession } from '../runner/challenge-session.mjs';

const roots = [];
function setup(options = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'challenge-session-test-')); roots.push(stateDir);
  const events = [];
  let n = 0;
  const provider = {
    thread: `thread-${Math.random()}`, sessionId: `session-${Math.random()}`, model: 'gpt-6-luna',
    turn: options.turn ?? (async () => ({ turn: { id: `turn-${++n}` } })),
    interrupt: options.interrupt ?? (async () => ({})), close: vi.fn(),
  };
  const sessionPromise = startChallengeSession({ cwd: '/workspace', gateway: {}, image: 'sha256:' + 'a'.repeat(64), stateDir,
    role: { id: 'worker' }, budget: options.budget ?? new RoleBudget(), onEvent: e => events.push(e), interruptTimeoutMs: options.interruptTimeoutMs,
    isolatedFactory: async ({ onEvent }) => { provider.onEvent = onEvent; return provider; } });
  return { sessionPromise, provider, events, stateDir };
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('challenge session protocol', () => {
  it('retains running-command state after the model turn completes', async () => {
    const {sessionPromise,provider}=setup();const session=await sessionPromise;
    const turn=session.turn('submit work');await Promise.resolve();
    provider.onEvent({method:'item/started',params:{item:{id:'submit',type:'commandExecution'}}});
    provider.onEvent({method:'turn/completed',params:{turn:{id:'turn-1',status:'completed'}}});
    await turn;expect(session.state.activeCommands).toBe(1);
    provider.onEvent({method:'item/completed',params:{item:{id:'submit',type:'commandExecution',exitCode:0}}});
    expect(session.state.activeCommands).toBe(0);await session.close();
  });
  it('can leave an idle notice queued without starting an extra model turn', async () => {
    const turn = vi.fn();
    const {sessionPromise} = setup({turn}); const session = await sessionPromise;
    expect(await session.notify('a queued product notice', {activeOnly: true})).toBe(false);
    expect(turn).not.toHaveBeenCalled(); await session.close();
  });
  it('steers checked evidence into the actual running turn and records its receipt', async () => {
    const { sessionPromise, provider, events } = setup();
    const session = await sessionPromise;
    provider.rpc = { rpc: vi.fn(async (method, params) => {
      expect(method).toBe('turn/steer');
      expect(params.expectedTurnId).toBe('turn-1');
      provider.onEvent({ method: 'item/started', params: { item: { type: 'userMessage', content: params.input } } });
      return {};
    }) };
    const running = session.turn('continue work');
    await Promise.resolve();
    await session.notify('checked evidence', { label: 'resolution' });
    expect(events.some(e => e.kind === 'user-message-received' && e.item.content[0].text === 'checked evidence')).toBe(true);
    provider.onEvent({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
    expect((await running).status).toBe('completed');
    await session.close();
  });
  it('accumulates nested cumulative usage across updates and replacement sessions', async () => {
    const budget = new RoleBudget();
    const a = setup({ budget }); const first = await a.sessionPromise;
    a.provider.onEvent({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens: 10, outputTokens: 2 } } } });
    a.provider.onEvent({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens: 15, outputTokens: 4 } } } });
    const b = setup({ budget }); await b.sessionPromise;
    b.provider.onEvent({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens: 3, outputTokens: 1 } } } });
    expect(budget.state.usage).toEqual({ inputTokens: 18, outputTokens: 5 });
    await first.close();
  });

  it('counts only actual action item types and records actual user-message evidence', async () => {
    const { sessionPromise, provider, events } = setup(); const session = await sessionPromise;
    const pending = session.turn('go');
    await vi.waitFor(() => expect(provider.onEvent).toBeTypeOf('function'));
    provider.onEvent({ method: 'item/started', params: { item: { id: 'r', type: 'reasoning' } } });
    provider.onEvent({ method: 'item/started', params: { item: { id: 'c', type: 'commandExecution' } } });
    provider.onEvent({ method: 'item/started', params: { item: { id: 'f', type: 'fileChange' } } });
    provider.onEvent({ method: 'item/started', params: { item: { id: 'm', type: 'mcpToolCall' } } });
    provider.onEvent({ method: 'item/completed', params: { item: { id: 'u', type: 'userMessage', content: [{ text: 'actual' }] } } });
    provider.onEvent({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
    expect((await pending).status).toBe('completed');
    expect(session.state.actions).toBe(3);
    expect(events.some(e => e.kind === 'user-message-received' && e.item.id === 'u')).toBe(true);
  });

  it('waits for completion before permitting another turn in the same context', async () => {
    const { sessionPromise, provider } = setup(); const session = await sessionPromise;
    const first = session.turn('one');
    await vi.waitFor(() => expect(provider).toHaveProperty('onEvent'));
    await expect(session.turn('overlap')).rejects.toThrow('A turn is already active');
    provider.onEvent({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
    expect((await first).status).toBe('completed');
    const second = session.turn('two');
    provider.onEvent({ method: 'turn/completed', params: { turn: { id: 'turn-2', status: 'completed' } } });
    expect((await second).status).toBe('completed');
  });

  it('requires acknowledged interrupt and provider completion before returning stopped status', async () => {
    let acknowledge;
    const { sessionPromise, provider } = setup({ interrupt: () => new Promise(resolve => { acknowledge = resolve; }) });
    const session = await sessionPromise; const turn = session.turn('stop me');
    await vi.waitFor(() => expect(provider.onEvent).toBeTypeOf('function'));
    provider.onEvent({ method: 'turn/started', params: { turn: { id: 'server-turn-id' } } });
    const stopping = session.interrupt('manual');
    await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'));
    let finished = false; void turn.then(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false);
    acknowledge({});
    provider.onEvent({ method: 'turn/completed', params: { turn: { id: 'server-turn-id', status: 'interrupted' } } });
    await stopping;
    expect((await turn).status).toBe('interrupted');
  });

  it('reports missing stop acknowledgement as provider error, never a fabricated interrupt', async () => {
    const { sessionPromise, provider } = setup({ interrupt: () => new Promise(() => {}), interruptTimeoutMs: 30 }); const session = await sessionPromise;
    const turn = session.turn('stop me');
    await vi.waitFor(() => expect(provider.onEvent).toBeTypeOf('function'));
    provider.onEvent({ method: 'turn/started', params: { turn: { id: 't-ack' } } });
    const stopping = session.interrupt('manual');
    await expect(stopping).rejects.toThrow('acknowledge interrupt');
    expect((await turn).status).toBe('provider-error');
  });

  it('shares the same RoleBudget across session replacements', async () => {
    const budget = new RoleBudget(); budget.addUsage({ inputTokens: 12, outputTokens: 6 });
    budget.addAction();
    const old = setup({ budget }); const oldSession = await old.sessionPromise;
    const fresh = setup({ budget }); const newSession = await fresh.sessionPromise;
    expect(newSession.state.sessionId).not.toBe(oldSession.state.sessionId);
    expect(budget.state.usage).toEqual({ inputTokens: 12, outputTokens: 6 });
    expect(newSession.state.actions).toBe(1);
    const firstTurn = oldSession.turn('prompt');
    old.provider.onEvent({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
    await firstTurn;
    expect(readFileSync(join(old.stateDir, 'worker.jsonl'), 'utf8')).toContain('outgoing-prompt');
    await oldSession.close(); await newSession.close();
  });
});
