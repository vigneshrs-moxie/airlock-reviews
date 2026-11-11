import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Panel } from '../../src/panel/Panel';

const root = document.getElementById('root');
if (root) createRoot(root).render(<StrictMode><Panel /></StrictMode>);
