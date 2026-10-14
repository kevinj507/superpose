import { describe, expect, it } from 'vitest';
import { ExperimentTelemetry } from '../runner/experiment-telemetry.mjs';

function harness() {
  let time = 1000;
  const emitted = [];
  const telemetry = new ExperimentTelemetry({ taskId: 'pricing', now: () => time, onTimeline: (line) => emitted.push(line) });
  return { telemetry, emitted, tick: (ms = 1000) => { time += ms; }, send: (method, params = {}) => telemetry.handle({ method, params }) };
}
function command(id, exitCode, aggregatedOutput = 'private output') {
  return { item: { id, type: 'commandExecution', command: 'bun test', exitCode, aggregatedOutput } };
}

describe('Codex experiment telemetry', () => {
  it('counts three repeated identical command failures and sanitizes evidence', () => {
    const h = harness();
    h.send('turn/started');
    for (let i = 0; i < 3; i++) {
      h.send('item/started', { item: { id: `c${i}`, type: 'commandExecution', command: 'bun test' } });
      h.send('item/completed', command(`c${i}`, 1, 'TOKEN=secret and stack trace'));
      h.tick();
    }
    expect(h.telemetry.state.tasks[0]).toMatchObject({ id: 'pricing', status: 'working', identicalFailuresSinceProgress: 3 });
    expect(h.telemetry.timelineJSONL).not.toContain('secret');
    expect(h.telemetry.timelineJSONL).not.toContain('stack trace');
    expect(h.telemetry.timelineJSONL).not.toContain('bun test');
    expect(h.emitted).toHaveLength(4); // Includes turn/started.
  });

  it('resets repeated failures on a completed file change', () => {
    const h = harness();
    h.send('turn/started');
    h.send('item/completed', command('a', 1));
    h.tick();
    h.send('item/completed', command('b', 1));
    h.tick();
    h.send('item/completed', { item: { id: 'edit', type: 'fileChange', changes: [{ path: '/private/file' }] } });
    expect(h.telemetry.state.tasks[0]).toMatchObject({ identicalFailuresSinceProgress: 0, lastProgressAt: 3000 });
    expect(h.telemetry.timelineJSONL).not.toContain('/private/file');
  });

  it('does not count partial text or messages as progress', () => {
    const h = harness();
    h.send('turn/started');
    h.tick(5000);
    h.send('item/started', { item: { id: 'msg', type: 'agentMessage', text: 'working on it' } });
    expect(h.telemetry.state.tasks[0].lastProgressAt).toBe(1000);
    expect(h.telemetry.timelineJSONL).not.toContain('agent-message');
  });

  it('records explicit operator blockage and terminal status with elapsed time', () => {
    const h = harness();
    h.send('turn/started');
    h.tick(2500);
    h.telemetry.requestInput({ blocker: 'authentication', detail: 'Needs access' });
    expect(h.telemetry.state.tasks[0].blocker).toBe('authentication');
    h.tick(1500);
    h.send('turn/completed', { turn: { status: 'failed', isError: true } });
    expect(h.telemetry.state.tasks[0]).toMatchObject({ status: 'error', blocker: 'agent-exit', elapsedMs: 4000, updates: 1 });
    expect(h.telemetry.timelineJSONL).toContain('"kind":"error"');
  });

  it('leaves cost unknown when token usage has no dollar amount', () => {
    const h = harness();
    h.send('thread/tokenUsage/updated', { tokenUsage: { totalTokens: 900 } });
    expect(h.telemetry.state.tasks[0].costUsd).toBeNull();
    expect(h.telemetry.timelineJSONL).toContain('"costUsd":null');
  });
});
