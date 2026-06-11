"""Manager tool registry — Cola-for-Managers.

The company-side agent has its own tool catalog, distinct from the seller
agent's `agent/cola.py:make_cola_agent` toolbelt. Where the seller side
acts on a single workspace's CRM, the manager side reads across the whole
company's swarm of seller spaces.

MANAGER_TOOLS now carries the FULL chief-of-staff catalog — 15 tools across
five groups. The registry is NOT empty; the agent reads + writes across the
company through these.

Read tools (9):
  - team_health, seller_performance, read_seller_morning_story (team.py)
  - find_stuck_deals, find_unassigned_leads, find_breached_leads (pipeline.py)
  - commission_report (revenue.py)
  - audit_response_times, find_at_risk_agents (performance.py)

Write tools (6 — the "command your team" suite, every one audit-gated):
  - reassign_lead, flag_deal_for_manager_review (actions.py)
  - send_team_announcement (actions.py)
  - change_member_role, offboard_member (actions.py — both with confirmation gates)
  - set_routing_rule (actions.py)

Adding a new manager tool:
  1. Create or open `agent/tools/manager/<group>.py` and add a coroutine
     decorated with `@function_tool`. Its first line MUST be
     `require_manager_role(ctx)` (defense layer 3 — see `_guards.py`).
  2. Collect tools in a module-level list (e.g. `TEAM_TOOLS`).
  3. Import that list here and extend MANAGER_TOOLS with it.

The agent runtime (`agent/cola_manager.py:make_manager_agent`) reads
MANAGER_TOOLS at agent-build time, exactly mirroring how `agent/cola.py`
reads its own native tool imports for the seller agent.
"""

from __future__ import annotations

from .actions import WRITE_TOOLS
from .performance import PERFORMANCE_TOOLS
from .pipeline import PIPELINE_TOOLS
from .revenue import REVENUE_TOOLS
from .team import TEAM_TOOLS

# Each entry must be a callable decorated with `function_tool` from the
# OpenAI Agents SDK — same shape as `tools/contacts.py:find_contacts` et al
# on the seller side. See `agent/tools/manager/_guards.py` for the per-handler
# permission check every entry MUST wrap its handler body in.
MANAGER_TOOLS: list = []
MANAGER_TOOLS.extend(TEAM_TOOLS)
MANAGER_TOOLS.extend(PIPELINE_TOOLS)
MANAGER_TOOLS.extend(REVENUE_TOOLS)
MANAGER_TOOLS.extend(PERFORMANCE_TOOLS)
MANAGER_TOOLS.extend(WRITE_TOOLS)

__all__ = ["MANAGER_TOOLS"]
