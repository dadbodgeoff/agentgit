import { createHash } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import { URL } from "node:url";

import { AuthorityClient, AuthorityClientTransportError, AuthorityDaemonResponseError } from "@agentgit/authority-sdk";

type VisibilityScope = NonNullable<Parameters<AuthorityClient["queryTimeline"]>[1]>;
type HelperQuestionType = Parameters<AuthorityClient["queryHelper"]>[1];
type MaintenanceJobType = Parameters<AuthorityClient["runMaintenance"]>[0][number];

export interface InspectorServerOptions {
  socketPath?: string;
  title?: string;
}

const DEFAULT_PORT = Number(process.env.AGENTGIT_INSPECTOR_PORT ?? "4317");
const DEFAULT_HOST = process.env.AGENTGIT_INSPECTOR_HOST ?? "127.0.0.1";
const WS_POLL_INTERVAL_MS = 2_000;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const VISIBILITY_SCOPES = new Set<VisibilityScope>(["user", "model", "internal", "sensitive_internal"]);
const HELPER_QUESTION_TYPES = new Set<HelperQuestionType>([
  "run_summary",
  "what_happened",
  "summarize_after_boundary",
  "step_details",
  "explain_policy_decision",
  "reversible_steps",
  "why_blocked",
  "likely_cause",
  "suggest_likely_cause",
  "what_changed_after_step",
  "revert_impact",
  "preview_revert_loss",
  "what_would_i_lose_if_i_revert_here",
  "external_side_effects",
  "identify_external_effects",
  "list_actions_touching_scope",
  "compare_steps",
]);
const MAINTENANCE_JOB_TYPES = new Set<MaintenanceJobType>([
  "startup_reconcile_recoveries",
  "sqlite_wal_checkpoint",
  "projection_refresh",
  "projection_rebuild",
  "snapshot_gc",
  "snapshot_compaction",
  "snapshot_rebase_anchor",
  "artifact_expiry",
  "artifact_orphan_cleanup",
  "capability_refresh",
  "helper_fact_warm",
  "policy_threshold_calibration",
]);

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderInspectorHtml(title: string): string {
  const safeTitle = escapeHtml(title);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <style>
      :root {
        --paper: #f3ede2;
        --ink: #1c1917;
        --muted: #6a625b;
        --line: rgba(28, 25, 23, 0.14);
        --signal: #ae3f24;
        --signal-soft: rgba(174, 63, 36, 0.12);
        --good: #235441;
        --warn: #8a5e10;
        --bad: #8a2f1d;
        --panel: rgba(255, 252, 247, 0.78);
        --shadow: 0 20px 60px rgba(28, 25, 23, 0.08);
        --serif: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
        --mono: "SF Mono", "IBM Plex Mono", "Cascadia Code", ui-monospace, monospace;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        min-height: 100vh;
        color: var(--ink);
        background:
          radial-gradient(circle at top right, rgba(174, 63, 36, 0.08), transparent 28%),
          linear-gradient(180deg, #fbf7f0 0%, var(--paper) 45%, #ece5d8 100%);
        font-family: var(--serif);
      }

      .shell {
        max-width: 1500px;
        margin: 0 auto;
        padding: 28px 24px 48px;
      }

      .masthead {
        display: grid;
        grid-template-columns: minmax(0, 1.3fr) minmax(320px, 0.7fr);
        gap: 24px;
        padding-bottom: 24px;
        border-bottom: 1px solid var(--line);
      }

      .eyebrow, .kicker, .code {
        font-family: var(--mono);
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .eyebrow {
        font-size: 12px;
        color: var(--signal);
        margin-bottom: 10px;
      }

      h1 {
        margin: 0;
        font-size: clamp(2.4rem, 6vw, 5.4rem);
        line-height: 0.92;
        letter-spacing: -0.045em;
        max-width: 10ch;
      }

      .lede {
        margin: 18px 0 0;
        max-width: 52ch;
        font-size: 1.05rem;
        line-height: 1.6;
        color: var(--muted);
      }

      .signal-board {
        display: grid;
        gap: 12px;
        align-content: start;
      }

      .signal-strip {
        padding: 16px 18px;
        background: var(--panel);
        border: 1px solid var(--line);
        box-shadow: var(--shadow);
        backdrop-filter: blur(10px);
      }

      .signal-strip strong {
        display: block;
        font-family: var(--mono);
        font-size: 11px;
        letter-spacing: 0.09em;
        text-transform: uppercase;
        color: var(--muted);
        margin-bottom: 8px;
      }

      .signal-value {
        font-size: 1.75rem;
        line-height: 1;
      }

      .control-bar, .status-grid, .workspace-grid {
        display: grid;
        gap: 18px;
      }

      .control-bar {
        grid-template-columns: 1.4fr 180px 180px auto auto;
        align-items: end;
        padding: 24px 0 18px;
      }

      label {
        display: grid;
        gap: 8px;
        font-family: var(--mono);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }

      input, select, button {
        appearance: none;
        border-radius: 0;
        border: 1px solid var(--line);
        background: rgba(255, 252, 247, 0.92);
        color: var(--ink);
        font: inherit;
      }

      input, select {
        min-height: 48px;
        padding: 12px 14px;
        font-family: var(--mono);
        font-size: 0.95rem;
      }

      button {
        min-height: 48px;
        padding: 0 18px;
        font-family: var(--mono);
        font-size: 0.88rem;
        letter-spacing: 0.03em;
        cursor: pointer;
        transition: transform 160ms ease, background-color 160ms ease, border-color 160ms ease;
      }

      button:hover {
        transform: translateY(-1px);
        border-color: rgba(28, 25, 23, 0.36);
      }

      .primary-button {
        background: var(--ink);
        color: #f8f4ec;
      }

      .secondary-button {
        background: var(--signal-soft);
        color: var(--signal);
        border-color: rgba(174, 63, 36, 0.24);
      }

      .status-grid {
        grid-template-columns: repeat(4, minmax(0, 1fr));
        padding: 8px 0 24px;
      }

      .metric {
        padding: 16px 0;
        border-top: 1px solid var(--line);
      }

      .metric .kicker {
        font-size: 10px;
        color: var(--muted);
        margin-bottom: 10px;
      }

      .metric strong {
        font-size: 1.95rem;
        font-weight: 400;
      }

      .workspace-grid {
        grid-template-columns: minmax(360px, 420px) minmax(0, 1fr) minmax(320px, 380px);
        align-items: start;
      }

      .panel {
        min-height: 280px;
        padding: 18px 18px 20px;
        background: var(--panel);
        border: 1px solid var(--line);
        box-shadow: var(--shadow);
        backdrop-filter: blur(10px);
      }

      .panel h2 {
        margin: 0 0 14px;
        font-size: 1rem;
        letter-spacing: 0.02em;
      }

      .timeline-list, .helper-list, .warning-list, .meta-list {
        list-style: none;
        margin: 0;
        padding: 0;
      }

      .timeline-list {
        display: grid;
        gap: 10px;
        max-height: 78vh;
        overflow: auto;
        padding-right: 6px;
      }

      .timeline-item {
        padding: 14px 14px 16px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.48);
        cursor: pointer;
        transition: transform 150ms ease, border-color 150ms ease, background-color 150ms ease;
      }

      .timeline-item:hover {
        transform: translateX(2px);
        border-color: rgba(28, 25, 23, 0.28);
      }

      .timeline-item.active {
        border-color: rgba(174, 63, 36, 0.4);
        background: rgba(174, 63, 36, 0.08);
      }

      .timeline-seq {
        font-family: var(--mono);
        font-size: 11px;
        color: var(--muted);
        margin-bottom: 8px;
      }

      .timeline-title {
        margin: 0 0 6px;
        font-size: 1rem;
      }

      .timeline-summary {
        margin: 0;
        color: var(--muted);
        font-size: 0.94rem;
        line-height: 1.45;
      }

      .pill-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 10px;
      }

      .pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 9px;
        font-family: var(--mono);
        font-size: 10px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.58);
      }

      .pill.completed { color: var(--good); }
      .pill.partial, .pill.blocked, .pill.awaiting_approval { color: var(--warn); }
      .pill.failed, .pill.cancelled { color: var(--bad); }
      .pill.imported, .pill.observed, .pill.unknown { color: var(--signal); }

      .helper-list {
        display: grid;
        gap: 10px;
      }

      .helper-item {
        padding: 14px;
        border-top: 1px solid var(--line);
      }

      .helper-item:first-child {
        border-top: none;
        padding-top: 0;
      }

      .helper-item strong {
        display: block;
        font-family: var(--mono);
        font-size: 10px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
        margin-bottom: 8px;
      }

      .helper-item p, .detail-copy, .status-copy {
        margin: 0;
        line-height: 1.55;
        color: var(--muted);
      }

      .section-divider {
        margin: 18px 0;
        border: none;
        border-top: 1px solid var(--line);
      }

      .meta-list {
        display: grid;
        gap: 12px;
      }

      .meta-row {
        display: grid;
        grid-template-columns: 110px minmax(0, 1fr);
        gap: 14px;
        align-items: start;
      }

      .meta-row .kicker {
        color: var(--muted);
        font-size: 10px;
      }

      .code {
        font-size: 12px;
        line-height: 1.5;
        color: var(--ink);
        white-space: pre-wrap;
        word-break: break-word;
      }

      .warning-list {
        display: grid;
        gap: 10px;
      }

      .warning-item {
        padding: 12px 14px;
        border-left: 2px solid var(--signal);
        background: rgba(174, 63, 36, 0.08);
        color: var(--bad);
        line-height: 1.5;
      }

      .status-banner {
        margin: 0 0 16px;
        padding: 12px 14px;
        font-family: var(--mono);
        font-size: 0.85rem;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.64);
      }

      .status-banner.error {
        color: var(--bad);
        border-color: rgba(138, 47, 29, 0.24);
        background: rgba(138, 47, 29, 0.08);
      }

      .maintenance-row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 14px;
      }

      .empty-state {
        color: var(--muted);
        font-style: italic;
      }

      @media (max-width: 1100px) {
        .masthead,
        .workspace-grid,
        .status-grid,
        .control-bar {
          grid-template-columns: 1fr;
        }

        .timeline-list {
          max-height: none;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <section class="masthead">
        <div>
          <div class="eyebrow">AgentGit Local Inspector</div>
          <h1>Trust, evidence, and recovery in one room.</h1>
          <p class="lede">
            This cockpit reads the local authority daemon directly and makes degraded trust, missing evidence,
            review-only recovery, and approval pressure impossible to miss.
          </p>
        </div>
        <div class="signal-board">
          <div class="signal-strip">
            <strong>Mode</strong>
            <div class="signal-value">Local-first</div>
          </div>
          <div class="signal-strip">
            <strong>Lens</strong>
            <div class="signal-value">Operator truth</div>
          </div>
        </div>
      </section>

      <form id="run-form" class="control-bar">
        <label>
          Run Id
          <input id="run-id" name="runId" placeholder="run_..." autocomplete="off" />
        </label>
        <label>
          Visibility
          <select id="visibility-scope" name="visibilityScope">
            <option value="user">user</option>
            <option value="model">model</option>
            <option value="internal">internal</option>
            <option value="sensitive_internal">sensitive_internal</option>
          </select>
        </label>
        <label>
          Helper Lens
          <select id="helper-question" name="helperQuestion">
            <option value="run_summary">run_summary</option>
            <option value="suggest_likely_cause">suggest_likely_cause</option>
            <option value="why_blocked">why_blocked</option>
            <option value="identify_external_effects">identify_external_effects</option>
          </select>
        </label>
        <button class="primary-button" type="submit">Load Run</button>
        <button class="secondary-button" type="button" id="refresh-health">Refresh Health</button>
      </form>

      <div id="status-banner" class="status-banner">Loading diagnostics…</div>

      <section class="status-grid" aria-label="Health summary">
        <div class="metric">
          <div class="kicker">Daemon Health</div>
          <strong id="daemon-health">-</strong>
          <p class="status-copy" id="daemon-health-copy"></p>
        </div>
        <div class="metric">
          <div class="kicker">Capability Drift</div>
          <strong id="capability-health">-</strong>
          <p class="status-copy" id="capability-health-copy"></p>
        </div>
        <div class="metric">
          <div class="kicker">Storage Evidence</div>
          <strong id="storage-health">-</strong>
          <p class="status-copy" id="storage-health-copy"></p>
        </div>
        <div class="metric">
          <div class="kicker">Maintenance Backlog</div>
          <strong id="backlog-health">-</strong>
          <p class="status-copy" id="backlog-health-copy"></p>
        </div>
      </section>

      <section class="workspace-grid">
        <section class="panel" aria-labelledby="timeline-heading">
          <h2 id="timeline-heading">Timeline Rail</h2>
          <ul id="timeline-list" class="timeline-list">
            <li class="empty-state">Choose a run to load timeline evidence.</li>
          </ul>
        </section>

        <section class="panel" aria-labelledby="detail-heading">
          <h2 id="detail-heading">Focused Detail</h2>
          <div id="detail-body" class="detail-copy empty-state">Select a timeline step to inspect policy, evidence, and recovery context.</div>
          <hr class="section-divider" />
          <h2>Helper Lenses</h2>
          <ul id="helper-cards" class="helper-list">
            <li class="empty-state">Run-level helper answers will appear here.</li>
          </ul>
        </section>

        <section class="panel" aria-labelledby="health-heading">
          <h2 id="health-heading">Health + Controls</h2>
          <ul id="warnings" class="warning-list">
            <li class="empty-state">No diagnostics loaded yet.</li>
          </ul>
          <div class="maintenance-row">
            <button class="secondary-button" type="button" data-job="capability_refresh">Refresh Capabilities</button>
            <button class="secondary-button" type="button" data-job="helper_fact_warm">Warm Helper Facts</button>
            <button class="secondary-button" type="button" data-job="policy_threshold_calibration">Calibrate Thresholds</button>
          </div>
          <hr class="section-divider" />
          <h2>Selected Step Facts</h2>
          <ul id="detail-meta" class="meta-list">
            <li class="empty-state">No step selected.</li>
          </ul>
        </section>
      </section>
    </div>

    <script>
      const state = {
        runId: "",
        visibilityScope: "user",
        helperQuestion: "run_summary",
        timeline: [],
        selectedStepId: null
      };

      const el = {
        form: document.getElementById("run-form"),
        runId: document.getElementById("run-id"),
        visibilityScope: document.getElementById("visibility-scope"),
        helperQuestion: document.getElementById("helper-question"),
        statusBanner: document.getElementById("status-banner"),
        daemonHealth: document.getElementById("daemon-health"),
        daemonHealthCopy: document.getElementById("daemon-health-copy"),
        capabilityHealth: document.getElementById("capability-health"),
        capabilityHealthCopy: document.getElementById("capability-health-copy"),
        storageHealth: document.getElementById("storage-health"),
        storageHealthCopy: document.getElementById("storage-health-copy"),
        backlogHealth: document.getElementById("backlog-health"),
        backlogHealthCopy: document.getElementById("backlog-health-copy"),
        timelineList: document.getElementById("timeline-list"),
        detailBody: document.getElementById("detail-body"),
        detailMeta: document.getElementById("detail-meta"),
        helperCards: document.getElementById("helper-cards"),
        warnings: document.getElementById("warnings"),
        refreshHealth: document.getElementById("refresh-health")
      };
      const streamState = {
        socket: null,
        reconnectTimer: null,
        reconnectAttempt: 0,
        reconnectEnabled: true
      };

      async function fetchJson(url, options) {
        const response = await fetch(url, options);
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.message || "Inspector request failed");
        }
        return data;
      }

      function setBanner(message, isError) {
        el.statusBanner.textContent = message;
        el.statusBanner.className = isError ? "status-banner error" : "status-banner";
      }

      function setMetric(target, copyTarget, value, copy) {
        target.textContent = value;
        copyTarget.textContent = copy || "";
      }

      function escapeClientHtml(value) {
        return String(value == null ? "" : value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      function safeClassToken(value, fallback) {
        const token = String(value == null ? "" : value).toLowerCase().replace(/[^a-z0-9_-]/g, "");
        return token || fallback || "unknown";
      }

      function renderWarnings(items) {
        if (!items.length) {
          el.warnings.innerHTML = '<li class="empty-state">No active warnings.</li>';
          return;
        }

        el.warnings.innerHTML = items.map(function (item) {
          return '<li class="warning-item">' + escapeClientHtml(item) + '</li>';
        }).join("");
      }

      function pill(kind, label) {
        return '<span class="pill ' + safeClassToken(kind) + '">' + escapeClientHtml(label) + '</span>';
      }

      function renderTimeline() {
        if (!state.timeline.length) {
          el.timelineList.innerHTML = '<li class="empty-state">No timeline steps were returned for this run.</li>';
          return;
        }

        el.timelineList.innerHTML = state.timeline.map(function (step) {
          const active = state.selectedStepId === step.step_id ? " active" : "";
          const warnings = step.warnings && step.warnings.length ? step.warnings.length + " warning(s)" : "no warnings";
          const stepId = escapeClientHtml(step.step_id);
          return '' +
            '<li class="timeline-item' + active + '" data-step-id="' + stepId + '">' +
              '<div class="timeline-seq">step ' + escapeClientHtml(step.sequence) + '</div>' +
              '<h3 class="timeline-title">' + escapeClientHtml(step.title) + '</h3>' +
              '<p class="timeline-summary">' + escapeClientHtml(step.summary) + '</p>' +
              '<div class="pill-row">' +
                pill(step.status, step.status) +
                pill(step.provenance, step.provenance) +
                (step.decision ? pill(step.decision, step.decision) : "") +
                (step.reversibility_class ? pill("recovery", step.reversibility_class) : "") +
                pill("warnings", warnings) +
              '</div>' +
            '</li>';
        }).join("");

        Array.from(el.timelineList.querySelectorAll(".timeline-item")).forEach(function (node) {
          node.addEventListener("click", function () {
            state.selectedStepId = node.getAttribute("data-step-id");
            renderTimeline();
            loadSelectedStep();
          });
        });
      }

      function renderHelperCards(cards) {
        if (!cards.length) {
          el.helperCards.innerHTML = '<li class="empty-state">No helper cards are available for this run.</li>';
          return;
        }

        el.helperCards.innerHTML = cards.map(function (card) {
          const reason = card.primary_reason
            ? '<p class="code">reason: ' +
              escapeClientHtml(card.primary_reason.code) +
              ' :: ' +
              escapeClientHtml(card.primary_reason.message) +
              '</p>'
            : '';
          const uncertainty = card.uncertainty.length
            ? '<p class="code">uncertainty: ' +
              card.uncertainty.map(function (entry) {
                return escapeClientHtml(entry);
              }).join(' | ') +
              '</p>'
            : '';
          return '' +
            '<li class="helper-item">' +
              '<strong>' + escapeClientHtml(card.label) + ' · ' + Math.round(card.confidence * 100) + '% confidence</strong>' +
              '<p>' + escapeClientHtml(card.answer) + '</p>' +
              reason +
              uncertainty +
            '</li>';
        }).join("");
      }

      function renderDetailMeta(step, helperAnswers) {
        if (!step) {
          el.detailMeta.innerHTML = '<li class="empty-state">No step selected.</li>';
          return;
        }

        const rows = [
          ['step', step.step_id],
          ['type', step.step_type],
          ['status', step.status],
          ['provenance', step.provenance],
          ['decision', step.decision || 'none'],
          ['reason', step.primary_reason ? step.primary_reason.code + ' :: ' + step.primary_reason.message : 'none'],
          ['recovery', step.reversibility_class || 'none'],
          ['warnings', step.warnings && step.warnings.length ? step.warnings.join(' | ') : 'none'],
          ['target', step.related && step.related.target_locator ? step.related.target_locator : 'none']
        ];

        helperAnswers.forEach(function (entry) {
          rows.push([entry.label, entry.answer]);
        });

        el.detailMeta.innerHTML = rows.map(function (row) {
          return '' +
            '<li class="meta-row">' +
              '<div class="kicker">' + escapeClientHtml(row[0]) + '</div>' +
              '<div class="code">' + escapeClientHtml(row[1]) + '</div>' +
            '</li>';
        }).join("");
      }

      function applyOverview(overview) {
        const diagnostics = overview.diagnostics || {};
        const capabilities = overview.capabilities || {};
        const warnings = [];

        setMetric(
          el.daemonHealth,
          el.daemonHealthCopy,
          diagnostics.daemon_health ? diagnostics.daemon_health.status : 'unknown',
          diagnostics.daemon_health && diagnostics.daemon_health.primary_reason
            ? diagnostics.daemon_health.primary_reason.message
            : 'No daemon health reason recorded.'
        );
        setMetric(
          el.capabilityHealth,
          el.capabilityHealthCopy,
          diagnostics.capability_summary ? (diagnostics.capability_summary.is_stale ? 'stale' : 'fresh') : 'none',
          diagnostics.capability_summary
            ? diagnostics.capability_summary.degraded_capabilities + ' degraded, ' + diagnostics.capability_summary.unavailable_capabilities + ' unavailable'
            : 'No cached capability snapshot yet.'
        );
        setMetric(
          el.storageHealth,
          el.storageHealthCopy,
          diagnostics.storage_summary ? diagnostics.storage_summary.artifact_health.status : 'unknown',
          diagnostics.storage_summary
            ? diagnostics.storage_summary.artifact_health.total + ' artifact(s) tracked'
            : 'No storage summary returned.'
        );
        setMetric(
          el.backlogHealth,
          el.backlogHealthCopy,
          diagnostics.maintenance_backlog ? String(diagnostics.maintenance_backlog.pending_maintenance_jobs) : '-',
          diagnostics.maintenance_backlog
            ? diagnostics.maintenance_backlog.warnings.join(' | ') || 'No backlog warnings.'
            : 'No backlog summary returned.'
        );

        if (diagnostics.daemon_health && diagnostics.daemon_health.warnings) {
          warnings.push.apply(warnings, diagnostics.daemon_health.warnings);
        }
        if (diagnostics.storage_summary && diagnostics.storage_summary.warnings) {
          warnings.push.apply(warnings, diagnostics.storage_summary.warnings);
        }
        if (diagnostics.capability_summary && diagnostics.capability_summary.warnings) {
          warnings.push.apply(warnings, diagnostics.capability_summary.warnings);
        }
        if (capabilities.degraded_mode_warnings) {
          warnings.push.apply(warnings, capabilities.degraded_mode_warnings);
        }

        renderWarnings(warnings.slice(0, 8));
      }

      async function loadOverview() {
        const overview = await fetchJson('/api/overview');
        applyOverview(overview);
        setBanner('Diagnostics refreshed from the live daemon.', false);
      }

      function applyRunView(runId, view, keepSelection) {
        const previousSelection = keepSelection ? state.selectedStepId : null;
        state.runId = runId;
        state.timeline = view.timeline.steps;
        if (previousSelection && state.timeline.some(function (step) { return step.step_id === previousSelection; })) {
          state.selectedStepId = previousSelection;
        } else {
          state.selectedStepId = state.timeline.length ? state.timeline[0].step_id : null;
        }
        renderTimeline();
        renderHelperCards(view.helper_cards);
        return previousSelection !== state.selectedStepId;
      }

      async function loadRun(runId) {
        const view = await fetchJson('/api/run-view?run_id=' + encodeURIComponent(runId) + '&visibility_scope=' + encodeURIComponent(state.visibilityScope));
        applyRunView(runId, view, false);
        await loadSelectedStep();
        restartLiveStream();
        setBanner('Loaded run ' + runId + ' with ' + view.timeline.steps.length + ' projected step(s).', false);
      }

      function streamUrl() {
        const base = new URL('/ws', window.location.href);
        if (state.runId) {
          base.searchParams.set('run_id', state.runId);
        }
        base.searchParams.set('visibility_scope', state.visibilityScope);
        base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
        return base.toString();
      }

      function clearReconnectTimer() {
        if (streamState.reconnectTimer) {
          clearTimeout(streamState.reconnectTimer);
          streamState.reconnectTimer = null;
        }
      }

      function connectLiveStream() {
        clearReconnectTimer();
        const socket = new WebSocket(streamUrl());
        streamState.socket = socket;

        socket.addEventListener('open', function () {
          if (streamState.socket !== socket) {
            return;
          }
          streamState.reconnectAttempt = 0;
        });

        socket.addEventListener('message', function (event) {
          if (streamState.socket !== socket) {
            return;
          }
          let message;
          try {
            message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
          } catch {
            return;
          }

          if (message.type === 'overview' && message.payload) {
            applyOverview(message.payload);
            return;
          }

          if (message.type === 'run_view' && message.payload && typeof message.run_id === 'string') {
            const selectionChanged = applyRunView(message.run_id, message.payload, true);
            if (selectionChanged) {
              loadSelectedStep().catch(function (error) {
                setBanner(error.message || 'Failed to refresh selected step.', true);
              });
            }
            return;
          }

          if (message.type === 'error') {
            setBanner(message.message || 'Live inspector stream reported an error.', true);
          }
        });

        socket.addEventListener('close', function () {
          if (streamState.socket !== socket) {
            return;
          }
          streamState.socket = null;
          if (!streamState.reconnectEnabled) {
            return;
          }
          clearReconnectTimer();
          const delay = Math.min(8_000, 800 * Math.pow(2, streamState.reconnectAttempt));
          streamState.reconnectAttempt += 1;
          streamState.reconnectTimer = setTimeout(function () {
            connectLiveStream();
          }, delay);
        });

        socket.addEventListener('error', function () {
          if (streamState.socket !== socket) {
            return;
          }
          socket.close();
        });
      }

      function restartLiveStream() {
        streamState.reconnectEnabled = true;
        clearReconnectTimer();
        const existingSocket = streamState.socket;
        streamState.socket = null;
        if (existingSocket && (existingSocket.readyState === WebSocket.OPEN || existingSocket.readyState === WebSocket.CONNECTING)) {
          existingSocket.close();
        }
        connectLiveStream();
      }

      async function loadSelectedStep() {
        const step = state.timeline.find(function (candidate) {
          return candidate.step_id === state.selectedStepId;
        });

        if (!step) {
          el.detailBody.textContent = 'Select a timeline step to inspect policy, evidence, and recovery context.';
          renderDetailMeta(null, []);
          return;
        }

        const detail = await fetchJson(
          '/api/helper?run_id=' + encodeURIComponent(state.runId) +
          '&question_type=step_details' +
          '&focus_step_id=' + encodeURIComponent(step.step_id) +
          '&visibility_scope=' + encodeURIComponent(state.visibilityScope)
        );

        const extra = [];
        if (step.decision) {
          extra.push(await fetchJson(
            '/api/helper?run_id=' + encodeURIComponent(state.runId) +
            '&question_type=explain_policy_decision' +
            '&focus_step_id=' + encodeURIComponent(step.step_id) +
            '&visibility_scope=' + encodeURIComponent(state.visibilityScope)
          ));
        }

        el.detailBody.textContent = detail.answer;
        renderDetailMeta(step, extra.map(function (entry) {
          return { label: 'policy', answer: entry.answer };
        }));
      }

      async function runMaintenance(jobType) {
        const payload = {
          job_types: [jobType],
          scope: state.runId ? { run_id: state.runId } : undefined
        };
        const result = await fetchJson('/api/maintenance', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const firstJob = result.jobs[0];
        setBanner(jobType + ': ' + firstJob.status + ' — ' + firstJob.summary, false);
        await loadOverview();
        if (state.runId) {
          await loadRun(state.runId);
        }
      }

      el.form.addEventListener('submit', async function (event) {
        event.preventDefault();
        state.visibilityScope = el.visibilityScope.value;
        state.helperQuestion = el.helperQuestion.value;
        const runId = el.runId.value.trim();
        if (!runId) {
          setBanner('Provide a run id before loading run evidence.', true);
          return;
        }
        try {
          await loadRun(runId);
        } catch (error) {
          setBanner(error.message || 'Failed to load run evidence.', true);
        }
      });

      el.refreshHealth.addEventListener('click', async function () {
        try {
          await loadOverview();
        } catch (error) {
          setBanner(error.message || 'Failed to refresh diagnostics.', true);
        }
      });

      Array.from(document.querySelectorAll('[data-job]')).forEach(function (node) {
        node.addEventListener('click', async function () {
          try {
            await runMaintenance(node.getAttribute('data-job'));
          } catch (error) {
            setBanner(error.message || 'Maintenance request failed.', true);
          }
        });
      });

      window.addEventListener('beforeunload', function () {
        streamState.reconnectEnabled = false;
        clearReconnectTimer();
        if (streamState.socket) {
          streamState.socket.close();
          streamState.socket = null;
        }
      });

      (async function boot() {
        const params = new URLSearchParams(window.location.search);
        const runId = params.get('run_id');
        const visibilityScope = params.get('visibility_scope');
        if (visibilityScope && ['user','model','internal','sensitive_internal'].includes(visibilityScope)) {
          el.visibilityScope.value = visibilityScope;
          state.visibilityScope = visibilityScope;
        }
        if (runId) {
          el.runId.value = runId;
        }
        try {
          await loadOverview();
          if (runId) {
            await loadRun(runId);
          } else {
            restartLiveStream();
          }
        } catch (error) {
          setBanner(error.message || 'Failed to boot inspector.', true);
        }
      })();
    </script>
  </body>
</html>`;
}

function isVisibilityScope(value: string | null): value is VisibilityScope {
  return value !== null && VISIBILITY_SCOPES.has(value as VisibilityScope);
}

function isHelperQuestionType(value: string | null): value is HelperQuestionType {
  return value !== null && HELPER_QUESTION_TYPES.has(value as HelperQuestionType);
}

function isMaintenanceJobType(value: unknown): value is MaintenanceJobType {
  return typeof value === "string" && MAINTENANCE_JOB_TYPES.has(value as MaintenanceJobType);
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function html(response: ServerResponse, statusCode: number, body: string): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(body);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 512_000) {
        reject(new Error("Request body exceeded 512KB."));
        request.destroy();
      }
    });
    request.on("end", () => resolve(buffer));
    request.on("error", reject);
  });
}

async function withClient<T>(
  socketPath: string | undefined,
  operation: (client: AuthorityClient) => Promise<T>,
): Promise<T> {
  const client = new AuthorityClient(socketPath ? { socketPath, clientType: "sdk_ts", clientVersion: "0.1.0" } : {});
  return operation(client);
}

function handleInspectorError(response: ServerResponse, error: unknown): void {
  if (error instanceof AuthorityClientTransportError) {
    json(response, 502, {
      message: error.message,
      code: error.code,
      retryable: error.retryable,
      details: error.details ?? null,
    });
    return;
  }

  if (error instanceof AuthorityDaemonResponseError) {
    json(response, 502, {
      message: error.message,
      code: error.code,
      error_class: error.errorClass,
      retryable: error.retryable,
      details: error.details ?? null,
    });
    return;
  }

  json(response, 500, {
    message: error instanceof Error ? error.message : String(error),
  });
}

async function fetchInspectorOverview(socketPath: string | undefined) {
  return withClient(socketPath, async (client) => {
    const [diagnostics, capabilities] = await Promise.all([
      client.diagnostics([
        "daemon_health",
        "journal_health",
        "maintenance_backlog",
        "projection_lag",
        "storage_summary",
        "capability_summary",
      ]),
      client.getCapabilities(),
    ]);

    return {
      diagnostics,
      capabilities,
    };
  });
}

async function fetchInspectorRunView(
  socketPath: string | undefined,
  runId: string,
  visibilityScope: VisibilityScope | undefined,
) {
  return withClient(socketPath, async (client) => {
    const [run_summary, timeline, runSummaryHelper, causeHelper, blockedHelper, externalHelper, inbox, approvals] =
      await Promise.all([
        client.getRunSummary(runId),
        client.queryTimeline(runId, visibilityScope),
        client.queryHelper(runId, "run_summary", undefined, undefined, visibilityScope),
        client.queryHelper(runId, "suggest_likely_cause", undefined, undefined, visibilityScope),
        client.queryHelper(runId, "why_blocked", undefined, undefined, visibilityScope),
        client.queryHelper(runId, "identify_external_effects", undefined, undefined, visibilityScope),
        client.queryApprovalInbox({ run_id: runId }),
        client.listApprovals({ run_id: runId }),
      ]);

    return {
      run_summary,
      timeline,
      approval_inbox: inbox,
      approvals,
      helper_cards: [
        { label: "run_summary", ...runSummaryHelper },
        { label: "suggest_likely_cause", ...causeHelper },
        { label: "why_blocked", ...blockedHelper },
        { label: "identify_external_effects", ...externalHelper },
      ],
    };
  });
}

function websocketAcceptValue(key: string): string {
  return createHash("sha1").update(`${key}${WS_GUID}`, "utf8").digest("base64");
}

function encodeWebSocketTextFrame(payload: string): Buffer {
  const payloadBuffer = Buffer.from(payload, "utf8");
  const payloadLength = payloadBuffer.length;

  if (payloadLength < 126) {
    const header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = payloadLength;
    return Buffer.concat([header, payloadBuffer]);
  }

  if (payloadLength <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payloadLength, 2);
    return Buffer.concat([header, payloadBuffer]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payloadLength), 2);
  return Buffer.concat([header, payloadBuffer]);
}

function payloadDigest(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

interface InspectorWebSocketClientState {
  socket: net.Socket;
  runId: string | null;
  visibilityScope: VisibilityScope | undefined;
  interval: NodeJS.Timeout;
  inFlight: boolean;
  closed: boolean;
  lastOverviewDigest: string | null;
  lastRunViewDigest: string | null;
  lastErrorDigest: string | null;
}

export function createInspectorServer(options: InspectorServerOptions = {}): http.Server {
  const socketPath = options.socketPath ?? process.env.AGENTGIT_SOCKET_PATH;
  const title = options.title ?? "AgentGit Inspector";
  const wsClients = new Set<InspectorWebSocketClientState>();

  const server = http.createServer(async (request, response) => {
    try {
      if (!request.url) {
        json(response, 400, { message: "Missing request url." });
        return;
      }

      const url = new URL(request.url, "http://inspector.local");

      if (request.method === "GET" && url.pathname === "/") {
        html(response, 200, renderInspectorHtml(title));
        return;
      }

      if (request.method === "GET" && url.pathname === "/favicon.ico") {
        response.statusCode = 204;
        response.end();
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/overview") {
        const result = await fetchInspectorOverview(socketPath);
        json(response, 200, result);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/run-view") {
        const runId = url.searchParams.get("run_id");
        if (!runId) {
          json(response, 400, { message: "run_id is required." });
          return;
        }

        const visibilityScopeParam = url.searchParams.get("visibility_scope");
        const visibilityScope = isVisibilityScope(visibilityScopeParam) ? visibilityScopeParam : undefined;

        const result = await fetchInspectorRunView(socketPath, runId, visibilityScope);
        json(response, 200, result);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/helper") {
        const runId = url.searchParams.get("run_id");
        const questionType = url.searchParams.get("question_type");

        if (!runId) {
          json(response, 400, { message: "run_id is required." });
          return;
        }

        if (!isHelperQuestionType(questionType)) {
          json(response, 400, { message: "question_type is required and must be supported." });
          return;
        }

        const visibilityScopeParam = url.searchParams.get("visibility_scope");
        const visibilityScope = isVisibilityScope(visibilityScopeParam) ? visibilityScopeParam : undefined;
        const focusStepId = url.searchParams.get("focus_step_id") ?? undefined;
        const compareStepId = url.searchParams.get("compare_step_id") ?? undefined;
        const result = await withClient(socketPath, (client) =>
          client.queryHelper(runId, questionType, focusStepId, compareStepId, visibilityScope),
        );
        json(response, 200, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/maintenance") {
        const rawBody = await readBody(request);
        const body = rawBody.length > 0 ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
        const rawJobTypes = Array.isArray(body.job_types) ? body.job_types : [];
        const jobTypes = rawJobTypes.filter((value): value is MaintenanceJobType => isMaintenanceJobType(value));

        if (jobTypes.length === 0) {
          json(response, 400, { message: "At least one supported maintenance job is required." });
          return;
        }

        const scopeCandidate = body.scope;
        const scope =
          scopeCandidate && typeof scopeCandidate === "object"
            ? {
                workspace_root:
                  typeof (scopeCandidate as Record<string, unknown>).workspace_root === "string"
                    ? ((scopeCandidate as Record<string, unknown>).workspace_root as string)
                    : undefined,
                run_id:
                  typeof (scopeCandidate as Record<string, unknown>).run_id === "string"
                    ? ((scopeCandidate as Record<string, unknown>).run_id as string)
                    : undefined,
              }
            : undefined;

        const result = await withClient(socketPath, (client) =>
          client.runMaintenance(jobTypes, {
            priority_override: "interactive_support",
            ...(scope && (scope.workspace_root || scope.run_id) ? { scope } : {}),
          }),
        );
        json(response, 200, result);
        return;
      }

      json(response, 404, { message: "Not found." });
    } catch (error) {
      handleInspectorError(response, error);
    }
  });

  const closeWsClient = (client: InspectorWebSocketClientState): void => {
    if (client.closed) {
      return;
    }

    client.closed = true;
    clearInterval(client.interval);
    wsClients.delete(client);
    if (!client.socket.destroyed) {
      client.socket.destroy();
    }
  };

  const sendWsJson = (client: InspectorWebSocketClientState, payload: unknown): void => {
    if (client.closed) {
      return;
    }

    try {
      client.socket.write(encodeWebSocketTextFrame(JSON.stringify(payload)));
    } catch {
      closeWsClient(client);
    }
  };

  const publishWsSnapshot = async (client: InspectorWebSocketClientState): Promise<void> => {
    if (client.closed || client.inFlight) {
      return;
    }

    client.inFlight = true;
    try {
      const overview = await fetchInspectorOverview(socketPath);
      const overviewDigest = payloadDigest(overview);
      if (overviewDigest !== client.lastOverviewDigest) {
        client.lastOverviewDigest = overviewDigest;
        sendWsJson(client, {
          type: "overview",
          payload: overview,
          emitted_at: new Date().toISOString(),
        });
      }

      if (client.runId) {
        const runView = await fetchInspectorRunView(socketPath, client.runId, client.visibilityScope);
        const runViewDigest = payloadDigest(runView);
        if (runViewDigest !== client.lastRunViewDigest) {
          client.lastRunViewDigest = runViewDigest;
          sendWsJson(client, {
            type: "run_view",
            run_id: client.runId,
            visibility_scope: client.visibilityScope ?? null,
            payload: runView,
            emitted_at: new Date().toISOString(),
          });
        }
      }

      client.lastErrorDigest = null;
    } catch (error) {
      const errorPayload = {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        emitted_at: new Date().toISOString(),
      };
      const digest = payloadDigest(errorPayload);
      if (digest !== client.lastErrorDigest) {
        client.lastErrorDigest = digest;
        sendWsJson(client, errorPayload);
      }
    } finally {
      client.inFlight = false;
    }
  };

  const rejectUpgrade = (socket: net.Socket, statusLine: string, message: string): void => {
    if (socket.destroyed) {
      return;
    }

    const messageBytes = Buffer.byteLength(message, "utf8");
    socket.write(
      `HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${messageBytes}\r\n\r\n${message}`,
    );
    socket.destroy();
  };

  server.on("upgrade", (request, socket, head) => {
    try {
      if (!request.url) {
        rejectUpgrade(socket, "400 Bad Request", "Missing request url.");
        return;
      }

      const url = new URL(request.url, "http://inspector.local");
      if (url.pathname !== "/ws") {
        rejectUpgrade(socket, "404 Not Found", "Unknown websocket endpoint.");
        return;
      }

      const upgradeHeader = request.headers.upgrade;
      const connectionHeader = request.headers.connection;
      const keyHeader = request.headers["sec-websocket-key"];
      const versionHeader = request.headers["sec-websocket-version"];
      const key = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;
      const version = Array.isArray(versionHeader) ? versionHeader[0] : versionHeader;

      if (
        typeof upgradeHeader !== "string" ||
        upgradeHeader.toLowerCase() !== "websocket" ||
        typeof connectionHeader !== "string" ||
        !connectionHeader
          .toLowerCase()
          .split(",")
          .map((entry) => entry.trim())
          .includes("upgrade") ||
        typeof key !== "string" ||
        key.trim().length === 0 ||
        version !== "13"
      ) {
        rejectUpgrade(socket, "400 Bad Request", "Invalid websocket upgrade request.");
        return;
      }

      const runIdParam = url.searchParams.get("run_id");
      const runId = runIdParam && runIdParam.trim().length > 0 ? runIdParam.trim() : null;
      const visibilityScopeParam = url.searchParams.get("visibility_scope");
      const visibilityScope = isVisibilityScope(visibilityScopeParam) ? visibilityScopeParam : undefined;
      const accept = websocketAcceptValue(key.trim());

      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
          "\r\n",
        ].join("\r\n"),
      );

      if (head.length > 0) {
        socket.unshift(head);
      }
      socket.on("data", () => undefined);

      const interval = setInterval(() => {
        void publishWsSnapshot(clientState);
      }, WS_POLL_INTERVAL_MS);
      const clientState: InspectorWebSocketClientState = {
        socket,
        runId,
        visibilityScope,
        interval,
        inFlight: false,
        closed: false,
        lastOverviewDigest: null,
        lastRunViewDigest: null,
        lastErrorDigest: null,
      };
      wsClients.add(clientState);

      socket.on("error", () => {
        closeWsClient(clientState);
      });
      socket.on("close", () => {
        closeWsClient(clientState);
      });
      socket.on("end", () => {
        closeWsClient(clientState);
      });

      void publishWsSnapshot(clientState);
    } catch {
      rejectUpgrade(socket, "500 Internal Server Error", "Failed to establish websocket connection.");
    }
  });

  server.on("close", () => {
    for (const client of wsClients) {
      closeWsClient(client);
    }
  });

  return server;
}

export async function startInspectorServer(options: InspectorServerOptions = {}): Promise<http.Server> {
  const server = createInspectorServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  startInspectorServer()
    .then(() => {
      process.stdout.write(`agentgit inspector listening on http://${DEFAULT_HOST}:${DEFAULT_PORT}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exitCode = 1;
    });
}
