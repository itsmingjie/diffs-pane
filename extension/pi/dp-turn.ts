/**
 * Pi extension: report agent turn lifecycle to diffs-pane.
 *
 * Maps one agent working burst (prompt → settled) to one dp turn:
 *   - `agent_start`   → `dp turn start`
 *   - `agent_settled` → `dp turn end`
 *
 * Install by copying (or symlinking) into `~/.pi/agent/extensions/` or a
 * project's `.pi/extensions/`. Requires `dp` on PATH. All failures are
 * silent: diff review is an aid, never a blocker for the agent.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  let turnCounter = 0;
  let activeTurnId: string | null = null;

  async function dpTurn(
    action: 'start' | 'end',
    turnId: string,
    ctx: { sessionManager: { getSessionId(): string }; cwd: string },
  ): Promise<void> {
    try {
      await pi.exec(
        'dp',
        [
          'turn',
          action,
          '--session',
          ctx.sessionManager.getSessionId(),
          '--turn',
          turnId,
          '--agent',
          'pi',
          '--root',
          ctx.cwd,
        ],
        { timeout: 15_000 },
      );
    } catch {
      // dp not installed or daemon unavailable; stay out of the way.
    }
  }

  pi.on('agent_start', async (_event, ctx) => {
    // Duplicate/nested starts are idempotent on the dp side; still avoid
    // re-sending for the same in-flight turn.
    if (activeTurnId !== null) return;
    activeTurnId = `${Date.now()}-${++turnCounter}`;
    await dpTurn('start', activeTurnId, ctx);
  });

  pi.on('agent_settled', async (_event, ctx) => {
    if (activeTurnId === null) return;
    const turnId = activeTurnId;
    activeTurnId = null;
    await dpTurn('end', turnId, ctx);
  });
}
