import type { NostrEvent } from "applesauce-core/helpers/event";
import { useState } from "react";

import { useKeyboard } from "@opentui/react";

import type {
  InviteCandidate,
  InviteCandidates,
} from "../marmot/controller.js";
import { npubShort } from "../marmot/format.js";

function relativeTime(seconds: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

function candidateLabel(candidate: InviteCandidate): string {
  if (candidate.deviceId) return `device ${candidate.deviceId}`;
  if (candidate.refHex) return `ref ${candidate.refHex.slice(0, 12)}`;
  return candidate.id.slice(0, 12);
}

/**
 * Lists an invitee's published KeyPackages (newest first) and lets the admin
 * pick which device(s) to add. Space toggles a selection, `f` filters to only
 * KeyPackages that are invitable to the active group, Enter sends the invite(s).
 */
export function InviteModal(props: {
  data: InviteCandidates;
  onConfirm: (events: NostrEvent[]) => void;
  onCancel: () => void;
}) {
  const all = props.data.candidates;
  const [onlyInvitable, setOnlyInvitable] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [cursor, setCursor] = useState(0);

  const visible = onlyInvitable ? all.filter((c) => c.invitable) : all;
  const index = visible.length ? Math.min(cursor, visible.length - 1) : 0;

  useKeyboard((key) => {
    if (key.name === "escape") {
      props.onCancel();
      return;
    }
    if (key.name === "f") {
      setOnlyInvitable((value) => !value);
      setCursor(0);
      return;
    }
    if (key.name === "down" || key.name === "j") {
      setCursor((c) => Math.min(c + 1, Math.max(0, visible.length - 1)));
      return;
    }
    if (key.name === "up" || key.name === "k") {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.name === "space" || key.sequence === " ") {
      const candidate = visible[index];
      if (!candidate || !candidate.invitable) return;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(candidate.id)) next.delete(candidate.id);
        else next.add(candidate.id);
        return next;
      });
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      const events = all
        .filter((candidate) => selected.has(candidate.id))
        .map((candidate) => candidate.event);
      if (events.length) props.onConfirm(events);
      return;
    }
  });

  const selectedCount = selected.size;
  const hiddenCount = all.length - visible.length;

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={100}
      shouldFill={false}
      justifyContent="center"
      alignItems="center"
    >
      <box
        border
        borderColor="#FFD700"
        backgroundColor="#15151f"
        padding={1}
        width={84}
        flexDirection="column"
        title=" invite — choose key packages "
      >
        <text fg="#FFD700">
          {props.data.groupName}
          <span fg="#666"> ← {npubShort(props.data.pubkey)}</span>
        </text>
        <text fg="#888">
          {all.length} key package(s)
          {onlyInvitable && hiddenCount > 0
            ? ` · ${hiddenCount} hidden (not invitable)`
            : ""}
          {` · filter: ${onlyInvitable ? "only invitable" : "all"}`}
        </text>

        <box flexDirection="column" marginTop={1}>
          {visible.length === 0 ? (
            <text fg="#555">
              {onlyInvitable
                ? "no invitable key packages — press f to show all"
                : "no key packages found"}
            </text>
          ) : (
            visible.map((candidate, i) => {
              const active = i === index;
              const checked = selected.has(candidate.id);
              const base = candidate.invitable ? "#d7dde8" : "#7f6b6b";
              const fg = active ? "#0e0e16" : base;
              const status = candidate.invitable
                ? "invitable"
                : (candidate.reasons[0] ?? "not invitable");
              const statusFg = active
                ? "#0e0e16"
                : candidate.invitable
                  ? "#98C379"
                  : "#E5C07B";
              return (
                <text
                  key={candidate.id}
                  fg={fg}
                  bg={active ? "#FFD700" : undefined}
                >
                  {active ? "› " : "  "}
                  {candidate.invitable ? (checked ? "[x] " : "[ ] ") : "  -  "}
                  {candidateLabel(candidate)}
                  <span fg={active ? "#0e0e16" : "#666"}>
                    {"  "}
                    {relativeTime(candidate.createdAt)} ·{" "}
                    {candidate.cipherSuite}
                    {" · "}
                  </span>
                  <span fg={statusFg}>{status}</span>
                </text>
              );
            })
          )}
        </box>

        <text fg="#666">
          j/k: move · space: select · f: filter · enter: invite
          {selectedCount ? ` (${selectedCount})` : ""} · esc: cancel
        </text>
      </box>
    </box>
  );
}
