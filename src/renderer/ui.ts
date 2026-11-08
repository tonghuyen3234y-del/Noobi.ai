import type {
  AgentEventKind,
  PipelineStage,
  ProjectStatus,
  RuntimeStatus,
} from '../shared/contracts';

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  draft: '待启动',
  running: '制作中',
  waiting: '待继续',
  completed: '已完成',
  failed: '需处理',
  stopped: '已停止',
};

export const EVENT_KIND_LABELS: Record<AgentEventKind, string> = {
  user: '用户',
  lifecycle: '状态',
  assistant: 'Agent',
  thought: '思考',
  tool: '工具',
  file: '文件',
  plan: '计划',
  approval: '审批',
  error: '异常',
};

/**
 * Human label for the active runtime card.
 *
 * An API-key engine reports `type: 'api-key'` and has no email, so calling it a
 * Codex account would be a lie; only Codex gets the login wording.
 */
export function runtimeLabel(runtime: RuntimeStatus): string {
  const isApiKey = runtime.account?.type === 'api-key';
  const name = isApiKey ? 'Qwen（百炼）' : 'Codex';
  if (runtime.state === 'ready') {
    if (isApiKey) return `${name} 已就绪`;
    return runtime.account
      ? `${runtime.account.email ?? 'Codex 账号'} · 已就绪`
      : 'Codex 已就绪 · 未登录';
  }
  if (runtime.state === 'starting') return `${name} 正在启动`;
  if (runtime.state === 'error') return runtime.error ?? `${name} 启动失败`;
  return `${name} 尚未启动`;
}

export function stageProgress(stage: PipelineStage): number {
  const order: PipelineStage[] = [
    'brief',
    'scaffold',
    'gdd',
    'assets',
    'world',
    'code',
    'verify',
    'complete',
  ];
  return Math.max(0, order.indexOf(stage));
}

export function formatRelative(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '—';
  const delta = Math.max(0, Date.now() - time);
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}

export function toMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(
    /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,
    '',
  );
}
