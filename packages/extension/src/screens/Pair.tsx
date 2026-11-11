import { useId, useState } from 'react';
import type { PanelState, UserAction } from '../state/reduce';
import { CommandBox } from './CommandBox';

export function Pair({ state, dispatch }: { state: Extract<PanelState, { kind: 'unpaired' }>; dispatch: (a: UserAction) => void }) {
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
      <p>In the airlock-reviews folder, run:</p>
      <CommandBox command="npm run service -- token" label="Command that prints the pairing token" />
      <form onSubmit={(e) => { e.preventDefault(); pair(); }}>
        <label htmlFor={id} className="label">Pairing token</label>
        <input id={id} className="input" type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} />
        <button type="submit" className="btn primary" disabled={token.trim() === ''}>Pair</button>
      </form>
      {state.message !== undefined && <p role="alert" className="notice">{state.message}</p>}
    </section>
  );
}
