import type { BotConfig, ProjectConfig } from '../domain/types.js';

export function taskPlatformEnabledFor(config: BotConfig, userId: string, project?: ProjectConfig): boolean {
  const rollout = config.taskPlatformRollout;
  return rollout.enabled
    && (rollout.enabledOwners.length === 0 || rollout.enabledOwners.includes(userId))
    && (!project || rollout.enabledProjects.length === 0 || rollout.enabledProjects.includes(project.id));
}

export function taskPlatformProjectEnabled(config: BotConfig, project: ProjectConfig): boolean {
  const rollout = config.taskPlatformRollout;
  return rollout.enabled && (rollout.enabledProjects.length === 0 || rollout.enabledProjects.includes(project.id));
}
