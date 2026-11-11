import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/panel/App';
import '../../src/screens/panel.css';

const root = document.getElementById('root');
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>);
