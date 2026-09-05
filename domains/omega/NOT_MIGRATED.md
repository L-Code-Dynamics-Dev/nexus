# Omega orchestrator a sync — vědomě nemigrováno pod Rule<>

## orchestrator/LCodePipelineOrchestrator.ts

Hlavní E2E pipeline orchestrátor (177 řádků) -- řetězí GATE 1 (CsvInputValidationGate,
I/O čte fs) -> parseRow -> GATE 2 (CsvParserGate2) -> OrderReconstructor.reconstruct
(NEPŘENESENO, viz commit b284c10 zdůvodnění -- mock placeholder pole) ->
GATE 3 (validateOrder) -> DecisionEngine.evaluate -> AccountingDocumentBuilder ->
OmegaAdapter.process (async) -> AgentWorker.processJob (async, skutečný I/O na
Windows agenta) -> GATE 5. Je to KONZUMENT všech dosud migrovaných Rules
(CsvParserGateRule, ValidationStageRules, DecisionRules, OmegaMapperRule,
OmegaValidationRules), ne něco k migraci samo -- stejná kategorie jako
ProcurementWorkflow a FiveStagePipeline dřív.

## sync/SyncJob.ts

Jen typy (JobState, SyncJob, SyncJobAnomaly) -- žádná logika. JobState už
použit jako referenční vzor v core/state-machine/StateMachine.ts testech
(Vzor 1: SyncJob/JobState). Nic dalšího k migraci.

## orchestrator/PipelineAuditRecord.ts

Jen typy (PipelineAuditRecord, StateTransition) -- žádná logika. Už použit
jako referenční vzor v core/audit/AuditRecord.ts (4-hash shape, state
history bridge). Nic dalšího k migraci.
