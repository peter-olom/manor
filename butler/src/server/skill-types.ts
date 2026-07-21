export type SkillEnvironmentId = "butler-pi" | "worker-pi";
export type SkillScope = "user" | "project";
export type SkillOrigin = "local" | "package" | "system";

export type SkillCapabilities = {
  read: boolean;
  edit: boolean;
  delete: boolean;
};

export type SkillCatalogItem = {
  id: string;
  environment: SkillEnvironmentId;
  name: string;
  description: string;
  scope: SkillScope;
  origin: SkillOrigin;
  mutable: boolean;
  invocation: string;
  capabilities: SkillCapabilities;
};

export type SkillEnvironmentView = {
  id: SkillEnvironmentId;
  label: string;
  harness: "pi";
  capabilities: {
    list: true;
    read: true;
    create: boolean;
    install: boolean;
    edit: boolean;
    delete: boolean;
    import: boolean;
    packageManagement: false;
  };
};

export type AgentSkillChangeInput =
  | {
      operation: "create";
      environment: SkillEnvironmentId;
      name: string;
      description: string;
      instructions: string;
      scope?: SkillScope;
      cwd?: string | null;
    }
  | {
      operation: "install";
      environment: SkillEnvironmentId;
      name?: string;
      content?: string;
      candidateArchiveBase64?: string;
      candidateEvidence?: string;
      workerVerificationGoal?: string;
      runtimeRequirements?: string[];
      source: string;
      scope?: SkillScope;
      cwd?: string | null;
    }
  | {
      operation: "update";
      environment: SkillEnvironmentId;
      id: string;
      content: string;
      reason: string;
      cwd?: string | null;
    }
  | {
      operation: "undo";
      resultId: string;
    };

export type AgentSkillChangeProposal = {
  id: string;
  operation: AgentSkillChangeInput["operation"];
  summary: string;
  environment: SkillEnvironmentId;
  skillName: string;
  scope: SkillScope;
  source: string | null;
  sourceVerification: "agent-reported" | "butler-prepared";
  description: string;
  target: string;
  footprint: string;
  conflict: string;
  verificationPlan: string;
  workerVerificationGoal: string | null;
  runtimeRequirements: string[];
  contentSha256: string;
  contentEvidence: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "rejected" | "applying" | "applied" | "failed";
  resultId: string | null;
  error: string | null;
};

export type AgentSkillChangeResult = {
  id: string;
  proposalId: string;
  operation: AgentSkillChangeInput["operation"];
  skill: SkillCatalogItem;
  appliedAt: number;
  verification: {
    catalogVisible: boolean;
    invocation: string;
    resourceReload: "scheduled" | "next-session";
    operability: "ready" | "verification-pending";
    verificationThreadId: string | null;
    goal: string | null;
    runtimeRequirements: string[];
  };
  undo: {
    available: boolean;
    resultId: string;
    instruction: string;
    preservedLocation: string | null;
  };
};
