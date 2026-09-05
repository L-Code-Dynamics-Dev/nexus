// AgentEvidence + ExecutorResult typy -- extrahováno z
// ~/omega-bridge/src/agent/delivery/AgentWorker.ts:7-14 a
// ~/omega-bridge/src/agent/omega/OmegaExecutor.ts (interface
// ExecutorResult). AgentWorker třída samotná (orchestruje skutečný
// OmegaExecutor.execute() na Windows agentovi) a OmegaExecutor.execute()
// implementace (dnes čistá simulace, viz MIGRATION_PLAN.md -- "reálné
// child_process.spawn na Windows agentovi je nová práce, ne migrace")
// NEJSOU sem zkopírovány -- jen typy potřebné pro Gate 5 validaci.

export interface ExecutorResult {
    pid: number;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    startTime: Date;
    endTime: Date;
    durationMs: number;
    logContent: string | null;
    error?: string;
}

export interface AgentEvidence {
    jobId: string;
    correlationId: string;
    agentId: string;
    payloadHashVerified: boolean;
    executorResult?: ExecutorResult;
    status: string;
    timestamp: Date;
}
