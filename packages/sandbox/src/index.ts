export * from './types';
export * from './errors';
export * from './readiness';
export { describeDockerFailure, DOCKER_OUT_OF_SPACE, LocalDockerProvider, runtimeFromEnv, type LocalDockerProviderOptions } from './docker/compose-provider';
export {
  findSandboxLeftovers,
  pruneSandboxLeftovers,
  type PruneOptions,
  type PruneResult,
  type SandboxLeftovers,
} from './docker/prune';
export { KubernetesProvider, type ImageLoader, type KubernetesProviderOptions } from './kubernetes/kubernetes-provider';
export { providerFromEnv } from './provider';
export { describeSnapshotEvent, SNAPSHOT_LABEL } from './docker/snapshots';
export { describeUsage, formatBytes } from './docker/usage';
export { classifyRole } from './service-role';
export { RELAY_PREFIX } from './docker/relay';
export { defaultDeployRoot, DeployError, DockerDeployer, type DeployerOptions, type DeployLog, type DeployResult, type DeployRunOptions, type DeployStage, type DeployStatus } from './docker/deploy';
export type { DeployHistoryEntry, DeployRelease, DeployState } from './docker/deploy-plan';
export { MIN_SECRET_LENGTH, parseDotenv, Redactor, resolveSecrets, SECRET_ENV_PREFIX, SecretError } from './secrets';
export {
  assertReadonlyDockerArgs,
  execReadonlyDocker,
  READONLY_DOCKER_SUBCOMMANDS,
  ReadonlyDockerViolation,
  spawnReadonlyDocker,
} from './docker/readonly-exec';
export {
  classifyOwnership,
  discoverUserContainers,
  matchesProjectRoot,
  mergeHostContainerStats,
  parseHostContainers,
  type ComposeProjectGroup,
  type ContainerOwner,
  type HostContainer,
  type HostContainerPort,
  type HostContainerWithStats,
} from './docker/host-containers';
export {
  classifyActuatorProbe,
  isForwarderProcess,
  matchDeclaredPorts,
  parseLsofListening,
  parsePsRow,
  parseSsListening,
  probeActuator,
  type ActuatorProbe,
  type ListeningProcess,
  type ProcessResourceUsage,
} from './docker/host-processes';
