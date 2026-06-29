/** @module @category Audit */

export const MARMOT_AUDIT_SCHEMA_VERSION = "marmot-forensics-audit/v2";

export type AuditDataMode = "obfuscated_sensitive_data" | "full_data";

export type AuditEpochState =
  "stable" | "pending_publish" | "merging" | "recovering" | "unrecoverable";

export type AuditMessageArtifactKind =
  | "application_message"
  | "commit"
  | "proposal"
  | "welcome"
  | "group_info"
  | "unknown";

export type AuditTransportWireEnvelope = {
  transport?: string;
  delivery_plane?: string;
  wire_id?: string;
  wire_kind?: string;
  wire_pubkey_hex?: string;
  transport_group_id?: string;
  relay_url?: string;
  subscription_id?: string;
  nostr_event_id?: string;
  nostr_kind?: number;
  nostr_pubkey_hex?: string;
  gift_wrap_event_id?: string;
  welcome_event_id?: string;
  publish_result_id?: string;
};

export type AuditHumanActionContext = {
  action: string;
  origin: string;
  fields?: string[];
  component_ids?: number[];
  target_count?: number;
};

export type AuditTransportContext = {
  transport_source: string;
  delivery_plane?: string;
  relay_url?: string;
  subscription_id?: string;
  wire?: AuditTransportWireEnvelope;
};

export type AuditEngineContext = {
  ciphersuite?: number;
  max_past_epochs?: number;
  convergence_max_rewind_commits?: number;
  supported_app_component_count?: number;
  feature_count?: number;
};

export type AuditGroupContext = {
  epoch?: number;
  member_count?: number;
  required_app_component_count?: number;
  admin_count?: number;
  convergence_max_rewind_commits?: number;
};

export type AuditConvergenceContext = {
  run_id: string;
  phase?:
    | "started"
    | "waiting"
    | "evaluating"
    | "selected"
    | "blocked"
    | "applied"
    | "failed"
    | "stable"
    | "unrecoverable";
  inferred?: boolean;
};

export type AuditSourceContext = {
  account_label?: string;
  device_label?: string;
  device_id?: string;
  device_name?: string;
  platform?: string;
  app_version?: string;
  upload_trigger?: string;
  account_pubkey_hex?: string;
  account_npub?: string;
};

export type AuditEventContext = {
  operation_id?: string;
  human_action?: AuditHumanActionContext;
  transport?: AuditTransportContext;
  engine?: AuditEngineContext;
  group?: AuditGroupContext;
  convergence?: AuditConvergenceContext;
  source?: AuditSourceContext;
};

export type AuditBaseEvent = {
  schema_version: typeof MARMOT_AUDIT_SCHEMA_VERSION;
  seq: number;
  wall_time_ms: number;
  recorder_session_id?: string;
  audit_data_mode: AuditDataMode;
  account_ref?: string;
  engine_id: string;
  group_ref?: string;
  context?: AuditEventContext;
};

export type AuditPublishRelayFailure = {
  relay_url: string;
  reason: string;
};

export type AuditOutboundMessage = {
  msg_id: string;
  artifact_kind: AuditMessageArtifactKind;
  transport?: AuditTransportWireEnvelope;
};

export type AuditConvergenceCandidate = {
  branch_id: string;
  fork_epoch: number;
  tip_epoch: number;
  commit_ids?: string[];
  commit_count?: number;
  state_digest?: string;
  tip_digest?: string;
  tip_priority?: string;
  tip_committer_ref?: string;
  retained_anchor_status?: string;
  last_input_time_ms?: number;
  eligible?: boolean;
  rejection_reasons?: string[];
};

