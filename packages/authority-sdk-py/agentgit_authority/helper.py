"""Helper question constants for the Python authority SDK."""

RUN_SUMMARY = "run_summary"
WHAT_HAPPENED = "what_happened"
SUMMARIZE_AFTER_BOUNDARY = "summarize_after_boundary"
STEP_DETAILS = "step_details"
EXPLAIN_POLICY_DECISION = "explain_policy_decision"
REVERSIBLE_STEPS = "reversible_steps"
WHY_BLOCKED = "why_blocked"
LIKELY_CAUSE = "likely_cause"
SUGGEST_LIKELY_CAUSE = "suggest_likely_cause"
WHAT_CHANGED_AFTER_STEP = "what_changed_after_step"
REVERT_IMPACT = "revert_impact"
PREVIEW_REVERT_LOSS = "preview_revert_loss"
WHAT_WOULD_I_LOSE_IF_I_REVERT_HERE = "what_would_i_lose_if_i_revert_here"
EXTERNAL_SIDE_EFFECTS = "external_side_effects"
IDENTIFY_EXTERNAL_EFFECTS = "identify_external_effects"
LIST_ACTIONS_TOUCHING_SCOPE = "list_actions_touching_scope"
COMPARE_STEPS = "compare_steps"

HELPER_QUESTION_TYPES = (
    RUN_SUMMARY,
    WHAT_HAPPENED,
    SUMMARIZE_AFTER_BOUNDARY,
    STEP_DETAILS,
    EXPLAIN_POLICY_DECISION,
    REVERSIBLE_STEPS,
    WHY_BLOCKED,
    LIKELY_CAUSE,
    SUGGEST_LIKELY_CAUSE,
    WHAT_CHANGED_AFTER_STEP,
    REVERT_IMPACT,
    PREVIEW_REVERT_LOSS,
    WHAT_WOULD_I_LOSE_IF_I_REVERT_HERE,
    EXTERNAL_SIDE_EFFECTS,
    IDENTIFY_EXTERNAL_EFFECTS,
    LIST_ACTIONS_TOUCHING_SCOPE,
    COMPARE_STEPS,
)
