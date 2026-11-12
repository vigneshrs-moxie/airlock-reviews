// First, so zod is told before any schema is used.
import '../../src/zod-jitless';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, browserNotes, realServices, startRealPanel } from '../../src/panel/App';
import { browserSettings } from '../../src/state/settings';
import { startSize } from '../../src/state/size';
import { browserTab } from '../../src/state/tab';
import '../../src/screens/panel.css';

// One store, one tab watcher and one set of notes, so the panel, its jumps and its notes read the same tab.
const settings = browserSettings();
// The size is applied before the first paint, from the page's own copy; the store's value follows when it differs.
const size = startSize(settings);
const tab = browserTab();
const notes = browserNotes(settings, tab);
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App start={(onState) => startRealPanel(onState, { settings, tab, notes })} services={{ ...realServices(settings, tab, notes), size }} />
    </StrictMode>,
  );
}
