import { wirePanel } from '../src/background/wire';

export default defineBackground(() => {
  wirePanel(browser);
});
