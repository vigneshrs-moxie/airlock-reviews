import { wireNoteOpen } from '../src/background/note-open';
import { wirePanel } from '../src/background/wire';

export default defineBackground(() => {
  wirePanel(browser);
  wireNoteOpen(browser);
});
