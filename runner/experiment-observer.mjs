// Pure alert rules shared by every experiment group. Agent launchers adapt
// their output to this state; this module never coaches or restarts agents.
const SAFE_ID = /^[a-zA-Z0-9_-]{1,64}$/;
export function observationAlerts(state, now = Date.now()) {
  const alerts = [];
  for (const task of state.tasks ?? []) {
    if (!SAFE_ID.test(task.id ?? '')) throw new Error('task ids must be short labels');
    if (['done', 'cancelled'].includes(task.status)) continue;
    const shared = { task: task.id, at: now };
    if (task.blocker && task.blocker !== 'dependency') {
      const allowed = ['authentication', 'platform', 'merge', 'agent-exit', 'budget', 'timeout', 'unknown'];
      const reason = allowed.includes(task.blocker) ? task.blocker : 'unknown';
      alerts.push({ ...shared, kind: 'blocked', reason });
      continue;
    }
    if (task.deadlineAt && now >= task.deadlineAt) { alerts.push({ ...shared, kind: 'blocked', reason: 'timeout' }); continue; }
    if (task.blocker === 'dependency') { alerts.push({ ...shared, kind: 'waiting', reason: 'dependency' }); continue; }
    if (task.waitingFor === 'checks' && task.checkDeadlineAt && now < task.checkDeadlineAt) {
      alerts.push({ ...shared, kind: 'waiting', reason: 'checks' });
      continue;
    }
    if ((task.identicalFailuresSinceProgress ?? 0) >= 3) {
      alerts.push({ ...shared, kind: 'possible-stall', reason: 'repeated-failure' });
      continue;
    }
    const last = task.lastProgressAt ?? task.startedAt;
    if (Number.isFinite(last) && now - last >= 180_000) alerts.push({ ...shared, kind: 'possible-stall', reason: 'no-visible-progress', seconds: Math.floor((now - last) / 1000) });
  }
  return alerts;
}
export function alertText(alert) {
  const reasons = {
    authentication: 'access was refused', platform: 'the platform failed', merge: 'a merge needs resolution',
    'agent-exit': 'the agent stopped before finishing', budget: 'the budget limit was reached', timeout: 'the time limit was reached',
    unknown: 'the reported blocker needs investigation', dependency: 'waiting for another task', checks: 'waiting for a check within its deadline',
    'repeated-failure': 'the same failure repeated three times without progress', 'no-visible-progress': `no completed action or code progress for ${alert.seconds} seconds`,
  };
  return `${alert.task}: ${alert.kind === 'possible-stall' ? 'possibly stuck' : alert.kind === 'waiting' ? 'waiting' : 'blocked'} — ${reasons[alert.reason]}.`;
}