export type AuditEventKind =
  | { type: "recorder_started"; recorder: string }
  | {
      type: "audit_data_mode_changed";
      previous_mode: AuditDataMode;
      new_mode: AuditDataMode;
      reason: string;
      recorder_restarted?: boolean;
    }
  | { type: "source_context"; source: AuditSourceContext }
  | { type: "engine_context"; context: AuditEngineContext }
  | { type: "group_context"; reason: string; context: AuditGroupContext }
  | {
      type: "recorder_health";
      serialization_failures: number;
      write_failures: number;
      flush_failures: number;
    }
  | {
      type: "human_action";
      action: string;
      origin: string;
      phase: string;
      fields?: string[];
      component_ids?: number[];
      target_count?: number;
      message_ids?: string[];
      from_epoch?: number;
      to_epoch?: number;
      error_kind?: string;
      detail?: string;
    }
  | {
      type: "ingest_entry";
      msg_id: string;
      envelope_kind: string;
      transport_source: string;
      transport?: AuditTransportWireEnvelope;
      payload_len: number;
      payload_digest: string;
    }
  | {
      type: "ingest_outcome";
      msg_id: string;
      outcome_kind: string;
      stale_reason?: string;
      epoch?: number;
    }
  | {
      type: "ingest_error";
      msg_id: string;
      error_kind: string;
      detail?: string;
    }
  | { type: "send_entry"; intent_kind: string }
  | {
      type: "send_outcome";
      intent_kind: string;
      result_kind: string;
      outbound_messages?: AuditOutboundMessage[];
    }
  | {
      type: "send_error";
      intent_kind: string;
      error_kind: string;
      detail?: string;
    }
  | {
      type: "publish_attempt";
      msg_id: string;
      artifact_kind?: AuditMessageArtifactKind;
      target_kind: string;
      transport?: AuditTransportWireEnvelope;
      relay_urls?: string[];
      required_acks: number;
    }
  | {
      type: "publish_outcome";
      msg_id: string;
      artifact_kind?: AuditMessageArtifactKind;
      target_kind: string;
      transport?: AuditTransportWireEnvelope;
      accepted_relay_urls?: string[];
      failed_relays?: AuditPublishRelayFailure[];
      required_acks: number;
      met_required_acks: boolean;
    }
  | {
      type: "publish_failure";
      msg_id: string;
      artifact_kind?: AuditMessageArtifactKind;
      stage: string;
      target_kind: string;
      transport?: AuditTransportWireEnvelope;
      relay_urls?: string[];
      reason: string;
    }
  | {
      type: "epoch_confirmed";
      from_epoch: number;
      to_epoch: number;
      pending_kind: string;
      origin_commit_id?: string;
    }
  | {
      type: "epoch_rolled_back";
      pending_epoch: number;
      restored_epoch: number;
      pending_kind: string;
    }
  | {
      type: "epoch_state_changed";
      previous_state?: AuditEpochState;
      new_state: AuditEpochState;
      epoch: number;
      reason: string;
      pending_ref?: number;
      pending_kind?: string;
    }
  | {
      type: "convergence_decision";
      current_tip_epoch: number;
      max_rewind_commits: number;
      candidates: AuditConvergenceCandidate[];
      selected_branch_id?: string;
      selected_fork_epoch?: number;
      selected_tip_epoch?: number;
      losing_branch_ids?: string[];
      error_kinds?: string[];
    }
  | {
      type: "peeler_outcome";
      msg_id: string;
      outcome:
        "success" | "decrypt_failed" | "stale_epoch" | "malformed" | "other";
      artifact_kind?: AuditMessageArtifactKind;
      fallback_snapshot_used: boolean;
      fallback_snapshot_name?: string;
      fallback_snapshot_source_epoch?: number;
      fallback_attempt_count?: number;
      error_kind?: string;
      detail?: string;
    }
  | {
      type: "message_state_changed";
      msg_id: string;
      artifact_kind?: AuditMessageArtifactKind;
      previous_state?: string;
      new_state: string;
      epoch?: number;
      reason: string;
    }
  | { type: "rejection"; msg_id: string; reason: string };

export type MarmotAuditEvent = AuditBaseEvent & { kind: AuditEventKind };

export interface AuditSink {
  record(event: MarmotAuditEvent): void;
}

export interface AuditRecorder extends AuditSink {
  flush(): Promise<void>;
  close(): Promise<void>;
}

export type AuditContextOptions = {
  engineId: string;
  accountRef?: string;
  recorderSessionId?: string;
  dataMode?: AuditDataMode;
  source?: AuditSourceContext;
  now?: () => number;
};

export type AuditEmitContext = {
  engineId: string;
  accountRef?: string;
  recorderSessionId?: string;
  dataMode: AuditDataMode;
  source?: AuditSourceContext;
  now: () => number;
};
