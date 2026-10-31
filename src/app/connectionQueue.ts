/**
 * True for the statement that replaces the loaded table.
 * A temporary table and a view stay on the joining path.
 */
export function statementStartsTurn(sql: string): boolean {
  return /^\s*create\s+or\s+replace\s+table\b/i.test(sql);
}

interface Session {
  jobs: Array<() => Promise<void>>;
  accepting: boolean;
}

/**
 * One connection's statements, never overlapping. Statements a caller awaits
 * one after another join one session, so an engine call is not split by
 * another caller. A call that arrives while a statement is still running
 * waits for a later session.
 */
export function createConnectionQueue(): {
  schedule<T>(work: () => Promise<T>): Promise<T>;
  /** Runs after the current session and never joins it. */
  turn<T>(work: () => Promise<T>): Promise<T>;
} {
  let current: Session | null = null;
  let tail: Promise<void> = Promise.resolve();

  function schedule<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Resolve only after `accepting` is set, in this function. Resolving
      // inside `work` would run the caller's next statement before this
      // session could claim it.
      const launch = (session: Session) => async () => {
        session.accepting = false;
        try {
          const value = await work();
          session.accepting = true;
          resolve(value);
          await takeContinuations(session);
        } catch (error) {
          session.accepting = true;
          reject(error);
          await takeContinuations(session);
        } finally {
          session.accepting = false;
        }
      };
      if (current?.accepting) {
        current.jobs.push(launch(current));
        return;
      }
      const session: Session = { jobs: [], accepting: false };
      session.jobs.push(launch(session));
      enqueue(session);
    });
  }

  async function drain(session: Session): Promise<void> {
    current = session;
    try {
      while (session.jobs.length > 0) {
        const job = session.jobs.shift();
        if (!job) break;
        await job();
      }
    } finally {
      if (current === session) current = null;
    }
  }

  async function takeContinuations(session: Session): Promise<void> {
    for (let hop = 0; hop < 16; hop += 1) {
      const before = session.jobs.length;
      await Promise.resolve();
      if (session.jobs.length > before) return;
    }
  }

  function enqueue(session: Session): void {
    const run = tail.then(() => drain(session));
    tail = run.then(
      () => undefined,
      () => undefined,
    );
  }

  function turn<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const session: Session = { jobs: [], accepting: false };
      session.jobs.push(async () => {
        try {
          resolve(await work());
        } catch (error) {
          reject(error);
        }
      });
      enqueue(session);
    });
  }

  return { schedule, turn };
}
