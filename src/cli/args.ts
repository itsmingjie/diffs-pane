export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

/**
 * Minimal flag parser supporting `--flag`, `--flag=value`, and
 * `--flag value` forms.
 */
export function parseArgs(argv: string[], valueFlags: Set<string>): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const name = arg.slice(2);
    if (valueFlags.has(name) && i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) {
      flags.set(name, argv[++i]!);
    } else {
      flags.set(name, true);
    }
  }
  return { positional, flags };
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}
