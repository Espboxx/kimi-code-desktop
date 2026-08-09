export interface ExperimentalFeatureCopy {
  readonly title: string;
  readonly description: string;
}

const FEATURE_COPY: Readonly<Record<string, ExperimentalFeatureCopy>> = {
  'secondary-model': {
    title: '子 Agent 次级模型',
    description: '让新建的子 Agent 默认使用单独配置的次级模型；高质量任务仍可显式使用主模型。',
  },
  team_collaboration: {
    title: '团队协作',
    description: '启用持久化团队频道以及非阻塞的 AgentSwarm 协作。',
  },
  'tool-select': {
    title: '按需工具选择',
    description: '按需加载 MCP 工具定义，减少顶层工具上下文占用；仅对支持动态工具的模型生效。',
  },
  persistence_minidb_readmodel: {
    title: 'Minidb 会话索引',
    description: '使用 Minidb 派生读模型加速会话索引和记录回放。',
  },
};

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  'master-env': '全局环境变量',
  env: '环境变量',
  config: '配置文件',
  default: '默认值',
};

export function localizeExperimentalFeature(id: string): ExperimentalFeatureCopy {
  return FEATURE_COPY[id] ?? {
    title: '未命名实验功能',
    description: '由当前运行时提供的实验功能。',
  };
}

export function experimentalFeatureSourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? '运行时';
}
