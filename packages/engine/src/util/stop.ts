/** What can deliver SIGINT and SIGTERM: the process itself, or a stand-in in tests. */
interface SignalSource {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

/**
 * A signal that is aborted on the first SIGINT or SIGTERM, so a command line can stop its review and let it dispose
 * its workspace. Both handlers are removed then, so a second Ctrl-C ends the process the usual way.
 */
export function abortOnExitSignals(source: SignalSource = process): AbortSignal {
  const controller = new AbortController();
  const stop = (): void => {
    source.removeListener('SIGINT', stop);
    source.removeListener('SIGTERM', stop);
    controller.abort();
  };
  source.once('SIGINT', stop);
  source.once('SIGTERM', stop);
  return controller.signal;
}
