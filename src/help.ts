import type { Command } from 'commander';

export function commandHelp(command: Command, examples: string[], tips: string[] = []): Command {
  return command.addHelpText('after', `\nExamples:\n${examples.map((example) => `  ${example}`).join('\n')}\n${tips.length ? `\n${tips.join('\n')}\n` : ''}`);
}
