import { logger } from './logger.js';

export function printLogo(): void {
  logger.banner(
    'CLAUDE-PROFILES',
    'Multi-account routing & fallback for Claude Code + Codex'
  );
}
