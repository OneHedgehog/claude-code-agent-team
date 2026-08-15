import {
  createTarget,
  parseTargetSlug,
  TargetError,
  type TargetRepository,
} from "./config/target.js";

/**
 * The entry point the reviewer workflow invokes (FR-026, FR-027).
 *
 * Everything the run touches is resolved through `--target` and `--checkout`. There is no default
 * for either: a run that guessed its target from the working directory would review whatever
 * happened to be checked out, which is the failure the constitution's Scope clause exists to
 * prevent. A missing parameter stops the run.
 */

export class CliError extends Error {
  override readonly name = "CliError";
}

export interface CliArgs {
  readonly target: TargetRepository;
  readonly pullRequest: number;
}

const FLAGS = ["--target", "--checkout", "--pull-request"] as const;

type Flag = (typeof FLAGS)[number];

function isFlag(token: string): token is Flag {
  return (FLAGS as readonly string[]).includes(token);
}

/** Splits `--flag=value` and `--flag value` into one map, rejecting anything else. */
function collect(argv: readonly string[]): Map<Flag, string> {
  const values = new Map<Flag, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;

    if (!token.startsWith("--")) {
      throw new CliError(
        `unexpected argument ${JSON.stringify(token)}; expected one of ${FLAGS.join(", ")}`,
      );
    }

    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);

    if (!isFlag(name)) {
      throw new CliError(
        `unrecognized flag ${JSON.stringify(name)}; expected one of ${FLAGS.join(", ")}`,
      );
    }
    if (values.has(name)) {
      throw new CliError(`${name} was given more than once`);
    }

    if (equals !== -1) {
      values.set(name, token.slice(equals + 1));
      continue;
    }

    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliError(`${name} requires a value`);
    }

    values.set(name, value);
    i += 1;
  }

  return values;
}

function required(values: Map<Flag, string>, flag: Flag): string {
  const value = values.get(flag);

  if (value === undefined || value === "") {
    throw new CliError(
      `${flag} is required: the service resolves everything through it and never through the working directory (FR-027)`,
    );
  }

  return value;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const values = collect(argv);

  const slug = required(values, "--target");
  const checkoutPath = required(values, "--checkout");
  const rawNumber = required(values, "--pull-request");

  const pullRequest = Number(rawNumber);
  if (!Number.isInteger(pullRequest) || pullRequest < 1) {
    throw new CliError(
      `--pull-request must be a positive integer, received ${JSON.stringify(rawNumber)}`,
    );
  }

  let target: TargetRepository;
  try {
    const { owner, name } = parseTargetSlug(slug);
    target = createTarget({ owner, name, checkoutPath });
  } catch (error) {
    throw new CliError(error instanceof TargetError ? error.message : String(error));
  }

  return { target, pullRequest };
}
