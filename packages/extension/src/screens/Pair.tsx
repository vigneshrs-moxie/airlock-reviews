import { useId, useState } from 'react';
import type { Timers } from '../client/timers';
import type { PanelState, UserAction } from '../state/reduce';
import { CommandBox } from './CommandBox';

/**
 * The token field is a plain text input masked by CSS, with no form and no name, so Chrome's password manager never
 * offers to save it (autocomplete="off" is ignored on password fields). Pair is a button; Enter presses it.
 */
export function Pair({ state, dispatch, timers }: { state: Extract<PanelState, { kind: 'unpaired' }>; dispatch: (a: UserAction) => void; timers?: Timers }) {
  const [token, setToken] = useState('');
  const id = useId();
  const pair = (): void => {
    const typed = token.trim();
    if (typed === '') return;
    dispatch({ type: 'pair', token: typed });
    setToken('');
  };
  return (
    <section className="card">
      <h2 className="title">Pair this panel with Airlock</h2>
      <CommandBox intro="In the airlock-reviews folder, run:" command="npm run service -- token" {...(timers ? { timers } : {})} />
      <label htmlFor={id} className="label">Pairing token</label>
      <input
        id={id} className="input masked" type="text" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
        data-1p-ignore="" data-lpignore="true" data-form-type="other"
        value={token} onChange={(e) => setToken(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); pair(); } }}
      />
      <button type="button" className="btn primary" disabled={token.trim() === ''} onClick={pair}>Pair</button>
      {state.message !== undefined && <p role="alert" className="notice">{state.message}</p>}
    </section>
  );
}
