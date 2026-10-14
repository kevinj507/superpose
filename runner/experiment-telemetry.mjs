// Adapter for Codex app-server notifications. It keeps the observer state
// small and writes sanitized, newline-delimited timeline records via injection.
const SAFE_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export class ExperimentTelemetry {
  constructor({ taskId, now = () => Date.now(), onTimeline = () => {}, timeoutMs = null } = {}) {
    if (!SAFE_ID.test(taskId ?? '')) throw new Error('taskId must be a short label');
    this.now = now;
    this.onTimeline = onTimeline;
    this.lines = [];
    this.pendingItems = new Map();
    this.lastCommand = null;
    this.failureCount = 0;
    this.startedAt = null;
    this.finishedAt = null;
    this.updates = 0;
    this.task = { id: taskId, status: 'working', blocker: null, startedAt: null,
      lastProgressAt: null, identicalFailuresSinceProgress: 0, costUsd: null,
      elapsedMs: null, updates: 0 };
    if (Number.isFinite(timeoutMs) && timeoutMs >= 0) this.deadlineAt = this.now() + timeoutMs;
  }

  get state() { return { tasks: [{ ...this.task, deadlineAt: this.deadlineAt ?? null }] }; }
  get timelineJSONL() { return this.lines.length ? `${this.lines.map((line) => JSON.stringify(line)).join('\n')}\n` : ''; }

  record(kind, details = {}, at = this.now()) {
    const entry = { task: this.task.id, kind, at, elapsedMs: this.startedAt == null ? 0 : Math.max(0, at - this.startedAt), ...details };
    this.lines.push(entry);
    this.onTimeline(`${JSON.stringify(entry)}\n`, entry);
    return entry;
  }

  progress(kind, details, at) {
    this.task.lastProgressAt = at;
    this.failureCount = 0;
    this.lastCommand = null;
    this.task.identicalFailuresSinceProgress = 0;
    this.record(kind, details, at);
  }

  requestInput({ blocker = 'unknown', detail = undefined } = {}) {
    const allowed = ['authentication', 'platform', 'merge', 'agent-exit', 'budget', 'timeout', 'unknown'];
    this.task.blocker = allowed.includes(blocker) ? blocker : 'unknown';
    this.record('operator-request', { blocker: this.task.blocker, ...(typeof detail === 'string' ? { detail: detail.slice(0, 160) } : {}) });
  }

  timeout(at = this.now()) { return this.finish('timeout', at, 'timeout'); }

  finish(status, at = this.now(), blocker = null) {
    if (!['done', 'error', 'timeout'].includes(status)) throw new Error('status must be done, error, or timeout');
    this.task.status = status;
    this.task.blocker = blocker;
    this.finishedAt = at;
    this.task.elapsedMs = this.startedAt == null ? 0 : Math.max(0, at - this.startedAt);
    this.record(status, {}, at);
    return this.state;
  }

  handle(notification) {
    const { method, params = {} } = notification ?? {};
    const at = this.now();
    if (method === 'turn/started') {
      if (this.startedAt == null) {
        this.startedAt = at;
        this.task.startedAt = at;
        this.task.lastProgressAt = at;
      }
      this.task.status = 'working';
      this.record('turn-started', {}, at);
      return this.state;
    }
    if (method === 'thread/tokenUsage/updated' || method === 'thread/token_usage/updated') {
      const cost = params.costUsd ?? params.cost_usd ?? params.totalCostUsd ?? params.total_cost_usd;
      if (Number.isFinite(cost) && cost >= 0) this.task.costUsd = cost;
      this.updates++;
      this.task.updates = this.updates;
      this.record('usage-updated', { costUsd: this.task.costUsd }, at);
      return this.state;
    }
    if (method === 'item/started') {
      const item = params.item ?? {};
      if (item.id != null) this.pendingItems.set(item.id, item);
      return this.state;
    }
    if (method === 'item/completed') {
      const item = params.item ?? {};
      const prior = item.id == null ? null : this.pendingItems.get(item.id);
      if (item.id != null) this.pendingItems.delete(item.id);
      const type = item.type ?? prior?.type;
      if (type === 'commandExecution') {
        const command = typeof item.command === 'string' ? item.command : (typeof prior?.command === 'string' ? prior.command : '');
        const exitCode = item.exitCode;
        if (Number.isInteger(exitCode) && exitCode === 0) this.progress('command-succeeded', { exitCode: 0 }, at);
        else if (Number.isInteger(exitCode)) {
          this.failureCount = command === this.lastCommand ? this.failureCount + 1 : 1;
          this.lastCommand = command;
          this.task.identicalFailuresSinceProgress = this.failureCount;
          // Never retain command text or terminal output: either may contain secrets.
          this.record('command-failed', { repeatCount: this.failureCount }, at);
        }
      } else if (type === 'fileChange') {
        this.progress('file-change', {}, at);
      } else if (type === 'agentMessage') {
        this.updates++;
        this.task.updates = this.updates;
        this.record('agent-message', {}, at);
      }
      return this.state;
    }
    if (method === 'turn/completed') {
      const turn = params.turn ?? params;
      const cost = turn.costUsd ?? turn.cost_usd ?? turn.totalCostUsd ?? turn.total_cost_usd;
      if (Number.isFinite(cost) && cost >= 0) this.task.costUsd = cost;
      this.updates++;
      this.task.updates = this.updates;
      return this.finish(turn.isError || turn.status === 'failed' ? 'error' : 'done', at, turn.isError ? 'agent-exit' : null);
    }
    if (method === 'error') {
      this.updates++;
      this.task.updates = this.updates;
      return this.finish('error', at, 'agent-exit');
    }
    return this.state;
  }
}

export function createExperimentTelemetry(options) { return new ExperimentTelemetry(options); }
