import { createContext, useContext } from 'react';

const Visible = createContext(true);

/** The panel's content is kept mounted but out of sight while Settings is open; it says so here. */
export const PanelVisible = Visible.Provider;

/** False while the screen is kept out of sight: nothing in it takes focus then, and a move that falls due waits. */
export const useVisible = (): boolean => useContext(Visible);
